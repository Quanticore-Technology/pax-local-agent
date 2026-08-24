import { getLogger } from './logger';
import type { AgentConfig, DeviceEntry } from './config';
import { CommandError } from './command-error';
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

/**
 * Map a transport-level failure onto a stable wire error code.
 *
 * These stay distinct because they point at different fixes: a refused
 * connection means the ECR server is switched off on the terminal, an
 * unreachable host usually means the agent and terminal are on different
 * subnets, and a timeout means the terminal accepted the connection but never
 * answered — typically a Protocol Type mismatch in ECR Comm Settings.
 */
function pickErrorCode(err: unknown): string {
  const e = err as Error & { code?: string; cause?: { code?: string } };
  const code = e.code || e.cause?.code;

  if (code === 'ECONNREFUSED') return ERROR_CODES.DEVICE_UNREACHABLE;
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return ERROR_CODES.DEVICE_UNREACHABLE;
  if (code === 'ETIMEDOUT' || code === 'ECONNRESET') return ERROR_CODES.DEVICE_UNREACHABLE;
  // Our own timeout, raised by pax-client when the terminal accepts the
  // connection but sends nothing back.
  if (/timed out/i.test(e.message || '')) return ERROR_CODES.DEVICE_UNREACHABLE;
  return ERROR_CODES.POSLINK_ERROR;
}
