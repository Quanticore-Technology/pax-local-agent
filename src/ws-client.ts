import WebSocket from 'ws';
import type { AgentConfig } from './config';
import { dispatch, isSaleInFlight, isBatchInFlight } from './command-router';
import { getLogger, LogRateLimiter } from './logger';
import { BatchJournal } from './batch-journal';
import { JournalEntry, SaleJournal } from './sale-journal';
import { startTerminalMonitor } from './terminal-monitor';
import {
  HelloMessage,
  PROTOCOL_VERSION,
  ResponseMessage,
  SaleResultReplayMessage,
  ServerMessage,
} from './protocol/messages';

const logger = getLogger();
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const HEARTBEAT_PING_MS = 25_000;
const AUTH_FAIL_CLOSE_CODE = 4003;
// 3 consecutive auth-fail closes before triggering recovery — debounces a
// single transient backend hiccup, but covers an Owner pressing Revoke.
const AUTH_FAIL_THRESHOLD = 3;
// Replay pacing: the gateway drops a socket that sends >10 frames before its
// token check finishes.
const REPLAY_DELAY_MS = 2_000;
const REPLAY_BATCH = 5;
const REPLAY_GAP_MS = 1_000;

export interface WsClientHandle {
  /** Stop reconnecting and close the socket. */
  stop(): void;
  /** Whether the socket is currently OPEN. */
  isConnected(): boolean;
}

export interface WsClientOptions {
  /** Called when the server has rejected our token N times in a row. The
   *  orchestrator typically responds by deleting config + restarting pairing. */
  onAuthFail?: (consecutiveCount: number) => void;
  /** Config file in use: set_devices and discovery save to it, the sale journal lives next to it. */
  configPath?: string;
  /** Called whenever a command arrives (feeds last_command_at in /health). */
  onCommand?: () => void;
}

/** The client currently in charge; a replaced one hands late sale results to it. */
let liveClient: { replay(externalId: string): void; replayBatch(closeoutId: string): void } | null = null;

/**
 * Long-lived WSS client with exponential backoff + jittered reconnect.
 * Pushes log messages back to the gateway with rate limiting.
 */
export function startWsClient(
  config: AgentConfig,
  version: string,
  opts: WsClientOptions = {},
): WsClientHandle {
  let ws: WebSocket | null = null;
  let stopped = false;
  let reconnectAttempt = 0;
  let pingTimer: NodeJS.Timeout | null = null;
  let consecutiveAuthFails = 0;
  let authFailFired = false;
  /** Bumped on every open, to tell whether a request outlived its socket. */
  let connection = 0;
  const logLimiter = new LogRateLimiter(60);
  let batchJournal: BatchJournal | undefined;
  try { if (opts.configPath) batchJournal = BatchJournal.nextTo(opts.configPath, config); }
  catch (err) { logger.error({ err: (err as Error).message }, 'batch journal unavailable; batch commands will be refused'); }
  const journal = opts.configPath ? SaleJournal.nextTo(opts.configPath) : undefined;
  const monitor = startTerminalMonitor({
    config,
    configPath: opts.configPath,
    send: (msg) => sendIfOpen(JSON.stringify(msg)),
  });

  const sendReplay = (entry: { external_id: string } & JournalEntry): void => {
    const replay: SaleResultReplayMessage = {
      type: 'sale_result_replay',
      external_id: entry.external_id,
      request_id: entry.request_id,
      result: entry.result,
      completed_at: entry.completed_at,
    };
    sendIfOpen(JSON.stringify(replay));
  };

  /** Re-send one sale result right away (its socket is gone, or it finished on a replaced client). */
  const replayOne = (externalId: string): void => {
    const entry = journal?.unacked().find((e) => e.external_id === externalId);
    if (entry) sendReplay(entry);
  };

  /**
   * Re-send everything the API may have missed, paced: the gateway closes the
   * socket (1009) when more than 10 frames arrive before it has checked the
   * token, so wait a moment after open and send a few at a time. A sale still
   * running here is skipped: its normal response is on its way, and a replay
   * racing ahead of it would be booked as a late result.
   */
  const scheduleReplay = (conn: number): void => {
    const timer = setTimeout(async () => {
      for (const entry of batchJournal?.pending() ?? []) {
        if (stopped || conn !== connection || ws?.readyState !== WebSocket.OPEN) return;
        replayBatch(entry.closeout_id);
        await new Promise((r) => setTimeout(r, REPLAY_GAP_MS).unref?.());
      }
      const pending = (journal?.unacked() ?? []).filter((e) => !isSaleInFlight(e.external_id));
      for (let i = 0; i < pending.length; i += REPLAY_BATCH) {
        if (stopped || conn !== connection || ws?.readyState !== WebSocket.OPEN) return;
        pending.slice(i, i + REPLAY_BATCH).forEach(sendReplay);
        await new Promise((r) => setTimeout(r, REPLAY_GAP_MS).unref?.());
      }
    }, REPLAY_DELAY_MS);
    timer.unref?.();
  };

  const replayBatch = (closeoutId: string): void => {
    if (isBatchInFlight(config, closeoutId)) return;
    const entry = batchJournal?.get(closeoutId);
    if (entry && !entry.acked) {
      const { acked, ...message } = entry;
      sendIfOpen(JSON.stringify(message));
    }
  };
  // A socket write is not a durable receipt. Retry results until the API explicitly acks.
  const batchReplayTimer = setInterval(() => {
    if (!stopped) for (const entry of batchJournal?.pending() ?? []) replayBatch(entry.closeout_id);
  }, 30_000);
  batchReplayTimer.unref?.();
  const self = { replay: replayOne, replayBatch };
  liveClient = self;

  const connect = (): void => {
    if (stopped) return;
    const url = `${config.wss_url}?office_id=${encodeURIComponent(config.office_id)}&token=${encodeURIComponent(config.token)}`;
    logger.info({ url: scrubToken(url), attempt: reconnectAttempt + 1 }, 'ws connecting');

    ws = new WebSocket(url, { perMessageDeflate: false });

    ws.on('open', () => {
      reconnectAttempt = 0;
      connection++;
      const hello: HelloMessage = {
        type: 'hello',
        agent_id: config.agent_id,
        version,
        protocol_version: PROTOCOL_VERSION,
        devices: config.devices,
      };
      ws!.send(JSON.stringify(hello));
      logger.info('ws connected, hello sent');
      startHeartbeat();
      void monitor.checkNow(true);
      scheduleReplay(connection);
    });

    ws.on('message', (raw) => onMessage(raw.toString()));

    ws.on('close', (code, reason) => {
      logger.warn({ code, reason: reason.toString() }, 'ws closed');
      stopHeartbeat();
      ws = null;

      if (code === AUTH_FAIL_CLOSE_CODE) {
        consecutiveAuthFails++;
        if (consecutiveAuthFails >= AUTH_FAIL_THRESHOLD && !authFailFired) {
          authFailFired = true;
          logger.error(
            { count: consecutiveAuthFails },
            'token rejected repeatedly — likely revoked. Stopping reconnect, signalling recovery.',
          );
          stopped = true;
          opts.onAuthFail?.(consecutiveAuthFails);
          return;
        }
      } else {
        consecutiveAuthFails = 0;
      }

      scheduleReconnect();
    });

    ws.on('error', (err) => {
      logger.warn({ err: err.message }, 'ws error');
    });

    ws.on('pong', () => {
      // Native pong from server's ping; nothing to do — confirms liveness.
    });
  };

  const onMessage = async (raw: string): Promise<void> => {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      logger.warn({ raw: raw.slice(0, 200) }, 'received non-JSON frame');
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'heartbeat') return;
    if (msg.type === 'batch_replay_ack') {
      if (typeof msg.closeout_id !== 'string' || typeof msg.request_id !== 'string') return;
      try { batchJournal?.ack(msg.closeout_id, msg.request_id); }
      catch (err) { logger.error({ err: (err as Error).message }, 'batch ack persistence failed'); }
      return;
    }
    if (msg.type === 'replay_ack') {
      journal?.ack(msg.external_id);
      return;
    }
    if (msg.type !== 'request') {
      logger.warn({ type: (msg as { type?: string }).type }, 'unknown server message type');
      return;
    }
    if (!msg.payload || typeof msg.payload !== 'object' || typeof msg.id !== 'string') {
      sendIfOpen(JSON.stringify({ type: 'response', id: msg.id, success: false, error: { code: 'PROTOCOL_ERROR', message: 'Invalid request' } }));
      return;
    }
    opts.onCommand?.();
    const receivedOn = connection;
    const response: ResponseMessage = await dispatch(config, msg, { configPath: opts.configPath, journal, batchJournal });
    const externalId = (msg.payload as { external_id?: string }).external_id;
    const isSale = msg.command === 'pax.sale' && !!externalId;
    sendIfOpen(JSON.stringify(response), () => {
      // Written to the same socket the request came in on: the API has it.
      if (isSale && receivedOn === connection && liveClient === self) journal?.delivered(externalId!);
    });
    // The socket this sale came in on is gone, so the API has likely forgotten
    // the request id; the replay path is what it will apply. If this client
    // was replaced meanwhile (config saved in the web UI), the live one sends
    // it. (Offline right now: the journal replays on the next connect anyway.)
    if (isSale) {
      if (liveClient !== self) liveClient?.replay(externalId!);
      else if (receivedOn !== connection) replayOne(externalId!);
    }
    if (msg.command === 'pax.batch_close') {
      const id = (msg.payload as { closeout_id?: string }).closeout_id;
      if (id) {
        if (liveClient !== self) liveClient?.replayBatch(id);
        else replayBatch(id);
      }
    }
    if (msg.command === 'config.set_devices' && response.success) void monitor.checkNow(true);
    // Mirror non-success responses to the cloud log stream for ops visibility.
    if (!response.success && logLimiter.allow()) {
      sendIfOpen(JSON.stringify({
        type: 'log',
        level: 'warn',
        message: `cmd ${msg.command} failed: ${response.error.code} ${response.error.message}`,
        ts: Date.now(),
        context: { id: msg.id },
      }));
    }
  };

  const scheduleReconnect = (): void => {
    if (stopped) return;
    const exp = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** reconnectAttempt);
    const jitter = exp * (0.8 + Math.random() * 0.4);
    reconnectAttempt++;
    setTimeout(connect, jitter);
  };

  const startHeartbeat = (): void => {
    stopHeartbeat();
    pingTimer = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        try {
          ws.ping();
        } catch {
          // ignore — `close` handler will reconnect.
        }
      }
    }, HEARTBEAT_PING_MS);
  };

  const stopHeartbeat = (): void => {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  };

  /** `onSent` runs once the frame was written to the socket without error. */
  const sendIfOpen = (data: string, onSent?: () => void): void => {
    if (ws?.readyState === WebSocket.OPEN) {
      try {
        ws.send(data, (err) => {
          if (!err) onSent?.();
        });
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'ws send failed');
      }
    }
  };

  connect();

  return {
    stop(): void {
      stopped = true;
      stopHeartbeat();
      monitor.stop();
      clearInterval(batchReplayTimer);
      if (liveClient === self) liveClient = null;
      try {
        ws?.close(1000, 'agent shutdown');
      } catch {
        /* ignore */
      }
    },
    isConnected(): boolean {
      return ws?.readyState === WebSocket.OPEN;
    },
  };
}

function scrubToken(url: string): string {
  return url.replace(/token=[^&]+/, 'token=***');
}
