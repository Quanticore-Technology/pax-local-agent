import { buildPosLinkXml, sendPosLinkCommand, toPaxResult } from '../pax-client';
import type { DeviceEntry } from '../config';
import type { PaxResult, VoidPayload } from '../protocol/messages';

const TIMEOUT_MS = 28_000; // backend uses 30s

export async function handleVoid(device: DeviceEntry, payload: VoidPayload): Promise<PaxResult> {
  const xml = buildPosLinkXml('VOID', {
    OrigRefNum: payload.orig_ref_num,
  });
  const raw = await sendPosLinkCommand(
    { ip: device.ip, port: device.port, timeoutMs: TIMEOUT_MS, transport: device.transport },
    xml,
  );
  return toPaxResult(raw, 0);
}
