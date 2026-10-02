import { isIPv4 } from 'net';
import { writeConfig } from '../config';
import type { AgentConfig, DeviceEntry } from '../config';
import { CommandError } from '../command-error';
import { ERROR_CODES } from '../protocol/messages';
import type { SetDevicesPayload, SetDevicesResult } from '../protocol/messages';

/**
 * config.set_devices — change terminal addresses from the dashboard.
 *
 * Mutates the live config so the next command uses the new address without a
 * reconnect, and persists it (token and everything else untouched). Fields the
 * API does not know about survive for the same device_id (secondary_port
 * always, serial only while the address is unchanged).
 */
export function handleSetDevices(
  config: AgentConfig,
  configPath: string | undefined,
  payload: SetDevicesPayload,
): SetDevicesResult {
  const input = payload?.devices;
  if (!Array.isArray(input) || input.length === 0) {
    throw new CommandError(ERROR_CODES.PROTOCOL_ERROR, 'devices must be a non-empty array');
  }
  const seen = new Set<string>();
  for (const d of input) {
    if (!d || typeof d.device_id !== 'string' || !d.device_id) {
      throw new CommandError(ERROR_CODES.PROTOCOL_ERROR, 'each device needs a device_id');
    }
    if (seen.has(d.device_id)) {
      throw new CommandError(ERROR_CODES.PROTOCOL_ERROR, `duplicate device_id "${d.device_id}"`);
    }
    seen.add(d.device_id);
    if (typeof d.ip !== 'string' || !isIPv4(d.ip)) {
      throw new CommandError(ERROR_CODES.PROTOCOL_ERROR, `invalid IPv4 address "${d.ip}"`);
    }
    if (!Number.isInteger(d.port) || d.port < 1 || d.port > 65535) {
      throw new CommandError(ERROR_CODES.PROTOCOL_ERROR, `invalid port "${d.port}"`);
    }
  }

  const devices = input.map(({ device_id, ip, port }) => {
    const old = config.devices.find((d) => d.device_id === device_id);
    const entry: DeviceEntry = { ...old, device_id, ip, port };
    // A new address may be a different terminal; its serial is learned on the
    // next successful check, and discovery must not hunt for the old one.
    if (old && (old.ip !== ip || old.port !== port)) delete entry.serial;
    return entry;
  });
  // Persist first: if the write fails, the live config stays as it was.
  if (configPath) writeConfig({ ...config, devices }, configPath);
  config.devices = devices;

  return { devices: devices.map(({ device_id, ip, port }) => ({ device_id, ip, port })) };
}
