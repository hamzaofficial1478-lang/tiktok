import { describe, expect, it, vi } from 'vitest';
import { Impersonation, impersonateArgs } from '@main/resolve/impersonation';
import type { ProcessResult, ProcessRunner } from '@main/resolve/process-runner';

/**
 * Why a link fails here and downloads fine in another program.
 *
 *     ERROR: [TikTok] …: Unable to download webpage: Failed to perform,
 *     curl: (56) Connection closed abruptly.
 *
 * Note what it is not. Not a refusal, not a 403, not a timeout, and no
 * response at all — the connection was cut before anything came back. A server
 * that has decided against you answers and says so; one that hangs up during
 * the handshake decided before you finished introducing yourself.
 *
 * TikTok is reading the TLS handshake. Its fingerprint — which ciphers, in
 * which order, which extensions — identifies the library, whatever the
 * User-Agent header claims, and Chrome's user agent arriving over Python's TLS
 * stack is a mismatch visible before a byte of HTTP is exchanged. `--user-agent`
 * was already being sent and only ever fixed the header half.
 */

function runnerThat(result: Partial<ProcessResult>): { runner: ProcessRunner; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    runner: {
      run: async () => {
        calls++;
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false, ...result };
      },
    },
  };
}

const LISTED = `Impersonate target               Source
chrome-110:windows-10            curl_cffi
chrome-124:macos-14              curl_cffi
safari-17.0:macos-14             curl_cffi`;

describe('deciding whether yt-dlp can impersonate a browser', () => {
  it('uses Chrome when the build offers it', async () => {
    const { runner } = runnerThat({ stdout: LISTED });
    const support = new Impersonation({ binaryPath: () => '/fake/yt-dlp', runner });

    expect(await support.target()).toBe('chrome');
  });

  it('asks once and remembers, rather than probing before every video', async () => {
    const { runner, calls } = runnerThat({ stdout: LISTED });
    const support = new Impersonation({ binaryPath: () => '/fake/yt-dlp', runner });

    await Promise.all([support.target(), support.target(), support.target()]);
    await support.target();

    // A probe per video would spawn a process before every download to
    // re-learn something that cannot change without yt-dlp being replaced.
    expect(calls()).toBe(1);
  });

  it('declines when the build does not know the flag', async () => {
    // An older yt-dlp, or one installed without curl_cffi. Asking for a target
    // that is not there fails the download outright — trading an intermittent
    // problem for a permanent one.
    const { runner } = runnerThat({ exitCode: 2, stderr: 'no such option: --list-impersonate-targets' });
    const support = new Impersonation({ binaryPath: () => '/fake/yt-dlp', runner });

    expect(await support.target()).toBeNull();
  });

  it('declines when it lists targets but no Chrome among them', async () => {
    const { runner } = runnerThat({ stdout: 'Impersonate target\nsafari-17.0:macos-14' });
    const support = new Impersonation({ binaryPath: () => '/fake/yt-dlp', runner });

    expect(await support.target()).toBeNull();
  });

  it('declines, rather than throwing, when the probe itself fails', async () => {
    const runner: ProcessRunner = {
      run: async () => {
        throw new Error('spawn ENOENT');
      },
    };
    const support = new Impersonation({ binaryPath: () => '/fake/yt-dlp', runner });

    // Not impersonating is how this has always worked. Failing a download
    // because the probe failed would be a self-inflicted outage.
    expect(await support.target()).toBeNull();
  });

  it('declines when there is no extractor to ask', async () => {
    const { runner, calls } = runnerThat({ stdout: LISTED });
    const support = new Impersonation({ binaryPath: () => null, runner });

    expect(await support.target()).toBeNull();
    expect(calls()).toBe(0);
  });

  it('asks again once the extractor has been replaced', async () => {
    const run = vi.fn<ProcessRunner['run']>(async () => ({
      stdout: LISTED,
      stderr: '',
      exitCode: 0,
      timedOut: false,
    }));
    const support = new Impersonation({ binaryPath: () => '/fake/yt-dlp', runner: { run } });

    await support.target();
    support.reset();
    await support.target();

    // A replaced binary may gain or lose the ability, so the cached answer is
    // no longer about this extractor.
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('the flag itself', () => {
  it('is a pair when there is a target', () => {
    expect(impersonateArgs('chrome')).toEqual(['--impersonate', 'chrome']);
  });

  it('is nothing at all when there is not', () => {
    // Not `--impersonate ''`, which yt-dlp would reject.
    expect(impersonateArgs(null)).toEqual([]);
  });
});
