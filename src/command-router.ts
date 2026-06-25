import { getLogger } from './logger';
import type { AgentConfig, DeviceEntry } from './config';
import {
  ERROR_CODES,
  PaxResult,
  RequestMessage,
  ResponseMessage,
} from './protocol/messages';
import { handleSale } from './commands/sale';
import { handleVoid } from './commands/void';
import { handleRefund } from './commands/refund';
import { handleTipAdjust } from './commands/tip-adjust';
import { handleBatchClose } from './commands/batch-close';
import { handlePing } from './commands/ping';
import { handleCancel } from './commands/cancel';

const logger = getLogger();

export class CommandError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

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

/**
 * Dispatch one server-issued request, return a properly-shaped response.
 * All errors are caught and mapped to ResponseError so the gateway never sees
 * an unhandled rejection (which would silently leave the cloud caller hanging
 * until its 180s timeout).
 */
export async function dispatch(config: AgentConfig, msg: RequestMessage): Promise<ResponseMessage> {
  const startedAt = Date.now();
  try {
    const result = await runCommand(config, msg);
    logger.info(
      { id: msg.id, command: msg.command, ms: Date.now() - startedAt, code: result.result_code },
      'command success',
    );
    return { type: 'response', id: msg.id, success: true, result };
  } catch (err) {
    const code = err instanceof CommandError ? err.code : pickErrorCode(err);
    const message = (err as Error).message || 'agent command failed';
    logger.warn({ id: msg.id, command: msg.command, code, message }, 'command failed');
    return {
      type: 'response',
      id: msg.id,
      success: false,
      error: { code, message },
    };
  }
}

async function runCommand(config: AgentConfig, msg: RequestMessage): Promise<PaxResult> {
  const deviceId = (msg.payload as { device_id?: string }).device_id;
  switch (msg.command) {
    case 'pax.sale':
      return handleSale(resolveDevice(config, deviceId), msg.payload as any);
    case 'pax.void':
      return handleVoid(resolveDevice(config, deviceId), msg.payload as any);
    case 'pax.refund':
      return handleRefund(resolveDevice(config, deviceId), msg.payload as any);
    case 'pax.tip_adjust':
      return handleTipAdjust(resolveDevice(config, deviceId), msg.payload as any);
    case 'pax.batch_close':
      return handleBatchClose(resolveDevice(config, deviceId), msg.payload as any);
    case 'pax.ping':
      return handlePing(resolveDevice(config, deviceId));
    case 'pax.cancel':
      return handleCancel(resolveDevice(config, deviceId));
    default:
      throw new CommandError(ERROR_CODES.PROTOCOL_ERROR, `Unknown command: ${msg.command}`);
  }
}

function pickErrorCode(err: unknown): string {
  const e = err as Error & { code?: string; cause?: { code?: string } };
  // AbortError fires when our fetch timeout elapses — the device never
  // responded, which is "unreachable" not "busy".
  if (e.name === 'AbortError') return ERROR_CODES.DEVICE_UNREACHABLE;
  if (e.code === 'ECONNREFUSED' || e.cause?.code === 'ECONNREFUSED') return ERROR_CODES.DEVICE_UNREACHABLE;
  if (e.code === 'EHOSTUNREACH' || e.cause?.code === 'EHOSTUNREACH') return ERROR_CODES.DEVICE_UNREACHABLE;
  return ERROR_CODES.POSLINK_ERROR;
}
