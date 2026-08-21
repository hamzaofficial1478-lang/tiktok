import { describe, expect, it } from 'vitest';
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

  it('leaves an ordinary run completely alone', async () => {
    const result = await runner.run(process.execPath, ['-e', 'process.stdout.write("ok")']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('ok');
  });
});
