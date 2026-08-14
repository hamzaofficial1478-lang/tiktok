import { spawn } from 'node:child_process';
import { AppError } from '@shared/errors';

export interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
}

export interface RunOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly maxBufferBytes?: number;
  /**
   * Working directory for the child.
   *
   * Added for one specific reason: ffmpeg's `subtitles` filter takes its
   * filename *inside* a filter graph, where `:` separates options, `,` chains
   * filters and `\` escapes — so a Windows path like
   * `C:\Users\ammar laptops\Videos\a.ass` has to be rewritten into something
   * unrecognisable, and every published recipe for doing so disagrees with the
   * others. Running ffmpeg from the directory the file is in and passing a bare
   * ASCII filename sidesteps the entire problem rather than solving it three
   * quarters of the way.
   */
  readonly cwd?: string;
  /**
   * Called with each chunk of stdout as it arrives, for processes that report
   * progress while they run. Output is still buffered and returned as usual.
   */
  readonly onStdout?: (chunk: string) => void;
}

/**
 * Spawning a sidecar, behind an interface.
 *
 * Injected rather than imported so the extractor suite can run against
 * recorded yt-dlp JSON. That matters more than usual here: TikTok is
 * unreachable from CI, and an extractor that can only be tested against the
 * live site is an extractor that stops being tested.
 */
export interface ProcessRunner {
  run(command: string, args: readonly string[], options?: RunOptions): Promise<ProcessResult>;
}

export class ChildProcessRunner implements ProcessRunner {
  /**
   * Deliberately not execFile: it rejects on a non-zero exit, discarding the
   * stderr that says *why*. yt-dlp communicates every interesting failure that
   * way, and the classifier needs the text to pick the right taxonomy code.
   */
  async run(command: string, args: readonly string[], options: RunOptions = {}): Promise<ProcessResult> {
    const timeoutMs = options.timeoutMs ?? 60_000;
    const maxBuffer = options.maxBufferBytes ?? 64 * 1024 * 1024;

    return new Promise<ProcessResult>((resolve, reject) => {
      const child = spawn(command, [...args], {
        windowsHide: true,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      });

      let stdout = '';
      let stderr = '';
      let stdoutBytes = 0;
      let timedOut = false;
      let settled = false;

      const finish = (result: ProcessResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        resolve(result);
      };

      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        reject(err);
      };

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      const onAbort = (): void => {
        child.kill('SIGKILL');
        fail(new AppError('CANCELLED', `${command} cancelled`));
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdoutBytes += Buffer.byteLength(chunk);
        // Guard against a runaway process filling memory; a truncated payload
        // fails JSON parsing loudly rather than being half-trusted.
        if (stdoutBytes > maxBuffer) {
          child.kill('SIGKILL');
          fail(new AppError('EXTRACTOR_FAILED', `${command} produced more than ${maxBuffer} bytes of output`));
          return;
        }
        stdout += chunk;
        options.onStdout?.(chunk);
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        // stderr is bounded separately: it is only ever read for diagnostics.
        if (stderr.length < 64_000) stderr += chunk;
      });

      child.on('error', (err) => {
        fail(
          new AppError(
            'EXTRACTOR_FAILED',
            `could not run ${command}: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err },
          ),
        );
      });

      child.on('close', (exitCode) => finish({ stdout, stderr, exitCode, timedOut }));
    });
  }
}
