import type { Logger } from 'pino';
import type { ProcessRunner } from './process-runner';

/**
 * Looking like a browser all the way down, not just in the headers.
 *
 * The failure this exists for is the commonest one this app sees:
 *
 *     ERROR: [TikTok] …: Unable to download webpage: Failed to perform,
 *     curl: (56) Connection closed abruptly.
 *
 * Note what it is *not*. Not a refusal, not a 403, not a timeout, and no
 * response at all — the connection was cut before anything came back. A server
 * that has decided it does not like you sends a page saying so; a server that
 * hangs up during the handshake has decided it does not like you before you
 * finished introducing yourself.
 *
 * What TikTok is looking at is the TLS handshake. Every client has a
 * fingerprint in it — which ciphers it offers, in which order, which
 * extensions, how the ALPN list is built — and that fingerprint identifies the
 * *library*, no matter what the User-Agent header claims. Sending Chrome's
 * user agent from Python's TLS stack is a mismatch a CDN can spot before a
 * single byte of HTTP is exchanged, and dropping the connection is cheaper for
 * them than answering it.
 *
 * `--user-agent` was already being sent, and it only ever fixed the header
 * half. This is the other half: yt-dlp's curl_cffi backend can reproduce a
 * real browser's handshake, and the same links that fail without it succeed
 * with it. It is also why other downloaders do not hit this — the ones that
 * work impersonate, and have for a while.
 *
 * Probed rather than assumed. Impersonation needs curl_cffi, which the official
 * yt-dlp builds bundle and a pip install may not, and asking for a target that
 * is not there fails the download outright — trading an intermittent problem
 * for a permanent one.
 */

/**
 * Chrome, and nothing more specific.
 *
 * yt-dlp resolves a bare `chrome` to the newest Chrome target its curl_cffi
 * actually has, which is the version least likely to stand out. Pinning an
 * exact build here would go stale and start standing out on its own.
 */
const PREFERRED = 'chrome';

export interface ImpersonationOptions {
  /** Read fresh: an extractor update mid-session can add support. */
  readonly binaryPath: () => string | null;
  readonly runner: ProcessRunner;
  readonly log?: Logger;
}

export class Impersonation {
  /** undefined = not asked yet; null = asked, not available. */
  private cached: string | null | undefined;
  private inFlight: Promise<string | null> | null = null;

  constructor(private readonly options: ImpersonationOptions) {}

  /**
   * The target to pass to `--impersonate`, or null when it cannot be used.
   *
   * Asked once and remembered. A probe per video would spawn a process before
   * every single download to re-learn something that cannot change without the
   * extractor being replaced.
   */
  async target(): Promise<string | null> {
    if (this.cached !== undefined) return this.cached;
    this.inFlight ??= this.probe().then((value) => {
      this.cached = value;
      this.inFlight = null;
      return value;
    });
    return this.inFlight;
  }

  /** Forgets the answer, so a replaced extractor is asked again. */
  reset(): void {
    this.cached = undefined;
    this.inFlight = null;
  }

  private async probe(): Promise<string | null> {
    const binary = this.options.binaryPath();
    if (!binary) return null;

    try {
      const result = await this.options.runner.run(binary, ['--list-impersonate-targets'], { timeoutMs: 20_000 });
      // Older builds do not know the flag at all, and print usage to stderr.
      if (result.exitCode !== 0) {
        this.options.log?.info('this yt-dlp build cannot impersonate a browser; requests will use its own TLS identity');
        return null;
      }

      const listed = /chrome/i.test(result.stdout);
      if (!listed) {
        this.options.log?.info(
          { output: result.stdout.slice(0, 200) },
          'yt-dlp lists no Chrome impersonation target; requests will use its own TLS identity',
        );
        return null;
      }

      this.options.log?.info({ target: PREFERRED }, 'requests will present a browser TLS fingerprint');
      return PREFERRED;
    } catch (err) {
      // Never fatal. Not impersonating is how it has always worked; failing a
      // download because the probe failed would be a self-inflicted outage.
      this.options.log?.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'could not check whether yt-dlp can impersonate a browser; carrying on without it',
      );
      return null;
    }
  }
}

/** The flag pair, or nothing. Keeps the call sites free of conditionals. */
export function impersonateArgs(target: string | null): string[] {
  return target ? ['--impersonate', target] : [];
}
