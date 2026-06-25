import WebSocket from 'ws';
import type { AgentConfig } from './config';
import { dispatch } from './command-router';
import { getLogger, LogRateLimiter } from './logger';
import {
  AgentMessage,
  HelloMessage,
  PROTOCOL_VERSION,
  ResponseMessage,
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
}

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
  const logLimiter = new LogRateLimiter(60);

  const connect = (): void => {
    if (stopped) return;
    const url = `${config.wss_url}?office_id=${encodeURIComponent(config.office_id)}&token=${encodeURIComponent(config.token)}`;
    logger.info({ url: scrubToken(url), attempt: reconnectAttempt + 1 }, 'ws connecting');

    ws = new WebSocket(url, { perMessageDeflate: false });

    ws.on('open', () => {
      reconnectAttempt = 0;
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
    if (msg.type === 'heartbeat') return;
    if (msg.type !== 'request') {
      logger.warn({ type: (msg as { type?: string }).type }, 'unknown server message type');
      return;
    }
    const response: ResponseMessage = await dispatch(config, msg);
    sendIfOpen(JSON.stringify(response));
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

  const sendIfOpen = (data: string): void => {
    if (ws?.readyState === WebSocket.OPEN) {
      try {
        ws.send(data);
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
