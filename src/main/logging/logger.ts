import { Writable } from 'node:stream';
import pino from 'pino';
import type { LogEntry } from '@shared/ipc/contract';
import type { LogLevel } from '@shared/types';
import { RotatingFileStream } from './rotating-stream';

/**
 * Structured logging — spec section 10: "This is what makes support tickets
 * solvable — do not skip it."
 *
 * Three sinks off one pino instance:
 *   1. rolling NDJSON files, which is what an exported diagnostic bundle ships;
 *   2. an in-memory ring buffer, which backs the Logs screen's initial paint
 *      without re-reading files from disk;
 *   3. a subscriber callback, which streams new lines to the renderer live.
 *
 * Redaction is configured here rather than at each call site so that adding a
 * sensitive field later is a one-line change in one file — the seam section 13
 * asks for.
 */

const PINO_LEVEL_NAMES: Readonly<Record<number, LogLevel>> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

/**
 * Paths and proxy URLs routinely contain a real name or credentials. They are
 * still needed for debugging, so they are censored only in the exported view,
 * never dropped — see `redact.censor`.
 */
const REDACT_PATHS = [
  'proxyUrl',
  '*.proxyUrl',
  'password',
  '*.password',
  'token',
  '*.token',
  'cookie',
  '*.cookie',
  /**
   * The identity presented to TikTok. Nothing logs these today — the grep that
   * checked is the reason they are listed rather than assumed — but the log is
   * the one thing users are invited to export and paste into a bug report, and
   * a device fingerprint is exactly the sort of value that should never make
   * that trip by accident.
   */
  'deviceId',
  '*.deviceId',
  'installId',
  '*.installId',
];

export interface LoggerHandle {
  /** Root logger; call `.child({ scope })` per subsystem. */
  readonly log: pino.Logger;
  /** Most recent entries, newest last. Backs `log:tail`. */
  tail(limit: number): LogEntry[];
  /** Live subscription used by the IPC event bus. Returns an unsubscribe fn. */
  subscribe(fn: (entry: LogEntry) => void): () => void;
  setLevel(level: LogLevel): void;
  /** Absolute path of the active log file, for the diagnostic bundle. */
  readonly activeLogPath: string;
  close(): Promise<void>;
}

export interface CreateLoggerOptions {
  directory: string;
  level: LogLevel;
  /** Also mirror to stdout — on in development, off in a packaged build. */
  mirrorToStdout?: boolean;
  ringSize?: number;
  maxBytes?: number;
  maxFiles?: number;
}

export function createLogger(options: CreateLoggerOptions): LoggerHandle {
  const ringSize = options.ringSize ?? 2_000;
  const ring: LogEntry[] = [];
  const subscribers = new Set<(entry: LogEntry) => void>();

  const fileStream = new RotatingFileStream({
    directory: options.directory,
    filename: 'app.log',
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    ...(options.maxFiles === undefined ? {} : { maxFiles: options.maxFiles }),
  });

  /**
   * Parses pino's NDJSON back into typed entries. Slightly wasteful versus
   * hooking pino internals, but it guarantees the Logs screen shows exactly
   * what the file contains — including redaction — rather than a parallel
   * representation that can drift.
   */
  const fanoutStream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        let entry: LogEntry;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          const { time, level, msg, scope, pid, hostname, ...rest } = parsed;
          void pid;
          void hostname;
          entry = {
            time: typeof time === 'number' ? time : Date.now(),
            level: PINO_LEVEL_NAMES[typeof level === 'number' ? level : 30] ?? 'info',
            scope: typeof scope === 'string' ? scope : 'app',
            msg: typeof msg === 'string' ? msg : '',
            ...(Object.keys(rest).length > 0 ? { data: rest } : {}),
          };
        } catch {
          continue;
        }
        ring.push(entry);
        if (ring.length > ringSize) ring.splice(0, ring.length - ringSize);
        for (const fn of subscribers) {
          try {
            fn(entry);
          } catch {
            /* a bad subscriber must not break logging */
          }
        }
      }
      cb();
    },
  });

  const streams: pino.StreamEntry[] = [
    { level: 'trace', stream: fileStream },
    { level: 'trace', stream: fanoutStream },
  ];
  if (options.mirrorToStdout) streams.push({ level: 'debug', stream: process.stdout });

  const log = pino(
    {
      level: options.level,
      base: undefined, // drop pid/hostname: noise in a desktop app's logs
      timestamp: pino.stdTimeFunctions.epochTime,
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    },
    pino.multistream(streams, { levels: pino.levels.values }),
  );

  return {
    log,
    tail(limit: number): LogEntry[] {
      return ring.slice(Math.max(0, ring.length - limit));
    },
    subscribe(fn: (entry: LogEntry) => void): () => void {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    setLevel(level: LogLevel): void {
      log.level = level;
    },
    activeLogPath: fileStream.activePath,
    async close(): Promise<void> {
      subscribers.clear();
      await new Promise<void>((resolve) => fileStream.end(() => resolve()));
    },
  };
}
