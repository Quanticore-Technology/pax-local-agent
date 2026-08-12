import { CommandError } from '../command-error';
import { ERROR_CODES } from '../protocol/messages';
import type { DeviceEntry } from '../config';
import type { PaxResult } from '../protocol/messages';

/**
 * Cancelling an in-progress sale is not implemented yet.
 *
 * PAX's JavaScript sample does not cover an abort/cancel command, so its code
 * is unknown. The caller already treats cancel as best-effort — see
 * `cancelSale()` in pax-adapter.service.ts, which finalises the payment row
 * even when the terminal cannot be reached — so failing here degrades cleanly:
 * staff press Cancel on the terminal itself and the in-flight sale returns with
 * a user-cancelled result code.
 *
 * Revisit once the Low Level Specification arrives from PAX.
 */
export async function handleCancel(_device: DeviceEntry): Promise<PaxResult> {
  throw new CommandError(
    ERROR_CODES.PROTOCOL_ERROR,
    'Remote cancel is not supported yet — the POSLink command code is pending the Low Level Specification from PAX. Press Cancel on the terminal instead.',
  );
}
