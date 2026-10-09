/**
 * terminal_status reporting, auto-discovery, and the ws-client wiring that
 * sends status and replays journaled sale results after every connect.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { WebSocketServer } from 'ws';
import { AgentConfig } from '../src/config';
import { startTerminalMonitor } from '../src/terminal-monitor';
import { discoverTerminal, subnetHosts } from '../src/terminal-discovery';
import { runExclusive } from '../src/terminal-queue';
import { startWsClient } from '../src/ws-client';
import { TerminalStatusMessage } from '../src/protocol/messages';
import { PoslinkMockHandle, startPoslinkMock } from './poslink-mock-server';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'pax-monitor-'));

/** A local port with nothing listening on it. */
async function deadPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

function baseConfig(devices: AgentConfig['devices']): AgentConfig {
  return { wss_url: 'ws://127.0.0.1:1/ws', token: 'pat_t', office_id: 'o', agent_id: 'a', devices };
}

describe('terminal monitor', () => {
  let mock: PoslinkMockHandle;
  beforeAll(async () => {
    mock = await startPoslinkMock({ serial: 'SN-A920-1' });
  });
  afterAll(() => mock.close());

  it('reports a reachable terminal and remembers its serial in config', async () => {
    const dir = tmp();
    const configPath = join(dir, 'config.json');
    const config = baseConfig([{ device_id: 'm1', ip: '127.0.0.1', port: mock.port }]);
    const sent: TerminalStatusMessage[] = [];
    const monitor = startTerminalMonitor({ config, configPath, send: (m) => sent.push(m) });

    await monitor.checkNow(true);
    await monitor.checkNow(); // unchanged → not sent again
    monitor.stop();

    expect(sent).toHaveLength(1);
    expect(sent[0].devices[0]).toMatchObject({ device_id: 'm1', reachable: true, serial: 'SN-A920-1', model: 'A920' });
    expect(JSON.parse(readFileSync(configPath, 'utf8')).devices[0].serial).toBe('SN-A920-1');
  });

  it('never probes a terminal that is busy with a command', async () => {
    const config = baseConfig([{ device_id: 'm2', ip: '127.0.0.1', port: mock.port }]);
    const before = mock.received.length;
    let release!: () => void;
    const busy = runExclusive('m2', () => new Promise<void>((r) => (release = r)));
    const monitor = startTerminalMonitor({ config, send: () => undefined });
    await monitor.checkNow(true);
    monitor.stop();
    release();
    await busy;
    expect(mock.received.length).toBe(before);
  });

  it('after two failed checks finds the terminal at its new IP and saves it', async () => {
    const dir = tmp();
    const configPath = join(dir, 'config.json');
    const config = baseConfig([{ device_id: 'm3', ip: '127.0.0.1', port: await deadPort(), serial: 'SN-A920-1' }]);
    const sent: TerminalStatusMessage[] = [];
    const discover = jest.fn(async () => ({ ip: '127.0.0.2', serial: 'SN-A920-1', model: 'A920' }));
    const monitor = startTerminalMonitor({ config, configPath, send: (m) => sent.push(m), discover });

    await monitor.checkNow();
    expect(discover).not.toHaveBeenCalled();
    expect(sent[0].devices[0].reachable).toBe(false);

    await monitor.checkNow();
    monitor.stop();
    expect(discover).toHaveBeenCalledTimes(1);
    expect(config.devices[0].ip).toBe('127.0.0.2');
    expect(sent[1].devices[0]).toMatchObject({ ip: '127.0.0.2', reachable: true, discovered: true });
    expect(JSON.parse(readFileSync(configPath, 'utf8')).devices[0].ip).toBe('127.0.0.2');
  });
});

describe('terminal monitor safety', () => {
  it('reports connection refusal separately from a connected response timeout', async () => {
    const sent: TerminalStatusMessage[] = [];
    const config = baseConfig([{ device_id: 'diagnostic', ip: '127.0.0.1', port: await deadPort() }]);
    const monitor = startTerminalMonitor({ config, send: m => sent.push(m) });
    await monitor.checkNow(true);
    monitor.stop();
    expect(sent[0].devices[0].diagnostics).toMatchObject({ transport_code: 'ECONNREFUSED', request_sent: false, elapsed_ms: expect.any(Number) });
  });

  it('never auto-switches when no serial is known', async () => {
    const config = baseConfig([{ device_id: 'm4', ip: '127.0.0.1', port: await deadPort() }]);
    const discover = jest.fn(async () => ({ ip: '127.0.0.2', serial: 'X', model: 'A920' }));
    const monitor = startTerminalMonitor({ config, send: () => undefined, discover });
    await monitor.checkNow();
    await monitor.checkNow();
    monitor.stop();
    expect(discover).not.toHaveBeenCalled();
    expect(config.devices[0].ip).toBe('127.0.0.1');
  });

  it('treats a different terminal at the configured IP as unreachable and looks for ours', async () => {
    const mock = await startPoslinkMock({ serial: 'SN-STRANGER' });
    const dir = tmp();
    const configPath = join(dir, 'config.json');
    const config = baseConfig([{ device_id: 'm5', ip: '127.0.0.1', port: mock.port, serial: 'SN-OURS' }]);
    const sent: TerminalStatusMessage[] = [];
    const discover = jest.fn(async () => null);
    const monitor = startTerminalMonitor({ config, configPath, send: (m) => sent.push(m), discover });
    await monitor.checkNow();
    await monitor.checkNow();
    monitor.stop();
    await mock.close();
    expect(sent[0].devices[0].reachable).toBe(false);
    expect(config.devices[0].serial).toBe('SN-OURS');
    expect(discover).toHaveBeenCalledWith(expect.objectContaining({ serial: 'SN-OURS' }), []);
  });

  it('does not write config after stop()', async () => {
    const mock = await startPoslinkMock({ serial: 'SN-LATE' });
    const dir = tmp();
    const configPath = join(dir, 'config.json');
    const config = baseConfig([{ device_id: 'm6', ip: '127.0.0.1', port: mock.port }]);
    const monitor = startTerminalMonitor({ config, configPath, send: () => undefined });
    const round = monitor.checkNow();
    monitor.stop();
    await round;
    await mock.close();
    expect(() => readFileSync(configPath)).toThrow();
  });
});

describe('discovery', () => {
  it('scans the own /24, clamps wide masks to /22 and skips its own address', () => {
    const iface = (address: string, netmask: string) => ({
      lan: [{ address, netmask, family: 'IPv4' as const, internal: false, mac: '', cidr: null }],
    });
    const hosts = subnetHosts(iface('192.168.1.37', '255.255.255.0'));
    expect(hosts).toHaveLength(253);
    expect(hosts).toContain('192.168.1.1');
    expect(hosts).not.toContain('192.168.1.37');
    expect(hosts).not.toContain('192.168.1.255');
    expect(subnetHosts(iface('10.0.5.9', '255.255.0.0'))).toHaveLength(1021);
    expect(subnetHosts(iface('10.0.5.9', '255.255.255.240'))).toHaveLength(253);
  });

  it('confirms with A00 and only ever accepts the known serial', async () => {
    const mock = await startPoslinkMock({ serial: 'SN-A920-1' });
    const dead = await deadPort();
    const started = Date.now();
    expect(await discoverTerminal({ hosts: ['127.0.0.1'], port: mock.port, serial: 'SN-A920-1' })).toEqual({
      ip: '127.0.0.1',
      serial: 'SN-A920-1',
      model: 'A920',
    });
    expect(await discoverTerminal({ hosts: ['127.0.0.1'], port: mock.port, serial: 'OTHER' })).toBeNull();
    expect(await discoverTerminal({ hosts: ['127.0.0.1'], port: mock.port, serial: 'SN-A920-1', exclude: ['127.0.0.1'] })).toBeNull();
    expect(await discoverTerminal({ hosts: ['127.0.0.1'], port: dead, serial: 'SN-A920-1' })).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
    await mock.close();
  });
});

describe('ws-client status and replay', () => {
  it('sends hello, terminal_status and unacked sale results on every connect until acked', async () => {
    const mock = await startPoslinkMock();
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((r) => wss.once('listening', r));
    const { port } = wss.address() as { port: number };

    const dir = tmp();
    const configPath = join(dir, 'config.json');
    writeFileSync(
      join(dir, 'sale-journal.json'),
      JSON.stringify({
        'ext-lost': { request_id: 'r-lost', result: { result_code: '000000' }, completed_at: new Date().toISOString() },
      }),
    );
    const config = baseConfig([{ device_id: 'w1', ip: '127.0.0.1', port: mock.port }]);
    config.wss_url = `ws://127.0.0.1:${port}/ws/pax-agent`;

    const connections: string[][] = [];
    wss.on('connection', (socket) => {
      const types: string[] = [];
      connections.push(types);
      socket.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        types.push(msg.type);
        if (msg.type === 'sale_result_replay') {
          expect(msg).toMatchObject({ external_id: 'ext-lost', request_id: 'r-lost' });
          socket.send(JSON.stringify({ type: 'replay_ack', external_id: msg.external_id }));
          setTimeout(() => socket.close(), 100); // force a reconnect
        }
      });
    });

    const client = startWsClient(config, 'test', { configPath });
    const waitFor = async (check: () => boolean): Promise<void> => {
      for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 50));
    };
    await waitFor(() => connections.length >= 2 && connections[1].includes('terminal_status'));
    client.stop();
    wss.close();
    await mock.close();

    expect(connections[0]).toEqual(expect.arrayContaining(['hello', 'terminal_status', 'sale_result_replay']));
    expect(connections[0][0]).toBe('hello');
    expect(connections[1]).toContain('hello');
    expect(connections[1]).not.toContain('sale_result_replay');
    const journal = JSON.parse(readFileSync(join(dir, 'sale-journal.json'), 'utf8'));
    expect(journal['ext-lost'].acked).toBe(true);
  }, 15_000);
});

describe('ws-client handover', () => {
  it('a sale finishing on a replaced client is replayed by the live one', async () => {
    const mock = await startPoslinkMock({ delayMs: 400 });
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((r) => wss.once('listening', r));
    const { port } = wss.address() as { port: number };
    const dir = tmp();
    const configPath = join(dir, 'config.json');
    const config = baseConfig([{ device_id: 'w2', ip: '127.0.0.1', port: mock.port }]);
    config.wss_url = `ws://127.0.0.1:${port}/ws/pax-agent`;

    const sockets: Array<{ types: string[]; replays: string[] }> = [];
    wss.on('connection', (socket) => {
      const seen = { types: [] as string[], replays: [] as string[] };
      sockets.push(seen);
      if (sockets.length === 1) {
        socket.send(JSON.stringify({
          type: 'request',
          id: 'r-handover',
          command: 'pax.sale',
          payload: { device_id: 'w2', amount_cents: 1000, external_id: 'ext-handover' },
        }));
      }
      socket.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        seen.types.push(msg.type);
        if (msg.type === 'sale_result_replay') seen.replays.push(msg.external_id);
      });
    });

    const waitFor = async (check: () => boolean): Promise<void> => {
      for (let i = 0; i < 60 && !check(); i++) await new Promise((r) => setTimeout(r, 50));
    };
    const first = startWsClient(config, 'test', { configPath });
    await waitFor(() => mock.received.length > 0); // sale is on the terminal
    first.stop(); // e.g. config saved in the web UI
    const second = startWsClient(config, 'test', { configPath });
    await waitFor(() => sockets.length >= 2 && sockets[1].replays.includes('ext-handover'));
    second.stop();
    wss.close();
    await mock.close();

    expect(sockets[0].types).not.toContain('response'); // old socket was closed
    expect(sockets[1].replays).toEqual(['ext-handover']);
  }, 10_000);
});

describe('ws-client replay pacing', () => {
  it('waits after open, sends at most 5 at a time, and never replays a delivered response', async () => {
    const mock = await startPoslinkMock();
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((r) => wss.once('listening', r));
    const { port } = wss.address() as { port: number };
    const dir = tmp();
    const now = new Date().toISOString();
    const journal: Record<string, unknown> = {};
    for (let i = 0; i < 12; i++) {
      journal[`ext-${i}`] = { request_id: `r-${i}`, result: { result_code: '000000' }, completed_at: now };
    }
    journal['ext-delivered'] = { request_id: 'r-d', result: { result_code: '000000' }, completed_at: now, delivered: true };
    writeFileSync(join(dir, 'sale-journal.json'), JSON.stringify(journal));
    const config = baseConfig([{ device_id: 'w3', ip: '127.0.0.1', port: mock.port }]);
    config.wss_url = `ws://127.0.0.1:${port}/ws/pax-agent`;

    let openedAt = 0;
    const frames: Array<{ type: string; at: number; id?: string }> = [];
    wss.on('connection', (socket) => {
      openedAt = Date.now();
      socket.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        frames.push({ type: msg.type, at: Date.now() - openedAt, id: msg.external_id });
      });
    });

    const client = startWsClient(config, 'test', { configPath: join(dir, 'config.json') });
    for (let i = 0; i < 120 && frames.filter((f) => f.type === 'sale_result_replay').length < 12; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    client.stop();
    wss.close();
    await mock.close();

    const replays = frames.filter((f) => f.type === 'sale_result_replay');
    expect(replays).toHaveLength(12);
    expect(replays.map((r) => r.id)).not.toContain('ext-delivered');
    // Nothing but hello (+ status) in the first ~2 s, when the gateway counts frames.
    expect(frames.filter((f) => f.at < 1_900).every((f) => f.type !== 'sale_result_replay')).toBe(true);
    // Batches of 5, a gap apart.
    const batches = [replays.slice(0, 5), replays.slice(5, 10), replays.slice(10)];
    expect(batches[1][0].at - batches[0][4].at).toBeGreaterThanOrEqual(900);
    expect(batches[2][0].at - batches[1][4].at).toBeGreaterThanOrEqual(900);
  }, 15_000);

  it('marks a sale answered on its own live socket as delivered, so it is not replayed', async () => {
    const mock = await startPoslinkMock();
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((r) => wss.once('listening', r));
    const { port } = wss.address() as { port: number };
    const dir = tmp();
    const config = baseConfig([{ device_id: 'w4', ip: '127.0.0.1', port: mock.port }]);
    config.wss_url = `ws://127.0.0.1:${port}/ws/pax-agent`;

    let responded = false;
    wss.on('connection', (socket) => {
      socket.send(JSON.stringify({
        type: 'request',
        id: 'r-live',
        command: 'pax.sale',
        payload: { device_id: 'w4', amount_cents: 500, external_id: 'ext-live' },
      }));
      socket.on('message', (raw) => {
        if (JSON.parse(raw.toString()).type === 'response') responded = true;
      });
    });
    const client = startWsClient(config, 'test', { configPath: join(dir, 'config.json') });
    for (let i = 0; i < 60 && !responded; i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 100));
    client.stop();
    wss.close();
    await mock.close();

    const saved = JSON.parse(readFileSync(join(dir, 'sale-journal.json'), 'utf8'));
    expect(saved['ext-live'].delivered).toBe(true);
  });
});
