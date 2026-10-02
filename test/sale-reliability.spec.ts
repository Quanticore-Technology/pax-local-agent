/**
 * One command at a time per terminal, a sale charged at most once per
 * external_id, results journaled to disk, unique ReferenceNumbers, receipts,
 * and config.set_devices — all against the POSLink mock.
 */
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { dispatch } from '../src/command-router';
import { AgentConfig } from '../src/config';
import { SaleJournal } from '../src/sale-journal';
import { runIfIdle } from '../src/terminal-queue';
import { toReferenceNumber } from '../src/poslink-credit-request';
import { buildReceipt } from '../src/commands/print-receipt';
import { COMMAND, PROTOCOL_VERSION } from '../src/poslink-protocol';
import { ERROR_CODES, PaxResult, RequestMessage, SalePayload, SetDevicesResult } from '../src/protocol/messages';
import { PoslinkMockHandle, buildMockResponse, startPoslinkMock } from './poslink-mock-server';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'pax-agent-'));

function configFor(mock: PoslinkMockHandle, deviceId: string): AgentConfig {
  return {
    wss_url: 'wss://localhost/ws/pax-agent',
    token: 'pat_test',
    office_id: 'office-1',
    agent_id: 'agent-1',
    devices: [{ device_id: deviceId, ip: '127.0.0.1', port: mock.port }],
  };
}

const sale = (id: string, deviceId: string, extra: Partial<SalePayload> = {}): RequestMessage => ({
  type: 'request',
  id,
  command: 'pax.sale',
  payload: { device_id: deviceId, amount_cents: 4000, external_id: `ext-${id}`, ...extra },
});

const trace = (fields: Array<string | string[]>): string[] => fields[5] as string[];

describe('terminal queue', () => {
  let mock: PoslinkMockHandle;
  beforeAll(async () => {
    mock = await startPoslinkMock({ delayMs: 80 });
  });
  afterAll(() => mock.close());

  it('never sends two commands to the same terminal at once', async () => {
    const config = configFor(mock, 'q1');
    const responses = await Promise.all([
      dispatch(config, sale('a', 'q1')),
      dispatch(config, { type: 'request', id: 'v', command: 'pax.void', payload: { device_id: 'q1', orig_ref_num: '1' } }),
      dispatch(config, { type: 'request', id: 't', command: 'pax.tip_adjust', payload: { device_id: 'q1', orig_ref_num: '1', tip_cents: 100 } }),
    ]);
    expect(responses.every((r) => r.success)).toBe(true);
    expect(mock.maxConcurrent).toBe(1);
    expect(mock.received).toHaveLength(3);
  });

  it('answers ping with DEVICE_BUSY instead of waiting behind a sale', async () => {
    const config = configFor(mock, 'q2');
    const running = dispatch(config, sale('c', 'q2'));
    const ping = await dispatch(config, { type: 'request', id: 'p', command: 'pax.ping', payload: { device_id: 'q2' } });
    expect(ping.success).toBe(false);
    if (!ping.success) expect(ping.error.code).toBe(ERROR_CODES.DEVICE_BUSY);
    expect((await running).success).toBe(true);
  });
});

describe('ping and the background check', () => {
  it('waits for a background check instead of answering DEVICE_BUSY', async () => {
    const mock = await startPoslinkMock();
    const config = configFor(mock, 'bg1');
    const check = runIfIdle('bg1', () => new Promise((r) => setTimeout(r, 300)));
    expect(check).not.toBeNull();
    const ping = await dispatch(config, { type: 'request', id: 'pbg', command: 'pax.ping', payload: { device_id: 'bg1' } });
    await mock.close();
    expect(ping.success).toBe(true);
  });
});

describe('sale idempotency and journal', () => {
  let mock: PoslinkMockHandle;
  beforeEach(async () => {
    mock = await startPoslinkMock({ delayMs: 50 });
  });
  afterEach(() => mock.close());

  it('joins a sale already in flight instead of charging twice', async () => {
    const config = configFor(mock, 'i1');
    const [first, second] = await Promise.all([
      dispatch(config, sale('dup', 'i1')),
      dispatch(config, { ...sale('dup', 'i1'), id: 'retry' }),
    ]);
    expect(first.success && second.success).toBe(true);
    expect(mock.received.filter((r) => r.command === COMMAND.DO_CREDIT)).toHaveLength(1);
  });

  it('returns the journaled approval without charging again, even after a restart', async () => {
    const dir = tmp();
    const config = configFor(mock, 'i2');
    const first = await dispatch(config, sale('once', 'i2'), { journal: SaleJournal.nextTo(join(dir, 'config.json')) });
    expect(first.success).toBe(true);

    // A fresh journal instance reads the file, as a restarted agent would.
    const journal = new SaleJournal(join(dir, 'sale-journal.json'));
    const again = await dispatch(config, { ...sale('once', 'i2'), id: 'later' }, { journal });
    expect(again).toEqual({ ...first, id: 'later' });
    expect(mock.received.filter((r) => r.command === COMMAND.DO_CREDIT)).toHaveLength(1);

    const file = join(dir, 'sale-journal.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8'))['ext-once'].request_id).toBe('once');
  });

  it('charges again after a decline, since nothing was taken', async () => {
    await mock.close();
    mock = await startPoslinkMock({
      override: { T00: buildMockResponse(['0', 'T00', PROTOCOL_VERSION, '000100', 'DECLINE']) },
    });
    const journal = SaleJournal.nextTo(join(tmp(), 'config.json'));
    const config = configFor(mock, 'i3');
    await dispatch(config, sale('dec', 'i3'), { journal });
    await dispatch(config, { ...sale('dec', 'i3'), id: 'dec2' }, { journal });
    expect(mock.received.filter((r) => r.command === COMMAND.DO_CREDIT)).toHaveLength(2);
  });

  it('replays until acked, then stops; prunes after 7 days', () => {
    const dir = tmp();
    const journal = SaleJournal.nextTo(join(dir, 'config.json'));
    const result = { result_code: '000000' } as PaxResult;
    journal.record('x1', 'r1', result);
    journal.record('x2', 'r2', result);
    journal.ack('x1');
    expect(journal.unacked().map((e) => e.external_id)).toEqual(['x2']);
    expect(journal.get('x1')).toBeDefined(); // kept for idempotency

    const file = join(dir, 'sale-journal.json');
    const old = JSON.parse(readFileSync(file, 'utf8'));
    old.x2.completed_at = new Date(Date.now() - 8 * 86_400_000).toISOString();
    writeFileSync(file, JSON.stringify(old));
    expect(new SaleJournal(file).get('x2')).toBeUndefined();
  });
});

describe('ReferenceNumber', () => {
  it('is derived from the id, at most 8 digits, never all zeros', () => {
    const a = toReferenceNumber('1f0c1e8a-3b5e-4c1a-9d7e-2a1b3c4d5e6f');
    expect(a).toMatch(/^[1-9]\d{0,7}$/);
    expect(toReferenceNumber('1f0c1e8a-3b5e-4c1a-9d7e-2a1b3c4d5e6f')).toBe(a);
    expect(toReferenceNumber('2f0c1e8a-3b5e-4c1a-9d7e-2a1b3c4d5e6f')).not.toBe(a);
    expect(toReferenceNumber('000000000000')).toBe('1');
  });

  it('is sent in the trace group instead of the constant "1"', async () => {
    const mock = await startPoslinkMock();
    const config = configFor(mock, 'r1');
    await dispatch(config, sale('ref', 'r1', { external_id: '1f0c1e8a-3b5e-4c1a-9d7e-2a1b3c4d5e6f' }));
    await dispatch(config, { type: 'request', id: '9b7d2c11-aaaa-4bbb-8ccc-123456789abc', command: 'pax.void', payload: { device_id: 'r1', orig_ref_num: '5' } });
    await mock.close();
    expect(trace(mock.received[0].fields)[0]).toBe(toReferenceNumber('1f0c1e8a-3b5e-4c1a-9d7e-2a1b3c4d5e6f'));
    expect(trace(mock.received[1].fields)[0]).toBe(toReferenceNumber('9b7d2c11-aaaa-4bbb-8ccc-123456789abc'));
  });
});

describe('receipts, card brand and EMV', () => {
  it('prints after an approval and fills card_brand/emv without the PAN', async () => {
    const mock = await startPoslinkMock();
    const res = await dispatch(configFor(mock, 'p1'), sale('print', 'p1', { print_receipt: true, receipt: { salon_name: 'Tiệm Nail Đẹp' } }));
    await mock.close();
    expect(res.success).toBe(true);
    const result = (res as { result: PaxResult }).result;
    expect(result.receipt_printed).toBe(true);
    expect(result.card_brand).toBe('Visa');
    expect(result.emv).toEqual({ AID: 'A0000000031010', APPLAB: 'VISA CREDIT', TC: '1A2B3C4D', TVR: '0000008000', TSI: 'E800', ENTRY_MODE: '4' });
    expect(JSON.stringify(result)).not.toContain('4111111111114242');

    const print = mock.received.find((r) => r.command === COMMAND.PRINT)!;
    const data = print.fields[3] as string;
    expect(print.fields[2]).toBe('');
    expect(data).toContain('Tiem Nail Dep');
    expect(data).toContain('APPROVED');
  });

  it('reports out of paper without failing the sale', async () => {
    const mock = await startPoslinkMock({
      override: { A60: buildMockResponse(['0', 'A60', PROTOCOL_VERSION, '100032', 'OUT OF PAPER']) },
    });
    const res = await dispatch(configFor(mock, 'p2'), sale('paper', 'p2', { print_receipt: true }));
    await mock.close();
    expect(res.success).toBe(true);
    const result = (res as { result: PaxResult }).result;
    expect(result.result_code).toBe('000000');
    expect(result.receipt_printed).toBe(false);
    expect(result.receipt_error).toBe('100032 OUT OF PAPER');
  });

  it('does not print unless asked', async () => {
    const mock = await startPoslinkMock();
    const res = await dispatch(configFor(mock, 'p3'), sale('noprint', 'p3'));
    await mock.close();
    expect((res as { result: PaxResult }).result.receipt_printed).toBeUndefined();
    expect(mock.received.some((r) => r.command === COMMAND.PRINT)).toBe(false);
  });

  it('lays out the receipt with amount, tip and total', () => {
    const text = buildReceipt(
      { device_id: 'd', amount_cents: 4000, external_id: 'e', receipt: { salon_name: 'Nails\\Co', lines: ['123 Main St'] } },
      { card_brand: 'Visa', last_four: '4242', auth_code: 'AB12', tip_amount_cents: 500 } as PaxResult,
      new Date(2026, 8, 30, 14, 5),
    );
    expect(text).toBe(
      [
        '\\C\\2NailsCo',
        '\\C\\1123 Main St',
        '\\C\\12026-09-30 14:05',
        '',
        '\\C\\3SALE',
        '\\LCard\\RVisa ****4242',
        '\\LAuth code\\RAB12',
        '\\LAmount\\R$40.00',
        '\\LTip\\R$5.00',
        '\\LTotal\\R$45.00',
        '',
        '\\C\\2APPROVED',
        '\\C\\1Customer copy',
      ].join('\n') + '\n',
    );
  });
});

describe('config.set_devices', () => {
  const setDevices = (devices: unknown): RequestMessage => ({
    type: 'request',
    id: 'sd',
    command: 'config.set_devices',
    payload: { devices } as never,
  });

  it('validates, saves (keeping token and extra fields) and applies at once', async () => {
    const mock = await startPoslinkMock();
    const dir = tmp();
    const configPath = join(dir, 'config.json');
    const config = configFor(mock, 'default');
    config.devices = [{ device_id: 'default', ip: '10.0.0.9', port: 10009, secondary_port: 10010, serial: 'SN1' }];

    const res = await dispatch(config, setDevices([{ device_id: 'default', ip: '127.0.0.1', port: mock.port }]), { configPath });
    expect(res.success).toBe(true);
    expect((res as { result: SetDevicesResult }).result).toEqual({
      devices: [{ device_id: 'default', ip: '127.0.0.1', port: mock.port }],
    });
    const saved = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(saved.token).toBe('pat_test');
    // New address, maybe a new terminal: the old serial is dropped.
    expect(saved.devices[0]).toEqual({ device_id: 'default', ip: '127.0.0.1', port: mock.port, secondary_port: 10010 });

    // The very next command goes to the new address.
    const ping = await dispatch(config, { type: 'request', id: 'pg', command: 'pax.ping', payload: {} });
    await mock.close();
    expect(ping.success).toBe(true);
  });

  it('keeps the serial when the address is unchanged', async () => {
    const config: AgentConfig = {
      wss_url: 'ws://x',
      token: 'pat_x',
      office_id: 'o',
      agent_id: 'a',
      devices: [{ device_id: 'a', ip: '192.168.1.2', port: 10009, serial: 'SN1' }],
    };
    await dispatch(config, setDevices([{ device_id: 'a', ip: '192.168.1.2', port: 10009 }]));
    expect(config.devices[0].serial).toBe('SN1');
  });

  it.each([
    [[]],
    [[{ device_id: 'a', ip: '999.1.1.1', port: 10009 }]],
    [[{ device_id: 'a', ip: '192.168.1.5', port: 0 }]],
    [[{ device_id: 'a', ip: 'pax.local', port: 10009 }]],
    [[{ device_id: 'a', ip: '192.168.1.5', port: 10009 }, { device_id: 'a', ip: '192.168.1.6', port: 10009 }]],
  ])('rejects %j', async (devices) => {
    const config: AgentConfig = {
      wss_url: 'ws://x',
      token: 'pat_x',
      office_id: 'o',
      agent_id: 'a',
      devices: [{ device_id: 'a', ip: '192.168.1.2', port: 10009 }],
    };
    const res = await dispatch(config, setDevices(devices));
    expect(res.success).toBe(false);
    expect(config.devices[0].ip).toBe('192.168.1.2');
  });
});

describe('no charge after the API gave up', () => {
  let mock: PoslinkMockHandle;
  afterEach(() => mock.close());

  it('refuses a second, different sale while one is on the terminal', async () => {
    mock = await startPoslinkMock({ delayMs: 100 });
    const config = configFor(mock, 'h1');
    const [a, b] = await Promise.all([dispatch(config, sale('A', 'h1')), dispatch(config, sale('B', 'h1'))]);
    expect(a.success).toBe(true);
    expect(b.success).toBe(false);
    if (!b.success) expect(b.error.code).toBe(ERROR_CODES.DEVICE_BUSY);
    expect(mock.received.filter((r) => r.command === COMMAND.DO_CREDIT)).toHaveLength(1);
  });

  it('drops a command that waited more than 5 s for the terminal, without sending it', async () => {
    mock = await startPoslinkMock({ delayMs: 5_300 });
    const config = configFor(mock, 'h2');
    const [first, late] = await Promise.all([
      dispatch(config, sale('slow', 'h2')),
      dispatch(config, { type: 'request', id: 'late', command: 'pax.void', payload: { device_id: 'h2', orig_ref_num: '1' } }),
    ]);
    expect(first.success).toBe(true);
    expect(late.success).toBe(false);
    if (!late.success) expect(late.error.code).toBe(ERROR_CODES.DEVICE_BUSY);
    expect(mock.received).toHaveLength(1);
  }, 10_000);

  it('cancel with external_id aborts only that sale', async () => {
    mock = await startPoslinkMock({ delayMs: 100 });
    const config = configFor(mock, 'h3');
    config.devices[0].secondary_port = mock.port;
    const running = dispatch(config, sale('mine', 'h3'));
    const cancel = (externalId?: string, id = 'c') =>
      dispatch(config, { type: 'request', id, command: 'pax.cancel', payload: { device_id: 'h3', external_id: externalId } });

    const other = await cancel('ext-someone-else');
    expect((other as { result: PaxResult }).result.result_code).toBe('NOT_RUNNING');
    expect(mock.received.some((r) => r.command === COMMAND.ABORT)).toBe(false);

    await cancel('ext-mine', 'c2');
    expect(mock.received.some((r) => r.command === COMMAND.ABORT)).toBe(true);
    await running;
    // Old API (no external_id): aborts whatever is there, as before.
    const count = mock.received.length;
    await cancel(undefined, 'c3');
    expect(mock.received.length).toBe(count + 1);
  });
});

describe('unknown outcome vs unreachable', () => {
  it('is TERMINAL_NO_RESPONSE when a sale reached the terminal and then timed out', async () => {
    const { createServer } = await import('net');
    // Accepts the connection and never answers.
    const silent = createServer(() => undefined);
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
    const port = (silent.address() as { port: number }).port;
    const { pickErrorCode } = await import('../src/command-router');
    const { sendCommand } = await import('../src/pax-client');
    const err = await sendCommand({ ip: '127.0.0.1', port, timeoutMs: 200 }, 'T00').catch((e) => e);
    silent.close();
    expect(pickErrorCode(err, 'pax.sale')).toBe(ERROR_CODES.TERMINAL_NO_RESPONSE);
    expect(pickErrorCode(err, 'pax.void')).toBe(ERROR_CODES.TERMINAL_NO_RESPONSE);
    expect(pickErrorCode(err, 'pax.ping')).toBe(ERROR_CODES.DEVICE_UNREACHABLE);
  });

  it('is DEVICE_UNREACHABLE when the connection itself failed', async () => {
    const { pickErrorCode } = await import('../src/command-router');
    const { sendCommand } = await import('../src/pax-client');
    const refused = await sendCommand({ ip: '127.0.0.1', port: 1, timeoutMs: 1_000 }, 'T00').catch((e) => e);
    expect(pickErrorCode(refused, 'pax.sale')).toBe(ERROR_CODES.DEVICE_UNREACHABLE);
    // Connect that never completes (non-routable address) times out before sending.
    const noConnect = await sendCommand({ ip: '10.255.255.1', port: 10009, timeoutMs: 300 }, 'T00').catch((e) => e);
    expect(pickErrorCode(noConnect, 'pax.sale')).toBe(ERROR_CODES.DEVICE_UNREACHABLE);
  });
});
