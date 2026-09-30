/**
 * The agent's local page used to accept requests from any website open on
 * the salon PC. A page could POST a new wss_url with an empty token (which
 * kept the saved one) and receive the agent's real token on its own server.
 */
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { request } from 'http';
import { AddressInfo } from 'net';
import { Server } from 'http';
import { startWebServer, AgentState } from '../src/web-server';

process.env.PAX_AGENT_CONFIG = join(mkdtempSync(join(tmpdir(), 'pax-web-')), 'config.json');

const saved = {
  wss_url: 'wss://api.gonails.us/ws/pax-agent',
  token: 'pat_realtoken123456',
  office_id: '11111111-1111-1111-1111-111111111111',
  agent_id: '22222222-2222-2222-2222-222222222222',
  devices: [{ device_id: 'default', ip: '192.168.1.50', port: 10009 }],
};

function call(port: number, method: string, path: string, headers: Record<string, string>, body?: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('agent web server request checks', () => {
  let server: Server;
  let port: number;
  let state: AgentState;
  let host: string;

  beforeEach(async () => {
    state = {
      config: { ...saved, devices: [...saved.devices] },
      ws_connected: true,
      last_command_at: null,
      pairing_code: null,
      onConfigChanged: jest.fn(),
      onForgetPairing: jest.fn(),
    };
    server = startWebServer(0, 'test', state);
    await new Promise((r) => server.once('listening', r));
    port = (server.address() as AddressInfo).port;
    host = `127.0.0.1:${port}`;
  });

  afterEach(() => new Promise((r) => server.close(r)));

  const attack = JSON.stringify({ ...saved, wss_url: 'wss://evil.example/ws', token: '' });

  it('blocks another website posting a new server address', async () => {
    const res = await call(port, 'POST', '/api/config', {
      host,
      origin: 'https://evil.example',
      'content-type': 'text/plain',
    }, attack);
    expect(res.status).toBe(403);
    expect(state.config?.wss_url).toBe(saved.wss_url);
    expect(state.onConfigChanged).not.toHaveBeenCalled();
  });

  it('blocks a JSON post from another origin too', async () => {
    const res = await call(port, 'POST', '/api/config', {
      host,
      origin: 'https://evil.example',
      'content-type': 'application/json',
    }, attack);
    expect(res.status).toBe(403);
  });

  it('blocks DNS rebinding (foreign Host header), even for reads', async () => {
    const res = await call(port, 'GET', '/health', { host: `evil.example:${port}` });
    expect(res.status).toBe(403);
  });

  it('blocks a cross-site forget-pairing', async () => {
    const res = await call(port, 'POST', '/api/forget-pairing', {
      host,
      origin: 'https://evil.example',
      'content-type': 'text/plain',
    });
    expect(res.status).toBe(403);
    expect(state.onForgetPairing).not.toHaveBeenCalled();
  });

  it("won't carry the saved token to a new server, even from its own page", async () => {
    const res = await call(port, 'POST', '/api/config', {
      host,
      origin: `http://${host}`,
      'content-type': 'application/json',
    }, attack);
    expect(res.status).toBe(400);
    expect(state.config?.wss_url).toBe(saved.wss_url);
  });

  it('lets its own page change the terminal address and keeps the token', async () => {
    const body = JSON.stringify({ ...saved, token: '', devices: [{ device_id: 'default', ip: '192.168.68.63', port: 10009 }] });
    const res = await call(port, 'POST', '/api/config', {
      host,
      origin: `http://${host}`,
      'content-type': 'application/json',
    }, body);
    expect(res.status).toBe(200);
    expect(state.config?.token).toBe(saved.token);
    expect(state.config?.devices[0].ip).toBe('192.168.68.63');
  });

  it('still serves health to local tools with no Origin', async () => {
    const res = await call(port, 'GET', '/health', { host: `localhost:${port}` });
    expect(res.status).toBe(200);
  });
});
