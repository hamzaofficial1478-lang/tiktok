import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AppError } from '@shared/errors';
import type { Logger } from 'pino';
import { binaryFilename, platformDir, sha256File, type SidecarManifest } from './sidecars';
import type { ProcessRunner } from '../resolve/process-runner';

/**
 * Updating yt-dlp, in process.
 *
 * This used to shell out to `scripts/fetch-sidecars.mjs`, which was broken in
 * two ways that only showed up on a real machine. The script path was built
 * with `new URL(...).pathname`, so on Windows it produced a leading slash and
 * percent-encoded every space — a user whose home directory is "ammar laptops"
 * got a path that could not exist, and the update failed every time with a
 * message blaming the network. And a packaged build has no `scripts/` directory
 * to run at all, so it could never have worked outside development regardless.
 *
 * Doing the download here fixes both: no path juggling, no child Node process,
 * and it works the same in dev and in an installed app.
 *
 * The binary is written under userData rather than next to the bundled one.
 * An installed app lives somewhere the user cannot write, so an updater that
 * targets its own install directory is an updater that fails on every machine
 * where it matters.
 */

const YT_DLP_ASSETS: Readonly<Record<string, string>> = {
  'win32-x64': 'yt-dlp.exe',
  'win32-arm64': 'yt-dlp.exe',
  'darwin-arm64': 'yt-dlp_macos',
  'darwin-x64': 'yt-dlp_macos_legacy',
  'linux-x64': 'yt-dlp_linux',
  'linux-arm64': 'yt-dlp_linux_aarch64',
};

const RELEASE_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';

/** A yt-dlp build is ~30 MB; anything wildly outside that is not the binary. */
const MIN_PLAUSIBLE_BYTES = 1_000_000;
const MAX_PLAUSIBLE_BYTES = 200 * 1024 * 1024;

export interface ExtractorUpdaterOptions {
  /** Writable root that holds `bin/` — userData, never the install directory. */
  readonly overrideRoot: string;
  readonly runner: ProcessRunner;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly fetchImpl?: typeof fetch;
  readonly log?: Logger;
}

export interface UpdateResult {
  readonly version: string | null;
  readonly updated: boolean;
  readonly message: string;
}

export class ExtractorUpdater {
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;

  constructor(private readonly options: ExtractorUpdaterOptions) {
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
  }

  /** Where an updated yt-dlp lives once installed. */
  get installedPath(): string {
    return join(
      this.options.overrideRoot,
      'bin',
      platformDir(this.platform, this.arch),
      binaryFilename('yt-dlp', this.platform),
    );
  }

  private get assetUrl(): string {
    const key = `${this.platform}-${this.arch}`;
    const asset = YT_DLP_ASSETS[key];
    if (!asset) {
      throw new AppError('EXTRACTOR_FAILED', `no yt-dlp build is published for ${key}`);
    }
    return `${RELEASE_BASE}/${asset}`;
  }

  /**
   * Downloads the current release and installs it if it works.
   *
   * The new binary is proven before it replaces anything: it is written beside
   * the target, executed with `--version`, and only then renamed into place. A
   * failed download that overwrote a working extractor would turn a recoverable
   * problem into an app that cannot download anything at all.
   */
  async update(currentVersion: string | null, signal?: AbortSignal): Promise<UpdateResult> {
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
    const target = this.installedPath;
    const staging = `${target}.new`;

    mkdirSync(dirname(target), { recursive: true });

    // Resolved before the try, so "no build for this platform" is not caught
    // and rewritten as "could not reach the release server".
    const url = this.assetUrl;

    let response: Response;
    try {
      response = await fetchImpl(url, {
        redirect: 'follow',
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      throw new AppError(
        'EXTRACTOR_FAILED',
        `could not reach the yt-dlp release server: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    if (!response.ok) {
      throw new AppError('EXTRACTOR_FAILED', `the release server returned ${response.status} for ${url}`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < MIN_PLAUSIBLE_BYTES || bytes.length > MAX_PLAUSIBLE_BYTES) {
      throw new AppError(
        'EXTRACTOR_FAILED',
        `the download was ${bytes.length} bytes, which is not a yt-dlp binary — a proxy or captive portal may have replaced it`,
      );
    }

    try {
      writeFileSync(staging, bytes);
      if (this.platform !== 'win32') chmodSync(staging, 0o755);

      const version = await this.probeVersion(staging, signal);
      if (version === null) {
        throw new AppError('EXTRACTOR_FAILED', 'the downloaded file did not run; the previous extractor was kept');
      }

      renameSync(staging, target);
      await this.recordInManifest(target, version);

      this.options.log?.info({ from: currentVersion, to: version, path: target }, 'extractor updated');

      return {
        version,
        updated: version !== currentVersion,
        message:
          version === currentVersion
            ? `Already on the latest extractor (${version}).`
            : `Updated the extractor from ${currentVersion ?? 'unknown'} to ${version}.`,
      };
    } finally {
      rmSync(staging, { force: true });
    }
  }

  private async probeVersion(binaryPath: string, signal?: AbortSignal): Promise<string | null> {
    try {
      const result = await this.options.runner.run(binaryPath, ['--version'], {
        timeoutMs: 30_000,
        ...(signal ? { signal } : {}),
      });
      if (result.exitCode !== 0) return null;
      const version = result.stdout.trim().split('\n')[0]?.trim() ?? '';
      return version === '' ? null : version;
    } catch {
      return null;
    }
  }

  /**
   * Keeps the checksum manifest truthful.
   *
   * The resolver reports a mismatch as tampering, so an update that changed the
   * binary without updating its recorded hash would make every later start warn
   * about a file this app wrote itself.
   */
  private async recordInManifest(binaryPath: string, version: string): Promise<void> {
    const manifestPath = join(this.options.overrideRoot, 'bin', 'manifest.json');
    const key = `${platformDir(this.platform, this.arch)}/${binaryFilename('yt-dlp', this.platform)}`;

    let manifest: SidecarManifest = { files: {}, sources: {} };
    if (existsSync(manifestPath)) {
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as SidecarManifest;
      } catch {
        // A corrupt manifest is replaced rather than allowed to block updates.
      }
    }

    const next: SidecarManifest = {
      files: { ...manifest.files, [key]: await sha256File(binaryPath) },
      sources: { ...manifest.sources, [key]: `${this.assetUrl} (${version})` },
    };

    writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
  }
}

/**
 * yt-dlp versions are release dates, `YYYY.MM.DD`. Anything older than a couple
 * of weeks is a likely cause of "Unexpected response from webpage request",
 * because that is how quickly TikTok's changes outrun a pinned build.
 */
/** How old an installed build may be before a check is worth making. */
export const EXTRACTOR_STALE_DAYS = 7;

/**
 * Minimum gap between checks, whatever the installed version says.
 */
export const EXTRACTOR_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1_000;

export type CheckDecision =
  | { readonly check: true; readonly reason: 'stale' | 'unknown-version' }
  | { readonly check: false; readonly reason: 'disabled' | 'checked-recently' | 'recent-build' };

/**
 * Whether to ask the release server for a newer extractor.
 *
 * Pure, and separate from the wiring, because the interesting part is a
 * decision with two independent gates and this is where the mistake was: an
 * earlier version judged staleness from the installed version alone, so once
 * upstream stopped publishing the build was permanently "stale" and every
 * launch re-downloaded ~30 MB to be told it already had the latest.
 */
export function shouldCheckExtractor(input: {
  readonly autoUpdate: boolean;
  readonly version: string | null;
  readonly lastCheckedAt: number;
  readonly now: number;
}): CheckDecision {
  if (!input.autoUpdate) return { check: false, reason: 'disabled' };

  if (input.now - input.lastCheckedAt < EXTRACTOR_CHECK_INTERVAL_MS) {
    return { check: false, reason: 'checked-recently' };
  }

  const age = extractorAgeDays(input.version, input.now);
  // An unreadable or absent version is the strongest reason to check, not a
  // reason to skip: it usually means no extractor is installed at all.
  if (age === null) return { check: true, reason: 'unknown-version' };

  return age >= EXTRACTOR_STALE_DAYS
    ? { check: true, reason: 'stale' }
    : { check: false, reason: 'recent-build' };
}

export function extractorAgeDays(version: string | null, now: number = Date.now()): number | null {
  if (!version) return null;
  const match = /^(\d{4})\.(\d{2})\.(\d{2})/.exec(version.trim());
  if (!match) return null;
  const [, year, month, day] = match;
  const released = Date.UTC(Number(year), Number(month) - 1, Number(day));
  if (Number.isNaN(released)) return null;
  return Math.floor((now - released) / (24 * 60 * 60 * 1_000));
}
