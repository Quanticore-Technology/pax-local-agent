import { sendCommand, toPaxResult } from '../pax-client';
import { COMMAND, TRANS_TYPE } from '../poslink-protocol';
import { buildCreditGroups, toReferenceNumber } from '../poslink-credit-request';
import type { DeviceEntry } from '../config';
import type { PaxResult, TipAdjustPayload } from '../protocol/messages';

const TIMEOUT_MS = 28_000;

export async function handleTipAdjust(
  device: DeviceEntry,
  payload: TipAdjustPayload,
  requestId: string,
): Promise<PaxResult> {
  // ADJUST changes only the tip on an already-approved sale, so the tip goes in
  // the amount group's TipAmount slot and the base amount is left untouched.
  const groups = buildCreditGroups({
    referenceNumber: toReferenceNumber(requestId),
    transactionType: TRANS_TYPE.ADJUST,
    tipCents: payload.tip_cents,
    origTransactionNumber: payload.orig_ref_num,
  });

  const parsed = await sendCommand(
    { ip: device.ip, port: device.port, timeoutMs: TIMEOUT_MS },
    COMMAND.DO_CREDIT,
    groups,
  );
  return toPaxResult(parsed, 0);
}
