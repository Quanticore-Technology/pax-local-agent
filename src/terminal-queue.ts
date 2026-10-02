/**
 * One command at a time per terminal.
 *
 * The primary POSLink port serves a single transaction: a second packet sent
 * while a sale waits for a card comes back SERVICE BUSY, or — worse — lands
 * after the first finishes and starts a second charge. Everything that talks
 * to the primary port goes through here, keyed by device_id. (Cancel does not:
 * it uses the secondary port precisely so it can interrupt a running sale.)
 */
import { CommandError } from './command-error';
import { ERROR_CODES } from './protocol/messages';

interface Lane {
  tail: Promise<unknown>;
  /** Commands running or waiting, background checks included. */
  pending: number;
  /** Of those, real commands from the API. */
  commands: number;
}

const lanes = new Map<string, Lane>();

function laneFor(key: string): Lane {
  let lane = lanes.get(key);
  if (!lane) {
    lane = { tail: Promise.resolve(), pending: 0, commands: 0 };
    lanes.set(key, lane);
  }
  return lane;
}

function enqueue<T>(key: string, fn: () => Promise<T>, background: boolean): Promise<T> {
  const lane = laneFor(key);
  lane.pending++;
  if (!background) lane.commands++;
  const run = lane.tail.then(fn);
  lane.tail = run
    .catch(() => undefined)
    .finally(() => {
      lane.pending--;
      if (!background) lane.commands--;
    });
  return run;
}

/**
 * Run `fn` after everything already queued for this terminal. With
 * `maxWaitMs`, a command whose turn comes later than that is dropped with
 * DEVICE_BUSY without touching the terminal: by then the API may already have
 * timed it out and told the cashier to retry, and running it anyway would
 * charge twice.
 */
export function runExclusive<T>(key: string, fn: () => Promise<T>, maxWaitMs?: number): Promise<T> {
  const queuedAt = Date.now();
  return enqueue(
    key,
    () => {
      const waited = Date.now() - queuedAt;
      if (maxWaitMs !== undefined && waited > maxWaitMs) {
        return Promise.reject(
          new CommandError(ERROR_CODES.DEVICE_BUSY, `Terminal was busy for ${waited} ms; command not sent`),
        );
      }
      return fn();
    },
    false,
  );
}

/** True while a real command (not a background check) is running or waiting. */
export function isBusy(key: string): boolean {
  return (lanes.get(key)?.commands ?? 0) > 0;
}

export function anyBusy(): boolean {
  for (const lane of lanes.values()) if (lane.commands > 0) return true;
  return false;
}

/**
 * Lowest priority: run only when nothing at all is running or waiting for
 * this terminal, otherwise skip (returns null). Used by the background status
 * check so it can never collide with a real command.
 */
export function runIfIdle<T>(key: string, fn: () => Promise<T>): Promise<T> | null {
  return (lanes.get(key)?.pending ?? 0) > 0 ? null : enqueue(key, fn, true);
}
