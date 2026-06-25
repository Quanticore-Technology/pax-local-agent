import { buildPosLinkXml, escapeXml, sendPosLinkCommand, toPaxResult } from '../pax-client';
import type { DeviceEntry } from '../config';
import type { PaxResult, SalePayload } from '../protocol/messages';

const TIMEOUT_MS = 175_000; // backend uses 180s; agent slightly shorter so we beat its timeout

export async function handleSale(device: DeviceEntry, payload: SalePayload): Promise<PaxResult> {
  // <Tip1>0</Tip1> = prompt customer for tip on terminal screen.
  // <InvoiceNo> carries our external_id for reconciliation in PAX reporting.
  const extData = `<Tip1>0</Tip1><InvoiceNo>${escapeXml(payload.external_id)}</InvoiceNo>`;
  const xml = buildPosLinkXml('SALE', {
    Amount: String(payload.amount_cents),
    ExtData: extData,
  });
  const raw = await sendPosLinkCommand(
    { ip: device.ip, port: device.port, timeoutMs: TIMEOUT_MS, transport: device.transport },
    xml,
  );
  return toPaxResult(raw, payload.amount_cents);
}
