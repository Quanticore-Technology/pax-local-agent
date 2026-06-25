import pino, { Logger, StreamEntry } from 'pino';
import { join } from 'path';
import { accessSync, constants } from 'fs';
import { defaultLogDir, ensureDir } from './config';

let baseLogger: Logger | null = null;

/** Pino logger writing stdout + (if writable) a rotating file. If the log
 *  directory isn't writable (e.g. running tests as a non-privileged user
 *  while the dir was chowned to `nobody` by a prior installer), silently
 *  fall back to stdout-only so the agent doesn't crash on first log call. */
export function getLogger(): Logger {
  if (baseLogger) return baseLogger;
  const dir = defaultLogDir();
  const streams: StreamEntry[] = [{ stream: process.stdout }];

  try {
    ensureDir(dir);
    accessSync(dir, constants.W_OK);
    const logFile = join(dir, 'agent.log');
    streams.push({
      stream: pino.destination({ dest: logFile, sync: false, mkdir: true }),
    });
  } catch {
    // Dir not writable — stdout is enough. Production install (postinstall)
    // chowns the dir to `nobody`, which is the user the LaunchDaemon drops to.
  }

  baseLogger = pino(
    {
      level: process.env.LOG_LEVEL || 'info',
      base: { service: 'pax-agent' },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.multistream(streams),
  );
  return baseLogger;
}

/** Lightweight in-memory rate limiter so we don't flood the backend with logs. */
export class LogRateLimiter {
  private windowStart = Date.now();
  private count = 0;
  constructor(
    private readonly maxPerMinute: number = 60,
  ) {}

  allow(): boolean {
    const now = Date.now();
    if (now - this.windowStart > 60_000) {
      this.windowStart = now;
      this.count = 0;
    }
    this.count++;
    return this.count <= this.maxPerMinute;
  }
}
