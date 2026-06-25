import { buildPosLinkXml, sendPosLinkCommand, toPaxResult } from '../pax-client';
import type { DeviceEntry } from '../config';
import type { PaxResult, TipAdjustPayload } from '../protocol/messages';

const TIMEOUT_MS = 28_000;

export async function handleTipAdjust(device: DeviceEntry, payload: TipAdjustPayload): Promise<PaxResult> {
  const xml = buildPosLinkXml('ADJUST', {
    OrigRefNum: payload.orig_ref_num,
    Amount: String(payload.tip_cents),
  });
  const raw = await sendPosLinkCommand(
    { ip: device.ip, port: device.port, timeoutMs: TIMEOUT_MS, transport: device.transport },
    xml,
  );
  return toPaxResult(raw, 0);
}
