import { buildPosLinkXml, sendPosLinkCommand, toPaxResult } from '../pax-client';
import type { DeviceEntry } from '../config';
import type { PaxResult, BatchClosePayload } from '../protocol/messages';

const TIMEOUT_MS = 58_000;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function handleBatchClose(device: DeviceEntry, _payload: BatchClosePayload): Promise<PaxResult> {
  const xml = buildPosLinkXml('BATCHCLOSE');
  const raw = await sendPosLinkCommand(
    { ip: device.ip, port: device.port, timeoutMs: TIMEOUT_MS, transport: device.transport },
    xml,
  );
  return toPaxResult(raw, 0);
}
