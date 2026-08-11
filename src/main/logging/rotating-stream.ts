import { Writable } from 'node:stream';
import { closeSync, existsSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export interface RotatingFileStreamOptions {
  /** Directory for log files; created if absent. */
  directory: string;
  /** Base filename, e.g. "app.log" — rotated files become "app.1.log", … */
  filename?: string;
  /** Rotate once the active file exceeds this size. */
  maxBytes?: number;
  /** How many rotated files to keep, excluding the active one. */
  maxFiles?: number;
}

/**
 * A dependency-free rolling log file.
 *
 * Deliberately not pino-roll or any other transport-based rotator: pino
 * transports run in worker threads and resolve their target module by path at
 * runtime, which is exactly the thing that breaks once the main process is
 * bundled and packaged into an asar. A plain Writable has no such failure mode,
 * and logging is the one subsystem that must not be the thing that breaks when
 * you are trying to diagnose what broke.
 *
 * Writes go through `writeSync` on an owned fd. That is safe here because
 * Writable serialises `_write` calls, so this never blocks the event loop the
 * way `appendFileSync` in a hot path would.
 */
export class RotatingFileStream extends Writable {
  private readonly directory: string;
  private readonly base: string;
  private readonly ext: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;

  private fd: number | null = null;
  private bytes = 0;

  constructor(options: RotatingFileStreamOptions) {
    super({ decodeStrings: true });
    const filename = options.filename ?? 'app.log';
    const dot = filename.lastIndexOf('.');
    this.directory = options.directory;
    this.base = dot > 0 ? filename.slice(0, dot) : filename;
    this.ext = dot > 0 ? filename.slice(dot) : '';
    this.maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
    this.maxFiles = options.maxFiles ?? 5;
    this.open();
  }

  get activePath(): string {
    return join(this.directory, `${this.base}${this.ext}`);
  }

  private rotatedPath(index: number): string {
    return join(this.directory, `${this.base}.${index}${this.ext}`);
  }

  private open(): void {
    mkdirSync(this.directory, { recursive: true });
    this.fd = openSync(this.activePath, 'a');
    this.bytes = existsSync(this.activePath) ? statSync(this.activePath).size : 0;
  }

  /**
   * Shift app.4.log -> app.5.log, …, app.log -> app.1.log, dropping whatever
   * falls off the end. Renaming oldest-first is what keeps this safe to
   * interrupt: a crash mid-rotation loses at most one rotated file, never the
   * active one.
   */
  private rotate(): void {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }

    const oldest = this.rotatedPath(this.maxFiles);
    if (existsSync(oldest)) {
      try {
        unlinkSync(oldest);
      } catch {
        /* a reader may hold it open on Windows; the next rotation retries */
      }
    }

    for (let i = this.maxFiles - 1; i >= 1; i--) {
      const from = this.rotatedPath(i);
      if (existsSync(from)) {
        try {
          renameSync(from, this.rotatedPath(i + 1));
        } catch {
          /* non-fatal: keep logging rather than throwing from the logger */
        }
      }
    }

    if (existsSync(this.activePath)) {
      try {
        renameSync(this.activePath, this.rotatedPath(1));
      } catch {
        /* ditto */
      }
    }

    this.open();
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    try {
      if (this.bytes > 0 && this.bytes + chunk.length > this.maxBytes) this.rotate();
      if (this.fd === null) this.open();
      writeSync(this.fd as number, chunk);
      this.bytes += chunk.length;
      callback();
    } catch (err) {
      // Never propagate: a failing log write must not take down the app.
      callback();
      void err;
    }
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch {
        /* ignore */
      }
      this.fd = null;
    }
    callback();
  }
}
