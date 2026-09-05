import { describe, expect, it, vi } from 'vitest';
import { ChildProcessRunner } from '@main/resolve/process-runner';
import { AppError } from '@shared/errors';

/**
 * What a stopped download says.
 *
 * The message was `${command} cancelled`, and `command` is the full path to the
 * bundled binary — so stopping a download produced
 * `C:\Users\…\resources\bin\win32-x64\yt-dlp.exe cancelled` on the queue row.
 * That reads as a complaint about a file at a location, not as "the download
 * you stopped, stopped", and it sent at least one person hunting through the
 * folder it named for a problem that was never there.
 */

const runner = new ChildProcessRunner();
/** A child that will not exit on its own, so the abort is what ends it. */
const forever = ['-e', 'setInterval(() => {}, 1000)'];

describe('stopping a running process', () => {
  it.skipIf(process.platform !== 'win32')('terminates descendants as well as the Windows launcher', async () => {
    let descendant = 0;
    try {
      const result = await runner.run(process.execPath, ['-e',
        `const child = require('node:child_process').spawn(process.execPath,
          ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit', windowsHide: true });
         console.log(child.pid); setInterval(() => {}, 1000);`,
      ], { timeoutMs: 1500, onStdout: (chunk) => { descendant = Number(chunk.trim()); } });
      expect(result.timedOut).toBe(true);
      expect(descendant).toBeGreaterThan(0);
      await vi.waitFor(() => expect(() => process.kill(descendant, 0)).toThrow(), { timeout: 3000 });
    } finally {
      if (descendant > 0) { try { process.kill(descendant); } catch { /* already terminated */ } }
    }
  });

  it('settles a timeout without waiting for process output to close', async () => {
    const result = await runner.run(process.execPath, forever, { timeoutMs: 50 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  });
  it('names the program, not the path it happens to live at', async () => {
    const controller = new AbortController();
    const running = runner.run(process.execPath, forever, { signal: controller.signal });
    controller.abort();

    await expect(running).rejects.toThrow(AppError);
    await running.catch((err: unknown) => {
      const error = err as AppError;
      expect(error.code).toBe('CANCELLED');
      // No directory separators: whatever else it says, it is not a path.
      expect(error.detail ?? '').not.toMatch(/[\\/]/);
      expect(error.detail ?? '').toMatch(/stopped/i);
    });
  });

  it('reports the stop as cancelled rather than as a crash', async () => {
    const controller = new AbortController();
    const running = runner.run(process.execPath, forever, { signal: controller.signal });
    controller.abort();

    // The distinction the queue acts on: a cancel is settled, a crash is
    // retried. Getting this wrong meant a stopped download quietly restarting.
    await expect(running).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  /**
   * The one that let an abandoned item keep working for minutes afterwards.
   *
   * `addEventListener('abort', …)` on a signal that is *already* aborted never
   * fires — that is how AbortSignal works — so a process started after the
   * abort had nothing left that could kill it and ran to its own timeout
   * instead. Resolution tries three routes in turn and the download tries
   * three more, each a separate spawn: abort during the first and the
   * remaining five were each started fresh and left to run out the clock,
   * long after the engine believed it had moved on.
   */
  it('starts nothing at all once the signal has already been raised', async () => {
    const controller = new AbortController();
    controller.abort();

    const started = Date.now();
    await expect(runner.run(process.execPath, forever, { signal: controller.signal })).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    // Immediate, because nothing was spawned — not a minute later when a
    // process nobody could stop finally timed out.
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('leaves an ordinary run completely alone', async () => {
    const result = await runner.run(process.execPath, ['-e', 'process.stdout.write("ok")']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('ok');
  });
});
