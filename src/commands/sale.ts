import { sendCommand, toPaxResult } from '../pax-client';
import { getLogger } from '../logger';
import { COMMAND, TRANS_TYPE } from '../poslink-protocol';
import { buildCreditGroups, toInvoiceNumber, toReferenceNumber } from '../poslink-credit-request';
import type { DeviceEntry } from '../config';
import type { PaxResult, SalePayload } from '../protocol/messages';

const logger = getLogger();

const TIMEOUT_MS = 175_000; // backend uses 180s; stay just under so we answer first

export async function handleSale(device: DeviceEntry, payload: SalePayload): Promise<PaxResult> {
  // TIPREQ=1 makes the terminal prompt the customer for a tip on its own
  // screen; whatever they enter comes back in the response's TipAmount. We send
  // it explicitly rather than relying on the device's own tip configuration,
  // which differs per terminal and is invisible from here. Staff can still
  // correct the figure afterwards via pax.tip_adjust.
  const groups = buildCreditGroups({
    transactionType: TRANS_TYPE.SALE,
    amountCents: payload.amount_cents,
    invoiceNumber: payload.external_id,
    referenceNumber: toReferenceNumber(payload.external_id),
    tipPrompt: true,
  });

  // Logged as a pair so a PAX batch report row can be matched back to our
  // payment record without recomputing the fold by hand.
  logger.info(
    { externalId: payload.external_id, invoiceNumber: toInvoiceNumber(payload.external_id) },
    'sale invoice mapping',
  );

  const parsed = await sendCommand(
    { ip: device.ip, port: device.port, timeoutMs: TIMEOUT_MS },
    COMMAND.DO_CREDIT,
    groups,
  );
  return toPaxResult(parsed, payload.amount_cents);
}
