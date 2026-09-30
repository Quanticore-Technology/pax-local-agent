/**
 * On-disk record of every finished pax.sale, keyed by external_id.
 *
 * A card can be charged while the WebSocket is down; without this the result
 * would exist only in memory and the salon would see "failed" for money that
 * was taken. Each result is written here before the response is sent, then
 * re-sent as `sale_result_replay` after every (re)connect until the API
 * answers `replay_ack`. The same record makes a retried sale return the stored
 * approval instead of charging the card a second time.
 */
import { existsSync, readFileSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import { writeFileDurable } from './config';
import { getLogger } from './logger';
import type { PaxResult } from './protocol/messages';

const logger = getLogger();
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

export interface JournalEntry {
  request_id: string;
  result: PaxResult;
  completed_at: string;
  /** API confirmed it has this result; kept only so a retry cannot charge twice. */
  acked?: boolean;
}

export class SaleJournal {
  private entries: Record<string, JournalEntry> = {};

  constructor(private readonly path: string) {
    if (existsSync(path)) {
      try {
        this.entries = JSON.parse(readFileSync(path, 'utf8'));
      } catch (err) {
        // Never throw on startup over this; keep the unreadable file for a human.
        logger.error({ path, err: (err as Error).message }, 'sale journal unreadable, starting empty');
        try {
          renameSync(path, `${path}.corrupt-${Date.now()}`);
        } catch {
          /* the next save overwrites it */
        }
      }
    }
    this.prune();
  }

  private static open = new Map<string, SaleJournal>();

  /**
   * Journal for a given config file (same directory). One instance per file:
   * a ws-client restarted mid-sale must not overwrite the old one's writes.
   */
  static nextTo(configPath: string): SaleJournal {
    const path = join(dirname(configPath), 'sale-journal.json');
    let journal = SaleJournal.open.get(path);
    if (!journal) SaleJournal.open.set(path, (journal = new SaleJournal(path)));
    return journal;
  }

  get(externalId: string): JournalEntry | undefined {
    return this.entries[externalId];
  }

  record(externalId: string, requestId: string, result: PaxResult): void {
    this.entries[externalId] = { request_id: requestId, result, completed_at: new Date().toISOString() };
    this.prune();
  }

  /**
   * The contract says delete on ack; we keep the entry (marked, never replayed
   * again) until the 7-day prune so a retried sale still finds its approval.
   */
  ack(externalId: string): void {
    const entry = this.entries[externalId];
    if (!entry || entry.acked) return;
    entry.acked = true;
    this.save();
  }

  unacked(): Array<{ external_id: string } & JournalEntry> {
    return Object.entries(this.entries)
      .filter(([, e]) => !e.acked)
      .map(([external_id, e]) => ({ external_id, ...e }));
  }

  private prune(): void {
    const cutoff = Date.now() - KEEP_MS;
    for (const [id, e] of Object.entries(this.entries)) {
      if (!(Date.parse(e.completed_at) >= cutoff)) delete this.entries[id];
    }
    this.save();
  }

  /**
   * Atomic, durable, owner-only: write tmp, fsync, rename. Never throws — a
   * full disk must not turn a finished charge into an error response; the
   * result still goes out in memory.
   */
  private save(): void {
    try {
      writeFileDurable(this.path, JSON.stringify(this.entries, null, 2));
    } catch (err) {
      logger.error({ path: this.path, err: (err as Error).message }, 'sale journal write failed');
    }
  }
}
