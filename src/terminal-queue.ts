/**
 * One command at a time per terminal.
 *
 * The primary POSLink port serves a single transaction: a second packet sent
 * while a sale waits for a card comes back SERVICE BUSY, or — worse — lands
 * after the first finishes and starts a second charge. Everything that talks
 * to the primary port goes through here, keyed by device_id. (Cancel does not:
 * it uses the secondary port precisely so it can interrupt a running sale.)
 */
interface Lane {
  tail: Promise<unknown>;
  /** Commands running or waiting. */
  pending: number;
}

const lanes = new Map<string, Lane>();

/** Run `fn` after everything already queued for this terminal. */
export function runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  let lane = lanes.get(key);
  if (!lane) {
    lane = { tail: Promise.resolve(), pending: 0 };
    lanes.set(key, lane);
  }
  const current = lane;
  current.pending++;
  const run = current.tail.then(fn);
  current.tail = run
    .catch(() => undefined)
    .finally(() => {
      current.pending--;
    });
  return run;
}

export function isBusy(key: string): boolean {
  return (lanes.get(key)?.pending ?? 0) > 0;
}

export function anyBusy(): boolean {
  for (const lane of lanes.values()) if (lane.pending > 0) return true;
  return false;
}

/**
 * Lowest priority: run only when nothing is running or waiting for this
 * terminal, otherwise skip (returns null). Used by the background status check
 * so it can never delay or collide with a real command.
 */
export function runIfIdle<T>(key: string, fn: () => Promise<T>): Promise<T> | null {
  return isBusy(key) ? null : runExclusive(key, fn);
}
