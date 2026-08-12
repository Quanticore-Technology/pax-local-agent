import { sendCommand, toPaxResult } from '../pax-client';
import { COMMAND, TRANS_TYPE } from '../poslink-protocol';
import { buildCreditGroups } from '../poslink-credit-request';
import type { DeviceEntry } from '../config';
import type { PaxResult, SalePayload } from '../protocol/messages';

const TIMEOUT_MS = 175_000; // backend uses 180s; stay just under so we answer first

export async function handleSale(device: DeviceEntry, payload: SalePayload): Promise<PaxResult> {
  // The terminal prompts the customer for a tip on its own screen; whatever
  // they enter comes back in the response's TipAmount.
  const groups = buildCreditGroups({
    transactionType: TRANS_TYPE.SALE,
    amountCents: payload.amount_cents,
    invoiceNumber: payload.external_id,
  });

  const parsed = await sendCommand(
    { ip: device.ip, port: device.port, timeoutMs: TIMEOUT_MS },
    COMMAND.DO_CREDIT,
    groups,
  );
  return toPaxResult(parsed, payload.amount_cents);
}
