import { isIPv4 } from 'net';
import { writeConfig } from '../config';
import type { AgentConfig } from '../config';
import { CommandError } from '../command-error';
import { ERROR_CODES } from '../protocol/messages';
import type { SetDevicesPayload, SetDevicesResult } from '../protocol/messages';

/**
 * config.set_devices — change terminal addresses from the dashboard.
 *
 * Mutates the live config so the next command uses the new address without a
 * reconnect, and persists it (token and everything else untouched). Fields the
 * API does not know about (secondary_port, serial) survive for the same
 * device_id.
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

  const devices = input.map(({ device_id, ip, port }) => ({
    ...config.devices.find((old) => old.device_id === device_id),
    device_id,
    ip,
    port,
  }));
  // Persist first: if the write fails, the live config stays as it was.
  if (configPath) writeConfig({ ...config, devices }, configPath);
  config.devices = devices;

  return { devices: devices.map(({ device_id, ip, port }) => ({ device_id, ip, port })) };
}
