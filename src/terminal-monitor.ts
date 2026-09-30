/**
 * Periodic reachability check of every configured terminal, reported to the
 * API as `terminal_status`, plus auto-discovery when a terminal's DHCP address
 * changed under us.
 *
 * The check is an A00 Initialize — cheap, touches no card — sent through the
 * terminal queue at the lowest priority: skipped outright while any command is
 * running or waiting on that terminal, so it can never collide with a sale.
 */
import { writeConfig } from './config';
import type { AgentConfig, DeviceEntry } from './config';
import { getLogger } from './logger';
import { initialize } from './commands/ping';
import { discoverTerminal, FoundTerminal, subnetHosts } from './terminal-discovery';
import { isBusy, runIfIdle } from './terminal-queue';
import type { TerminalStatus, TerminalStatusMessage } from './protocol/messages';

const logger = getLogger();

const CHECK_INTERVAL_MS = 30_000;
const SEND_AT_LEAST_EVERY_MS = 60_000;
const CHECK_TIMEOUT_MS = 5_000;
/** Scan after this many failed checks in a row, then every 10 more (~5 min). */
const DISCOVER_AFTER_FAILURES = 2;
const DISCOVER_EVERY_FAILURES = 10;


export interface TerminalMonitorOptions {
  config: AgentConfig;
  /** Where a learned serial or discovered IP is saved; omitted in tests. */
  configPath?: string;
  send: (msg: TerminalStatusMessage) => void;
  intervalMs?: number;
  /** Injected in tests. */
  discover?: (device: DeviceEntry, exclude: string[]) => Promise<FoundTerminal | null>;
}

export interface TerminalMonitorHandle {
  /** Run a check round now; `force` sends the status even if nothing changed. */
  checkNow(force?: boolean): Promise<void>;
  stop(): void;
}

export function startTerminalMonitor(opts: TerminalMonitorOptions): TerminalMonitorHandle {
  const { config } = opts;
  const statuses = new Map<string, TerminalStatus>();
  const failures = new Map<string, number>();
  let lastSentJson = '';
  let lastSentAt = 0;
  let forceNext = false;
  let round: Promise<void> | null = null;

  const discover =
    opts.discover ??
    ((device: DeviceEntry, exclude: string[]) =>
      discoverTerminal({ hosts: subnetHosts(), port: device.port, serial: device.serial, exclude }));

  const save = (): void => {
    if (!opts.configPath) return;
    try {
      writeConfig(config, opts.configPath);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'could not save terminal info to config');
    }
  };

  const checkDevice = async (deviceId: string): Promise<void> => {
    // Look the device up live: config.set_devices may have replaced it.
    const device = config.devices.find((d) => d.device_id === deviceId);
    if (!device) return;
    const previous = statuses.get(deviceId);
    const status: TerminalStatus = {
      device_id: deviceId,
      ip: device.ip,
      port: device.port,
      reachable: false,
      checked_at: new Date().toISOString(),
      // Stays set until the address changes again, so the API can show it.
      discovered: previous?.ip === device.ip ? previous.discovered : undefined,
    };

    try {
      const id = await initialize(device.ip, device.port, CHECK_TIMEOUT_MS);
      Object.assign(status, { reachable: true, serial: id.serial || undefined, model: id.model || undefined });
      failures.set(deviceId, 0);
      if (id.serial && id.serial !== device.serial) {
        device.serial = id.serial;
        save();
      }
    } catch {
      const count = (failures.get(deviceId) ?? 0) + 1;
      failures.set(deviceId, count);
      const due = count >= DISCOVER_AFTER_FAILURES && (count - DISCOVER_AFTER_FAILURES) % DISCOVER_EVERY_FAILURES === 0;
      const othersBusy = config.devices.some((d) => d.device_id !== deviceId && isBusy(d.device_id));
      if (due && !othersBusy) {
        // Runs inside this terminal's queue slot, so a sale that arrives now
        // waits the few seconds the scan takes and then uses the new address.
        const others = config.devices.filter((d) => d.device_id !== deviceId).map((d) => d.ip);
        const started = Date.now();
        const found = await discover(device, others).catch(() => null);
        logger.info({ deviceId, found, ms: Date.now() - started }, 'terminal discovery finished');
        if (found && found.ip !== device.ip) {
          logger.warn({ deviceId, from: device.ip, to: found.ip, serial: found.serial }, 'terminal found at a new IP, config updated');
          device.ip = found.ip;
          device.serial = found.serial || device.serial;
          save();
          failures.set(deviceId, 0);
          Object.assign(status, {
            ip: found.ip,
            reachable: true,
            serial: found.serial || undefined,
            model: found.model || undefined,
            discovered: true,
          });
        }
      }
    }
    statuses.set(deviceId, status);
  };

  const runRound = async (): Promise<void> => {
    for (const device of config.devices) {
      const job = runIfIdle(device.device_id, () => checkDevice(device.device_id));
      if (job) await job;
      else if (!statuses.has(device.device_id)) {
        // Busy before the first check: a command is talking to it right now.
        statuses.set(device.device_id, {
          device_id: device.device_id,
          ip: device.ip,
          port: device.port,
          reachable: true,
          checked_at: new Date().toISOString(),
        });
      }
    }
    const ids = new Set(config.devices.map((d) => d.device_id));
    for (const id of statuses.keys()) if (!ids.has(id)) statuses.delete(id);

    const devices = config.devices.flatMap((d) => statuses.get(d.device_id) ?? []);
    // checked_at alone is not a change worth a message.
    const json = JSON.stringify(devices.map(({ checked_at, ...rest }) => rest));
    if (forceNext || json !== lastSentJson || Date.now() - lastSentAt >= SEND_AT_LEAST_EVERY_MS - 5_000) {
      forceNext = false;
      lastSentJson = json;
      lastSentAt = Date.now();
      opts.send({ type: 'terminal_status', devices });
    }
  };

  const checkNow = (force = false): Promise<void> => {
    if (force) forceNext = true;
    // A round already past its send would swallow the force; run one more.
    if (round && force) return round.then(() => (forceNext ? checkNow(true) : undefined));
    if (!round) {
      round = runRound()
        .catch((err) => logger.warn({ err: (err as Error).message }, 'terminal check failed'))
        .finally(() => {
          round = null;
        });
    }
    return round;
  };

  const timer = setInterval(() => void checkNow(), opts.intervalMs ?? CHECK_INTERVAL_MS);
  timer.unref?.();

  return {
    checkNow,
    stop: () => clearInterval(timer),
  };
}
