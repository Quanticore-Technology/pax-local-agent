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
import { anyBusy, runIfIdle } from './terminal-queue';
import type { TerminalStatus, TerminalStatusMessage } from './protocol/messages';

const logger = getLogger();

const CHECK_INTERVAL_MS = 30_000;
const SEND_AT_LEAST_EVERY_MS = 60_000;
// Keeps a real command's wait behind a check under the router's 5 s limit.
const CHECK_TIMEOUT_MS = 3_000;
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
  discover?: (device: DeviceEntry & { serial: string }, exclude: string[]) => Promise<FoundTerminal | null>;
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
  let stopped = false;

  const discover =
    opts.discover ??
    ((device: DeviceEntry & { serial: string }, exclude: string[]) =>
      discoverTerminal({ hosts: subnetHosts(), port: device.port, serial: device.serial, exclude }));

  const save = (): void => {
    // After stop() the orchestrator may have deleted or replaced the config
    // (revoked token, re-pair); writing ours back would resurrect it.
    if (!opts.configPath || stopped) return;
    try {
      writeConfig(config, opts.configPath);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'could not save terminal info to config');
    }
  };

  /** One A00 at the configured address. Returns true when discovery is due. */
  const checkDevice = async (deviceId: string): Promise<boolean> => {
    // Look the device up live: config.set_devices may have replaced it.
    const device = config.devices.find((d) => d.device_id === deviceId);
    if (!device) return false;
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
    statuses.set(deviceId, status);

    let ok = false;
    try {
      const id = await initialize(device.ip, device.port, CHECK_TIMEOUT_MS);
      if (device.serial && id.serial && id.serial !== device.serial) {
        // Another terminal took this IP (DHCP). Sales must not go to it
        // silently: report unreachable and let discovery find ours.
        logger.warn({ deviceId, ip: device.ip, expected: device.serial, got: id.serial }, 'a different terminal answers at this IP');
      } else {
        ok = true;
        Object.assign(status, { reachable: true, serial: id.serial || undefined, model: id.model || undefined });
        if (id.serial && !device.serial) {
          device.serial = id.serial;
          save();
        }
      }
    } catch {
      // unreachable
    }
    if (ok) {
      failures.set(deviceId, 0);
      return false;
    }
    const count = (failures.get(deviceId) ?? 0) + 1;
    failures.set(deviceId, count);
    return count >= DISCOVER_AFTER_FAILURES && (count - DISCOVER_AFTER_FAILURES) % DISCOVER_EVERY_FAILURES === 0;
  };

  /**
   * Scan for the terminal by its remembered serial. Runs outside the queue (it
   * never touches a configured address) and only when no command is running
   * anywhere, so it can neither delay nor disturb a sale.
   */
  const rediscover = async (deviceId: string): Promise<void> => {
    const device = config.devices.find((d) => d.device_id === deviceId);
    if (!device?.serial || anyBusy()) return;
    const others = config.devices.filter((d) => d.device_id !== deviceId).map((d) => d.ip);
    const started = Date.now();
    const found = await discover({ ...device, serial: device.serial }, others).catch(() => null);
    logger.info({ deviceId, found, ms: Date.now() - started }, 'terminal discovery finished');
    if (!found || found.ip === device.ip || stopped) return;
    logger.warn({ deviceId, from: device.ip, to: found.ip, serial: found.serial }, 'terminal found at a new IP, config updated');
    device.ip = found.ip;
    save();
    failures.set(deviceId, 0);
    statuses.set(deviceId, {
      device_id: deviceId,
      ip: found.ip,
      port: device.port,
      reachable: true,
      serial: found.serial || undefined,
      model: found.model || undefined,
      checked_at: new Date().toISOString(),
      discovered: true,
    });
  };

  const runRound = async (): Promise<void> => {
    for (const device of config.devices) {
      const job = runIfIdle(device.device_id, () => checkDevice(device.device_id));
      if (job) {
        if (await job) await rediscover(device.device_id);
      } else if (!statuses.has(device.device_id)) {
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
    if (stopped) return;
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
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
