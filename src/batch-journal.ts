import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { createHash } from 'crypto';
import { AgentConfig, writeFileDurable } from './config';
import type { BatchResultReplayMessage, ResponseMessage } from './protocol/messages';

type Entry = BatchResultReplayMessage & { acked?: boolean };

/** An unfinished intent is an unknown outcome after restart, never permission to resend B00. */
export class BatchJournal {
  private entries: Record<string, Entry> = Object.create(null);
  private static open = new Map<string, BatchJournal>();

  constructor(private readonly path: string) {
    // Fail closed on unreadable data: silently replacing it could repeat settlement.
    if (existsSync(path)) this.entries = JSON.parse(readFileSync(path, 'utf8'));
    if (!this.entries || Array.isArray(this.entries) || typeof this.entries !== 'object') {
      throw new Error('Invalid batch journal');
    }
    for (const [id, entry] of Object.entries(this.entries)) {
      if (!entry || entry.closeout_id !== id || typeof entry.device_id !== 'string' ||
          typeof entry.request_id !== 'string' || entry.type !== 'batch_result_replay' ||
          !Number.isFinite(Date.parse(entry.completed_at)) ||
          (entry.acked !== undefined && typeof entry.acked !== 'boolean') ||
          !entry.response || entry.response.type !== 'response' || entry.response.id !== entry.request_id ||
          typeof entry.response.success !== 'boolean' ||
          (entry.response.success
            ? !entry.response.result || !('result_code' in entry.response.result) || typeof entry.response.result.result_code !== 'string'
            : !entry.response.error || typeof entry.response.error.code !== 'string' || typeof entry.response.error.message !== 'string')) {
        throw new Error('Invalid batch journal entry');
      }
    }
    this.entries = Object.assign(Object.create(null), this.entries);
  }

  static nextTo(configPath: string, config: AgentConfig): BatchJournal {
    const identity = createHash('sha256').update(`${config.office_id}:${config.agent_id}`).digest('hex');
    const path = join(dirname(configPath), `batch-journal-${identity}.json`);
    let journal = this.open.get(path);
    if (!journal) this.open.set(path, journal = new BatchJournal(path));
    return journal;
  }

  get(id: string): Entry | undefined { return this.entries[id]; }

  begin(id: string, requestId: string, deviceId: string): void {
    const previous = this.entries[id];
    this.entries[id] = {
      type: 'batch_result_replay', closeout_id: id, request_id: requestId, device_id: deviceId,
      completed_at: new Date().toISOString(),
      response: { type: 'response', id: requestId, success: false,
        error: { code: 'TERMINAL_NO_RESPONSE', message: 'Agent restarted before batch outcome was confirmed' } },
    };
    try {
      this.save(); // Must succeed before sending the money command.
    } catch (err) {
      if (previous) this.entries[id] = previous;
      else delete this.entries[id];
      throw err;
    }
  }

  complete(id: string, response: ResponseMessage): void {
    const entry = this.entries[id];
    entry.response = response;
    entry.completed_at = new Date().toISOString();
    this.save();
  }

  ack(id: string, requestId: string): void {
    const entry = this.entries[id];
    if (!entry || entry.request_id !== requestId) return;
    entry.acked = true;
    this.save();
  }

  pending(): Entry[] { return Object.values(this.entries).filter(e => !e.acked); }

  private save(): void {
    // Keep every intent: deleting an old closeout would allow its ID to settle a new batch.
    writeFileDurable(this.path, JSON.stringify(this.entries));
  }
}
