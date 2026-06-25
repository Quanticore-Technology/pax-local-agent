import { buildPosLinkXml, sendPosLinkCommand, toPaxResult } from '../pax-client';
import type { DeviceEntry } from '../config';
import type { PaxResult, RefundPayload } from '../protocol/messages';

const TIMEOUT_MS = 58_000; // backend uses 60s

export async function handleRefund(device: DeviceEntry, payload: RefundPayload): Promise<PaxResult> {
  // POSLink RETURN — Amount is always explicit; OrigRefNum is optional and ties
  // the refund back to a specific sale for reporting + chargeback flows.
  const fields: Record<string, string> = {
    Amount: String(payload.amount_cents),
  };
  if (payload.orig_ref_num) fields.OrigRefNum = payload.orig_ref_num;

  const xml = buildPosLinkXml('RETURN', fields);
  const raw = await sendPosLinkCommand(
    { ip: device.ip, port: device.port, timeoutMs: TIMEOUT_MS, transport: device.transport },
    xml,
  );
  return toPaxResult(raw, 0);
}
