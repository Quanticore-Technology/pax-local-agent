import { mkdirSync, mkdtempSync, rmdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { WebSocketServer } from 'ws';
import { BatchJournal } from '../src/batch-journal';
import { sendCommand } from '../src/pax-client';
import { dispatch } from '../src/command-router';
import { AgentConfig } from '../src/config';
import { RequestMessage } from '../src/protocol/messages';
import { startWsClient } from '../src/ws-client';
import { buildMockResponse, startPoslinkMock } from './poslink-mock-server';

const temp = () => join(mkdtempSync(join(tmpdir(), 'batch-test-')), 'journal.json');
const config = (port: number): AgentConfig => ({ office_id: 'office', agent_id: 'agent', token: 'pat_test',
  wss_url: 'ws://localhost', devices: [{ device_id: 'device', ip: '127.0.0.1', port }] });
const batchReply = buildMockResponse(['0', 'B00', '1.28', '000000', 'OK']);
const request = (id = 'request'): RequestMessage => ({ type: 'request', id, command: 'pax.batch_close',
  payload: { device_id: 'device', closeout_id: 'closeout' } });

it('deduplicates simultaneous and restarted closeout requests, retaining until explicit ack', async () => {
  const mock = await startPoslinkMock({ delayMs: 30, override: { B00: batchReply } });
  try {
    const path = temp();
    const journal = new BatchJournal(path);
    const cfg = config(mock.port);
    const responses = await Promise.all([dispatch(cfg, request(), { batchJournal: journal }),
      dispatch(cfg, request('duplicate'), { batchJournal: journal })]);
    expect(responses.map(r => r.id)).toEqual(['request', 'duplicate']);
    expect(mock.received).toHaveLength(1);
    expect(responses[0].diagnostics).toMatchObject({ request_sent: true, connect_ms: expect.any(Number), response_ms: expect.any(Number) });
    const restored = new BatchJournal(path);
    expect(restored.pending()).toHaveLength(1);
    await dispatch(cfg, request('restart'), { batchJournal: restored });
    expect(mock.received).toHaveLength(1);
    restored.ack('closeout', 'wrong-request');
    expect(restored.pending()).toHaveLength(1);
    restored.ack('closeout', 'request');
    expect(new BatchJournal(path).pending()).toHaveLength(0);
    await dispatch(cfg, request('acked-retry'), { batchJournal: restored });
    expect(mock.received).toHaveLength(1);
  } finally { await mock.close(); }
});

it('never sends a command again after crashing with a persisted intent', async () => {
  const path = temp();
  new BatchJournal(path).begin('closeout', 'original', 'device');
  const reply = await dispatch(config(1), request(), { batchJournal: new BatchJournal(path) });
  expect(reply).toMatchObject({ success: false, error: { code: 'TERMINAL_NO_RESPONSE' } });
});

it('fails closed without a journal and rejects corrupt journals', async () => {
  expect(await dispatch(config(1), request())).toMatchObject({ success: false, error: { code: 'POSLINK_ERROR' } });
  const path = temp();
  writeFileSync(path, '{broken');
  expect(() => new BatchJournal(path)).toThrow();
});

it('isolates journals when the PC is re-paired to another office', () => {
  const path = temp();
  const first = BatchJournal.nextTo(path, config(1));
  first.begin('closeout', 'request', 'device');
  expect(BatchJournal.nextTo(path, { ...config(1), office_id: 'other' }).pending()).toEqual([]);
});

it('replays normal responses until ack and replays after agent restart without resending B00', async () => {
  const terminal = await startPoslinkMock({ override: { B00: batchReply } });
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>(r => server.on('listening', r));
  const cfg = { ...config(terminal.port), wss_url: `ws://127.0.0.1:${(server.address() as any).port}` };
  const path = temp();
  const realSetInterval = global.setInterval;
  let tickReplay = () => {};
  const intervalSpy = jest.spyOn(global, 'setInterval').mockImplementation(((fn: (...args: any[]) => void, ms: number, ...args: any[]) => {
    if (ms === 30_000) tickReplay = () => fn(...args);
    return realSetInterval(fn, ms, ...args);
  }) as typeof setInterval);
  let client: ReturnType<typeof startWsClient> | undefined;
  const replay = () => new Promise<any>(resolve => server.once('connection', socket => {
    socket.on('message', raw => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'hello') socket.send(JSON.stringify(request()));
      if (msg.type === 'batch_result_replay') resolve({ socket, msg });
    });
  }));
  try {
    const first = replay();
    client = startWsClient(cfg, 'test', { configPath: path });
    const result = await first;
    expect(result.msg).toMatchObject({ request_id: 'request', closeout_id: 'closeout', response: { success: true, result: { result_code: '000000' } } });
    expect(BatchJournal.nextTo(path, cfg).pending()).toHaveLength(1);
    const resent = new Promise<any>(resolve => result.socket.on('message', (raw: Buffer) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'batch_result_replay') resolve(msg);
    }));
    tickReplay();
    expect((await resent).request_id).toBe('request');
    client.stop();
    const second = replay();
    client = startWsClient(cfg, 'test', { configPath: path });
    const recovered = await second;
    recovered.socket.send(JSON.stringify({ type: 'batch_replay_ack', closeout_id: 'closeout', request_id: 'request' }));
    await new Promise(r => setTimeout(r, 30));
    expect(BatchJournal.nextTo(path, cfg).pending()).toHaveLength(0);
    expect(terminal.received.filter(r => r.command === 'B00')).toHaveLength(1);
  } finally {
    client?.stop();
    intervalSpy.mockRestore();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(r => server.close(() => r()));
    await terminal.close();
  }
}, 15_000);


it('keeps connection and timeout diagnostics without packet data', async () => {
  const mock = await startPoslinkMock({ delayMs: 150 });
  try {
    await expect(sendCommand({ ip: '127.0.0.1', port: mock.port, timeoutMs: 30 }, 'B00')).rejects.toMatchObject({
      code: 'ETIMEDOUT', requestSent: true, diagnostics: { connect_ms: expect.any(Number) },
    });
  } finally { await mock.close(); }
});


it.each([null, undefined, 'bad', [], {}])('refuses malformed batch payload %p without throwing', async payload => {
  await expect(dispatch(config(1), { ...request(), payload } as any)).resolves.toMatchObject({
    success: false, error: { code: 'PROTOCOL_ERROR' },
  });
});


it.each([null, false, 0, ''])('refuses present invalid closeout identity %p without legacy fallback', async closeout_id => {
  await expect(dispatch(config(1), { ...request(), payload: { device_id: 'device', closeout_id } } as any)).resolves.toMatchObject({
    success: false, error: { code: 'PROTOCOL_ERROR' },
  });
});


it.each([
  { acked: 'false' },
  { response: { type: 'response', id: 'wrong', success: false, error: { code: 'x', message: 'x' } } },
  { response: { type: 'response', id: 'original', success: true, result: {} } },
  { response: { type: 'response', id: 'original', success: false, error: {} } },
])('fails closed on corrupt structured journal entry %p', patch => {
  const path = temp();
  const journal = new BatchJournal(path);
  journal.begin('closeout', 'original', 'device');
  writeFileSync(path, JSON.stringify({ closeout: { ...journal.get('closeout'), ...patch } }));
  expect(() => new BatchJournal(path)).toThrow('Invalid batch journal entry');
});


it('does not replay an unsent intent after a failed disk write and allows a safe retry', async () => {
  const mock = await startPoslinkMock({ override: { B00: batchReply } });
  const path = temp();
  const journal = new BatchJournal(path);
  mkdirSync(`${path}.tmp`);
  try {
    expect(await dispatch(config(mock.port), request(), { batchJournal: journal })).toMatchObject({
      success: false, error: { code: 'POSLINK_ERROR' }, diagnostics: { request_sent: false },
    });
    expect(mock.received).toHaveLength(0);
    expect(journal.pending()).toEqual([]);
    expect(journal.get('closeout')).toBeUndefined();
    rmdirSync(`${path}.tmp`);
    expect(await dispatch(config(mock.port), request(), { batchJournal: journal })).toMatchObject({ success: true });
    expect(mock.received).toHaveLength(1);
    expect(new BatchJournal(path).pending()).toHaveLength(1);
  } finally { await mock.close(); }
});

it('retains received-response diagnostics when terminal packet parsing fails', async () => {
  const mock = await startPoslinkMock({ override: { B00: Buffer.from('malformed') } });
  try {
    expect(await dispatch(config(mock.port), request(), { batchJournal: new BatchJournal(temp()) })).toMatchObject({
      success: false,
      diagnostics: { request_sent: true, connect_ms: expect.any(Number), response_ms: expect.any(Number) },
    });
  } finally { await mock.close(); }
});
