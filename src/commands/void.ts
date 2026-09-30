import { sendCommand, toPaxResult } from '../pax-client';
import { COMMAND, TRANS_TYPE } from '../poslink-protocol';
import { buildCreditGroups, toReferenceNumber } from '../poslink-credit-request';
import type { DeviceEntry } from '../config';
import type { PaxResult, VoidPayload } from '../protocol/messages';

const TIMEOUT_MS = 28_000; // backend uses 30s

export async function handleVoid(
  device: DeviceEntry,
  payload: VoidPayload,
  requestId: string,
): Promise<PaxResult> {
  // `orig_ref_num` is the TransactionNumber we surfaced from the original sale.
  const groups = buildCreditGroups({
    referenceNumber: toReferenceNumber(requestId),
    transactionType: TRANS_TYPE.VOID,
    origTransactionNumber: payload.orig_ref_num,
  });

  const parsed = await sendCommand(
    { ip: device.ip, port: device.port, timeoutMs: TIMEOUT_MS },
    COMMAND.DO_CREDIT,
    groups,
  );
  return toPaxResult(parsed, 0);
}
