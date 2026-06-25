import { buildPosLinkXml, sendPosLinkCommand, toPaxResult } from '../pax-client';
import type { DeviceEntry } from '../config';
import type { PaxResult } from '../protocol/messages';

// Backend governs overall ping budget at 5 s (TIMEOUT_PING_MS in
// pax-adapter.service.ts). Agent timeout is a safety net; bumped from 4.5 s
// to 9 s so we don't abort early when PAX is just waking from sleep / mid
// WiFi switch — measured INIT round-trips on a healthy A920 are <2 s.
const TIMEOUT_MS = 9_000;

export async function handlePing(device: DeviceEntry): Promise<PaxResult> {
  const xml = buildPosLinkXml('INIT');
  const raw = await sendPosLinkCommand(
    { ip: device.ip, port: device.port, timeoutMs: TIMEOUT_MS, transport: device.transport },
    xml,
  );
  return toPaxResult(raw, 0);
}
