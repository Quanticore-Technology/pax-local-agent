import { CommandError } from '../command-error';
import { ERROR_CODES } from '../protocol/messages';
import type { DeviceEntry } from '../config';
import type { BatchClosePayload, PaxResult } from '../protocol/messages';

/**
 * Batch close is not implemented yet.
 *
 * PAX's JavaScript sample only demonstrates Initialize (A00), GetSignature
 * (A08), DoSignature (A20) and DoCredit (T00). The command code for batch
 * settlement is not among them, and the previous implementation's guess never
 * reached the terminal. Rather than ship another guess, this fails loudly until
 * the Low Level Specification document arrives from PAX and we can use the
 * documented code.
 *
 * Merchants can still settle from the terminal's own menu in the meantime.
 */
export async function handleBatchClose(
  _device: DeviceEntry,
  _payload: BatchClosePayload,
): Promise<PaxResult> {
  throw new CommandError(
    ERROR_CODES.PROTOCOL_ERROR,
    'Batch close is not supported yet — the POSLink command code is pending the Low Level Specification from PAX. Settle from the terminal menu for now.',
  );
}
