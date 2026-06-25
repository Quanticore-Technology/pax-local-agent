/**
 * Pairing client — runs when the agent starts with no config.
 *
 * Flow:
 *   1. announce() against the cloud → receive { code, session_id, wss_url, expires_at }
 *   2. Display the code in our local web UI / in stdout for ops.
 *   3. poll() every PAIR_POLL_MS until the salon claims the code in the dashboard.
 *   4. On claim, the poll response includes { token, office_id, agent_id, wss_url }.
 *      Caller writes the resulting AgentConfig to disk and starts the ws-client.
 *
 * The bootstrap URL is taken from the BOOTSTRAP_URL env (set by the .pkg
 * postinstall) or from a hard-coded fallback baked into the build for the
 * salon's environment. Either form must point to the cloud backend over
 * HTTPS — never plaintext on the public internet.
 */
import { getLogger } from './logger';
import { AgentConfig, DeviceEntry } from './config';

const PAIR_POLL_MS = 2_000;

export interface PairingHandle {
  /** Latest active code (after announce); null until first announce succeeds. */
  getCode(): string | null;
  /** True if currently in the announce/poll loop. */
  isActive(): boolean;
  /** Stop the loop. Used on shutdown or when config arrives via another path
   *  (e.g. the user pasted values manually in the web UI). */
  stop(): void;
}

interface AnnounceResponse {
  code: string;
  session_id: string;
  expires_at: number;
  wss_url: string;
}

interface PollResponseClaimed {
  pending: false;
  config: {
    wss_url: string;
    office_id: string;
    agent_id: string;
    token: string;
  };
}

interface PollResponsePending {
  pending: true;
}

type PollResponse = PollResponseClaimed | PollResponsePending;

export interface PairingClientOptions {
  /**
   * Backend HTTPS base URL — e.g. "https://api.your-domain.com".
   * Trailing slashes are tolerated. We append /device-payments/agent/pair/...
   */
  bootstrap_url: string;
  /**
   * LAN device list carried over from a prior config. Set on re-pair so the
   * salon doesn't have to re-enter the PAX IP/port every time the agent
   * gets re-paired (token revoke, fresh install over existing setup, etc.).
   * When undefined, falls back to a clearly-bogus placeholder that the user
   * MUST edit in the web UI before sales can succeed.
   */
  previous_devices?: DeviceEntry[];
  /** Called once when the agent has been claimed and we have a config. */
  onClaimed: (config: AgentConfig) => void;
}

const logger = getLogger();

export function startPairingClient(opts: PairingClientOptions): PairingHandle {
  let stopped = false;
  let currentCode: string | null = null;
  let currentSessionId: string | null = null;
  const base = opts.bootstrap_url.replace(/\/+$/, '');

  const announceLoop = async (): Promise<void> => {
    while (!stopped) {
      try {
        const announced = await announce(base);
        currentCode = announced.code;
        currentSessionId = announced.session_id;
        logger.info(
          { code: announced.code, expires_in_s: Math.floor((announced.expires_at - Date.now()) / 1000) },
          'pairing announced — waiting for salon to enter code in dashboard',
        );
        // Print the code prominently for ops people watching the agent's console.
        process.stdout.write(`\n  → Pairing code:  ${announced.code}\n` +
                             `    Enter this code in the salon dashboard.\n\n`);

        const claimed = await pollUntilClaimed(base, announced);
        if (stopped) return;
        if (claimed) {
          // Re-pair (previous_devices set) → preserve the salon's PAX IP so
          // staff don't have to re-enter it every time the token rotates.
          // First-time pair → placeholder that staff MUST edit before sales.
          const devices = opts.previous_devices?.length
            ? opts.previous_devices
            : [{ device_id: 'default', ip: '192.168.1.200', port: 10009 }];
          logger.info(
            { code: announced.code, office_id: claimed.office_id, preserved_devices: !!opts.previous_devices?.length },
            'pairing claimed',
          );
          opts.onClaimed({
            wss_url: claimed.wss_url,
            token: claimed.token,
            office_id: claimed.office_id,
            agent_id: claimed.agent_id,
            devices,
          });
          return;
        }
        // poll loop returned null → code expired. Loop back to a fresh announce.
      } catch (e) {
        logger.warn({ err: (e as Error).message }, 'pairing announce/poll failed — retrying in 5 s');
        await sleep(5_000);
      }
    }
  };

  void announceLoop();

  return {
    getCode(): string | null {
      return currentCode;
    },
    isActive(): boolean {
      return !stopped;
    },
    stop(): void {
      stopped = true;
      currentCode = null;
      currentSessionId = null;
    },
  };
}

async function announce(base: string): Promise<AnnounceResponse> {
  const r = await fetch(`${base}/device-payments/agent/pair/announce`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  if (!r.ok) throw new Error(`announce http ${r.status}`);
  const body = await r.json() as { result?: AnnounceResponse } & AnnounceResponse;
  // The backend wraps responses in { status, message, result } via Responser
  // — accept both shapes.
  return body.result ?? body;
}

async function pollUntilClaimed(
  base: string,
  ann: AnnounceResponse,
): Promise<PollResponseClaimed['config'] | null> {
  while (Date.now() < ann.expires_at) {
    await sleep(PAIR_POLL_MS);
    try {
      const url = `${base}/device-payments/agent/pair/poll?code=${encodeURIComponent(ann.code)}&session_id=${encodeURIComponent(ann.session_id)}`;
      const r = await fetch(url);
      if (r.status === 410 || r.status === 404) {
        // Expired or removed — let the caller restart with a new announce.
        return null;
      }
      if (!r.ok) {
        logger.warn({ status: r.status, code: ann.code }, 'poll http error');
        continue;
      }
      const body = (await r.json()) as { result?: PollResponse } & PollResponse;
      const data = (body.result ?? body) as PollResponse;
      if (!data.pending) {
        return data.config;
      }
    } catch (e) {
      // Transient network error — keep polling.
      logger.debug({ err: (e as Error).message }, 'poll transient error');
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
