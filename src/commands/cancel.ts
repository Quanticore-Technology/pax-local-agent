import { buildPosLinkXml, sendPosLinkCommand, toPaxResult } from '../pax-client';
import type { DeviceEntry } from '../config';
import type { PaxResult } from '../protocol/messages';

// ABORT must complete fast — it's only telling PAX to drop the prompt screen,
// not waiting for a transaction. The original SALE call (still in flight on
// another fetch) returns separately with a "user cancelled" result code.
const TIMEOUT_MS = 8_000;

export async function handleCancel(device: DeviceEntry): Promise<PaxResult> {
  const xml = buildPosLinkXml('ABORT');
  const raw = await sendPosLinkCommand(
    { ip: device.ip, port: device.port, timeoutMs: TIMEOUT_MS, transport: device.transport },
    xml,
  );
  return toPaxResult(raw, 0);
}
