/**
 * Loopback-only HTTP server (127.0.0.1) for the agent's web UI + REST API.
 *
 *   GET  /              → HTML config form (web-ui-html.ts)
 *   GET  /health        → JSON status (also served as /api/health for the UI)
 *   GET  /api/config    → current config, sanitized (token replaced with preview)
 *   POST /api/config    → validate + write + trigger ws-client restart
 *
 * Bound to 127.0.0.1 — never reachable from the salon LAN.
 */
import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { AgentConfig, defaultConfigPath, writeConfig } from './config';
import { getLogger } from './logger';
import { CONFIG_UI_HTML } from './web-ui-html';

const logger = getLogger();

export interface AgentState {
  /** Current effective config (null until user fills via UI). */
  config: AgentConfig | null;
  ws_connected: boolean;
  last_command_at: number | null;
  /** Pairing code to display when no config exists yet. */
  pairing_code: string | null;
  /** Called after a successful POST /api/config — orchestrator restarts ws-client. */
  onConfigChanged: (newConfig: AgentConfig) => void;
  /** Called by POST /api/forget-pairing — orchestrator deletes config + enters pairing. */
  onForgetPairing: () => void;
}

export function startWebServer(port: number, version: string, state: AgentState): Server {
  const server = createServer((req, res) => handle(req, res, version, state));
  server.listen(port, '127.0.0.1', () => {
    logger.info({ port }, 'web server listening on 127.0.0.1');
  });
  return server;
}

async function handle(req: IncomingMessage, res: ServerResponse, version: string, state: AgentState): Promise<void> {
  const url = req.url || '/';
  try {
    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
      return sendHtml(res, 200, CONFIG_UI_HTML);
    }
    if (req.method === 'GET' && (url === '/health' || url === '/api/health')) {
      return sendJson(res, 200, healthSnapshot(version, state));
    }
    if (req.method === 'GET' && url === '/api/config') {
      return sendJson(res, 200, sanitizedConfig(state.config));
    }
    if (req.method === 'POST' && url === '/api/config') {
      return handleSaveConfig(req, res, state);
    }
    if (req.method === 'POST' && url === '/api/forget-pairing') {
      // User asks to disconnect this agent and pair a new one. The orchestrator
      // wipes config and starts the pairing client; the next /health snapshot
      // exposes the new code.
      try { state.onForgetPairing(); } catch (e) {
        return sendJson(res, 500, { error: (e as Error).message });
      }
      return sendJson(res, 200, { ok: true });
    }
    sendJson(res, 404, { error: 'Not found' });
  } catch (e) {
    logger.warn({ err: (e as Error).message, url }, 'web server handler error');
    sendJson(res, 500, { error: (e as Error).message });
  }
}

function healthSnapshot(version: string, state: AgentState): object {
  const c = state.config;
  return {
    status: state.ws_connected ? 'ok' : (c ? 'degraded' : 'setup-required'),
    version,
    ws_connected: state.ws_connected,
    has_config: !!c,
    pairing_code: state.pairing_code,
    office_id: c?.office_id ?? null,
    agent_id: c?.agent_id ?? null,
    devices: c?.devices?.map((d) => ({
      device_id: d.device_id,
      ip: d.ip,
      port: d.port,
    })) ?? [],
    last_command_at: state.last_command_at,
    uptime_s: Math.floor(process.uptime()),
  };
}

function sanitizedConfig(c: AgentConfig | null): object {
  if (!c) {
    return { has_token: false, devices: [{ device_id: 'default', ip: '', port: 10009 }] };
  }
  return {
    wss_url: c.wss_url,
    office_id: c.office_id,
    agent_id: c.agent_id,
    has_token: !!c.token,
    token_preview: c.token ? `${c.token.slice(0, 6)}••••${c.token.slice(-4)}` : null,
    devices: c.devices,
  };
}

async function handleSaveConfig(req: IncomingMessage, res: ServerResponse, state: AgentState): Promise<void> {
  const body = await readBody(req, 64 * 1024);
  let payload: Partial<AgentConfig> & { token?: string };
  try {
    payload = JSON.parse(body);
  } catch {
    return sendJson(res, 400, { error: 'Invalid JSON' });
  }

  // Empty token → keep existing (allows updating other fields without re-pasting).
  const effectiveToken =
    payload.token && payload.token.length > 0 ? payload.token : state.config?.token;
  if (!effectiveToken) {
    return sendJson(res, 400, { error: 'Token is required for first-time setup' });
  }

  const newConfig: AgentConfig = {
    wss_url: payload.wss_url ?? '',
    token: effectiveToken,
    office_id: payload.office_id ?? '',
    agent_id: payload.agent_id ?? '',
    devices: payload.devices ?? [],
    health_port: state.config?.health_port,
  };

  try {
    writeConfig(newConfig, defaultConfigPath());
  } catch (e) {
    return sendJson(res, 400, { error: (e as Error).message });
  }

  state.config = newConfig;
  try {
    state.onConfigChanged(newConfig);
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'onConfigChanged threw');
  }
  return sendJson(res, 200, { ok: true });
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: object): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}
