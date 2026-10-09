import { BatchJournal } from './batch-journal';
import { getLogger } from './logger';
import type { AgentConfig, DeviceEntry } from './config';
import { CommandError } from './command-error';
import {
  CommandDiagnostics,
  ERROR_CODES,
  PaxResult,
  RequestMessage,
  ResponseMessage,
  CancelPayload,
  SalePayload,
  SetDevicesPayload,
  SetDevicesResult,
} from './protocol/messages';
import { SUCCESS_CODE } from './poslink-protocol';
import { isBusy, runExclusive } from './terminal-queue';
import type { SaleJournal } from './sale-journal';
import { handleSale } from './commands/sale';
import { handleVoid } from './commands/void';
import { handleRefund } from './commands/refund';
import { handleTipAdjust } from './commands/tip-adjust';
import { handleBatchClose } from './commands/batch-close';
import { handlePing } from './commands/ping';
import { handleCancel } from './commands/cancel';
import { handleSetDevices } from './commands/set-devices';
import { printReceipt } from './commands/print-receipt';
import type { TransportError } from './pax-client';

const logger = getLogger();

export { CommandError };

function resolveDevice(config: AgentConfig, deviceId: string | undefined): DeviceEntry {
  // device_id is mandatory in the wire protocol, but ping may omit it.
  if (!deviceId) {
    if (config.devices.length === 1) return config.devices[0];
    throw new CommandError(ERROR_CODES.INVALID_DEVICE_ID, 'device_id required when multiple devices configured');
  }
  const found = config.devices.find((d) => d.device_id === deviceId);
  if (!found) {
    throw new CommandError(
      ERROR_CODES.INVALID_DEVICE_ID,
      `Unknown device_id "${deviceId}" — configured: ${config.devices.map((d) => d.device_id).join(', ')}`,
    );
  }
  return found;
}

export interface DispatchContext {
  /** Where config.set_devices persists; omitted in tests. */
  configPath?: string;
  /** Sale results journal; omitted in tests that don't care about persistence. */
  journal?: SaleJournal;
  batchJournal?: BatchJournal;
}

// The API answers a sale at 180s. Whatever the sale leaves of that budget is
// all a receipt print may use, so a slow printer can't make the response late.
const SALE_BUDGET_MS = 178_000;
const PRINT_MAX_MS = 15_000;
const PRINT_MIN_MS = 3_000;

/**
 * How long a command may wait for the terminal. The API's own timeouts are
 * far longer, but a command that waited behind another real one is exactly
 * the case where the API may have given up and the cashier retried; the
 * background status check (one A00, a few seconds at most) stays under this.
 */
const QUEUE_MAX_WAIT_MS = 5_000;

/** Sales running or queued, by external_id: a duplicate request joins the same promise. */
const salesInFlight = new Map<string, { deviceId: string; run: Promise<PaxResult> }>();

export function isSaleInFlight(externalId: string): boolean {
  return salesInFlight.has(externalId);
}

function saleOnDevice(deviceId: string): string | undefined {
  for (const [externalId, sale] of salesInFlight) if (sale.deviceId === deviceId) return externalId;
  return undefined;
}

/**
 * Dispatch one server-issued request, return a properly-shaped response.
 * All errors are caught and mapped to ResponseError so the gateway never sees
 * an unhandled rejection (which would silently leave the cloud caller hanging
 * until its 180s timeout).
 */
const batchesInFlight = new Map<string, { deviceId: string | undefined; run: Promise<ResponseMessage> }>();

export function isBatchInFlight(config: AgentConfig, closeoutId: string): boolean {
  return batchesInFlight.has(`${config.office_id}:${config.agent_id}:${closeoutId}`);
}

export async function dispatch(
  config: AgentConfig,
  msg: RequestMessage,
  ctx: DispatchContext = {},
): Promise<ResponseMessage> {
  if (msg.command === 'pax.batch_close' && (!msg.payload || typeof msg.payload !== 'object' || Array.isArray(msg.payload) ||
      typeof (msg.payload as { device_id?: unknown }).device_id !== 'string' || !(msg.payload as { device_id?: string }).device_id)) {
    return { type: 'response', id: msg.id, success: false, error: { code: ERROR_CODES.PROTOCOL_ERROR, message: 'Invalid batch payload' } };
  }
  const payload = msg.payload as { closeout_id?: string; device_id?: string };
  if (msg.command !== 'pax.batch_close' || payload.closeout_id === undefined) return execute(config, msg, ctx);
  if (typeof payload.closeout_id !== 'string' || !payload.closeout_id || payload.closeout_id.length > 128 || typeof payload.device_id !== 'string') {
    return { type: 'response', id: msg.id, success: false, error: { code: ERROR_CODES.PROTOCOL_ERROR, message: 'Invalid batch identity' } };
  }
  const id = payload.closeout_id;
  const key = `${config.office_id}:${config.agent_id}:${id}`;
  const running = batchesInFlight.get(key);
  if (running) {
    if (running.deviceId !== payload.device_id) return { type: 'response', id: msg.id, success: false, error: { code: ERROR_CODES.PROTOCOL_ERROR, message: 'Closeout belongs to another terminal' } };
    return { ...await running.run, id: msg.id };
  }
  const saved = ctx.batchJournal?.get(id);
  if (saved) {
    if (saved.device_id !== payload.device_id) return { type: 'response', id: msg.id, success: false,
      error: { code: ERROR_CODES.PROTOCOL_ERROR, message: 'Closeout belongs to another terminal' } };
    return { ...saved.response, id: msg.id };
  }
  const run = (async (): Promise<ResponseMessage> => {
    try {
      if (!ctx.batchJournal) throw new Error('Batch journal unavailable');
      ctx.batchJournal.begin(id, msg.id, payload.device_id!);
    } catch {
      return { type: 'response', id: msg.id, success: false,
        error: { code: ERROR_CODES.POSLINK_ERROR, message: 'Cannot persist batch intent; command was not sent' },
        diagnostics: { elapsed_ms: 0, request_sent: false } };
    }
    const response = await execute(config, msg, ctx);
    try { ctx.batchJournal.complete(id, response); }
    catch (err) { logger.error({ err: (err as Error).message }, 'batch result persistence failed'); }
    return response;
  })();
  batchesInFlight.set(key, { deviceId: payload.device_id, run });
  try { return await run; } finally { batchesInFlight.delete(key); }
}

async function execute(
  config: AgentConfig,
  msg: RequestMessage,
  ctx: DispatchContext = {},
): Promise<ResponseMessage> {
  const startedAt = Date.now();
  const diagnostics: Partial<CommandDiagnostics> = {};
  try {
    const result = await runCommand(config, msg, ctx, diagnostics);
    logger.info(
      { id: msg.id, command: msg.command, ms: Date.now() - startedAt, code: (result as PaxResult).result_code },
      'command success',
    );
    return { type: 'response', id: msg.id, success: true, result,
      ...(msg.command === 'pax.batch_close' ? { diagnostics: { elapsed_ms: Date.now() - startedAt, ...diagnostics } } : {}) };
  } catch (err) {
    const code = err instanceof CommandError ? err.code : pickErrorCode(err, msg.command);
    const message = (err as Error).message || 'agent command failed';
    logger.warn({ id: msg.id, command: msg.command, code, message }, 'command failed');
    return {
      type: 'response',
      id: msg.id,
      success: false,
      error: { code, message },
      ...(msg.command === 'pax.batch_close' ? { diagnostics: {
        elapsed_ms: Date.now() - startedAt,
        ...diagnostics,
        ...(err as TransportError).diagnostics,
        ...((err as TransportError).code !== undefined ? { transport_code: (err as TransportError).code } : {}),
        ...((err as TransportError).requestSent !== undefined ? { request_sent: (err as TransportError).requestSent } : {}),
      } } : {}),
    };
  }
}

async function runCommand(
  config: AgentConfig,
  msg: RequestMessage,
  ctx: DispatchContext,
  diagnostics: Partial<CommandDiagnostics>,
): Promise<PaxResult | SetDevicesResult> {
  if (msg.command === 'config.set_devices') {
    return handleSetDevices(config, ctx.configPath, msg.payload as SetDevicesPayload);
  }

  const deviceId = (msg.payload as { device_id?: string }).device_id;
  const device = resolveDevice(config, deviceId);
  // Queued commands look the device up again when their turn comes, so an
  // address changed by config.set_devices meanwhile is used straight away.
  const queued = (fn: (d: DeviceEntry) => Promise<PaxResult>): Promise<PaxResult> =>
    runExclusive(device.device_id, () => fn(resolveDevice(config, device.device_id)), QUEUE_MAX_WAIT_MS);

  switch (msg.command) {
    case 'pax.sale':
      return runSale(config, device.device_id, msg, ctx);
    case 'pax.void':
      return queued((d) => handleVoid(d, msg.payload as any, msg.id));
    case 'pax.refund':
      return queued((d) => handleRefund(d, msg.payload as any, msg.id));
    case 'pax.tip_adjust':
      return queued((d) => handleTipAdjust(d, msg.payload as any, msg.id));
    case 'pax.batch_close':
      return queued((d) => handleBatchClose(d, msg.payload as any, diagnostics));
    case 'pax.ping':
      // The API gives ping 5s; waiting behind a 3-minute sale would only time
      // out. A running command already proves the terminal is there. (Only a
      // background check holding the lane is waited for: it is one quick A00.)
      if (isBusy(device.device_id)) {
        throw new CommandError(ERROR_CODES.DEVICE_BUSY, 'Terminal is busy with another command');
      }
      return queued((d) => handlePing(d));
    case 'pax.cancel': {
      // Secondary port, so it must NOT wait behind the sale it is cancelling.
      // But with two cashiers on one terminal, an abort meant for a sale that
      // already ended would kill the other cashier's sale — so when the API
      // names the sale, abort only that one.
      const target = (msg.payload as CancelPayload).external_id;
      if (target && saleOnDevice(device.device_id) !== target) {
        // Same shape as cancel's CANCEL_FAILED: a result, never an A16.
        return {
          result_code: 'NOT_RUNNING',
          result_text: `Sale ${target} is not running on this terminal; nothing aborted`,
          ref_num: '',
          auth_code: '',
          card_type: '',
          last_four: '',
          approved_amount_cents: 0,
          tip_amount_cents: 0,
          raw_response: {},
        };
      }
      return handleCancel(device);
    }
    default:
      throw new CommandError(ERROR_CODES.PROTOCOL_ERROR, `Unknown command: ${msg.command}`);
  }
}

/**
 * A sale is charged at most once per external_id: a duplicate while it runs
 * joins the running one; after an approval, the journaled result is returned.
 * Declines and timeouts are not replayed from the journal — trying the same
 * payment again after one of those must reach the terminal.
 */
function runSale(
  config: AgentConfig,
  deviceId: string,
  msg: RequestMessage,
  ctx: DispatchContext,
): Promise<PaxResult> {
  const payload = msg.payload as SalePayload;
  const key = payload.external_id;
  const done = key ? ctx.journal?.get(key) : undefined;
  if (done && done.result.result_code === SUCCESS_CODE) {
    logger.warn({ id: msg.id, externalId: key }, 'sale already approved, returning journaled result');
    return Promise.resolve(done.result);
  }
  const running = key ? salesInFlight.get(key) : undefined;
  if (running) {
    logger.warn({ id: msg.id, externalId: key }, 'sale already in flight, joining it');
    return running.run;
  }
  // A different sale on this terminal would make this one wait for minutes,
  // long past the API's timeout: refuse now so nothing charges behind the
  // cashier's back.
  const other = saleOnDevice(deviceId);
  if (other) {
    return Promise.reject(
      new CommandError(ERROR_CODES.DEVICE_BUSY, 'Terminal is busy with another sale'),
    );
  }

  const receivedAt = Date.now();
  const run = runExclusive(deviceId, async () => {
    const device = resolveDevice(config, deviceId);
    const result = await handleSale(device, payload);
    // Journal before anything else can fail or the socket can drop.
    if (key) ctx.journal?.record(key, msg.id, result);

    if (payload.print_receipt && result.result_code === SUCCESS_CODE) {
      const left = Math.min(PRINT_MAX_MS, SALE_BUDGET_MS - (Date.now() - receivedAt));
      Object.assign(
        result,
        left < PRINT_MIN_MS
          ? { receipt_printed: false, receipt_error: 'no time left to print before the API deadline' }
          : await printReceipt(device, payload, result, left),
      );
      if (key) ctx.journal?.record(key, msg.id, result);
    }
    return result;
  }, QUEUE_MAX_WAIT_MS);
  if (key) {
    salesInFlight.set(key, { deviceId, run });
    run.then(
      () => salesInFlight.delete(key),
      () => salesInFlight.delete(key),
    );
  }
  return run;
}

/** Commands whose effect on the card is unknown once the packet went out. */
const MONEY_COMMANDS = new Set(['pax.sale', 'pax.void', 'pax.refund', 'pax.tip_adjust', 'pax.batch_close']);

/**
 * Map a transport-level failure onto a stable wire error code.
 *
 * DEVICE_UNREACHABLE means "the terminal never got it, try again", so it is
 * only used when the connection itself failed. Once the packet was sent, a
 * timeout or reset on a money command becomes TERMINAL_NO_RESPONSE: the card
 * may have been charged, and retrying blindly could charge it twice.
 */
export function pickErrorCode(err: unknown, command: string): string {
  const e = err as TransportError & { cause?: { code?: string } };
  const code = e.code || e.cause?.code;
  const transport =
    ['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'ECONNRESET'].includes(code ?? '') ||
    /timed out/i.test(e.message || ''); // pax-client's own timeout

  if (!transport) return ERROR_CODES.POSLINK_ERROR;
  if (e.requestSent && MONEY_COMMANDS.has(command)) return ERROR_CODES.TERMINAL_NO_RESPONSE;
  return ERROR_CODES.DEVICE_UNREACHABLE;
}
