import { sendCommand, toPaxResult } from '../pax-client';
import { COMMAND, TRANS_TYPE } from '../poslink-protocol';
import { buildCreditGroups, toReferenceNumber } from '../poslink-credit-request';
import type { DeviceEntry } from '../config';
import type { PaxResult, RefundPayload } from '../protocol/messages';

const TIMEOUT_MS = 58_000; // backend uses 60s

export async function handleRefund(
  device: DeviceEntry,
  payload: RefundPayload,
  requestId: string,
): Promise<PaxResult> {
  // RETURN always carries an explicit amount. Linking it to the original sale's
  // TransactionNumber is optional but keeps PAX reporting and chargeback
  // handling tied together.
  const groups = buildCreditGroups({
    referenceNumber: toReferenceNumber(requestId),
    transactionType: TRANS_TYPE.RETURN,
    amountCents: payload.amount_cents,
    origTransactionNumber: payload.orig_ref_num,
  });

  const parsed = await sendCommand(
    { ip: device.ip, port: device.port, timeoutMs: TIMEOUT_MS },
    COMMAND.DO_CREDIT,
    groups,
  );
  return toPaxResult(parsed, 0);
}
