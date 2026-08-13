import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError } from '@shared/errors';
import type { Logger } from 'pino';
import { binaryFilename, platformDir, sha256File, type SidecarManifest } from './sidecars';
import type { ProcessRunner } from '../resolve/process-runner';

/**
 * Installing ffmpeg and ffprobe, from inside the app.
 *
 * Watermark filtering and end-card trimming both need ffmpeg, and until now the
 * answer to not having it was a documentation page telling the user to find a
 * build and write a JSON file. That is not a feature anyone can ship: it makes
 * two of the product's headline behaviours conditional on the user doing manual
 * work most of them will never do.
 *
 * ## Which build, and why it is not a licensing problem
 *
 * BtbN's FFmpeg-Builds publishes an explicit **LGPL** variant alongside its GPL
 * one. An earlier version of this project's notes asserted that every
 * convenient prebuild was GPL and therefore unusable; that was simply wrong,
 * and it is what forced the manual step. The LGPL build was verified to carry
 * exactly what the pipeline needs and none of what it must avoid:
 *
 *   - no `--enable-gpl` in its build configuration
 *   - `removelogo`, `gblur`, `overlay`, `crop`, `split` all present
 *   - `delogo` and `boxblur` absent, which is the confirmation that it is
 *     genuinely the LGPL build and not a mislabelled GPL one
 *   - libopenh264 plus the nvenc/qsv/amf/vaapi hardware encoders
 *
 * ## Extraction
 *
 * Archives are unpacked with the system `tar`, which reads both .zip and
 * .tar.xz: bsdtar has shipped in Windows since 10, and macOS and Linux have
 * always had one. That avoids adding an archive dependency to the app for a
 * step that runs at most once.
 */

interface FfmpegSource {
  readonly url: string;
  /** For the log and the error message when a platform has no source. */
  readonly label: string;
}

const BTBN = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest';

const SOURCES: Readonly<Record<string, FfmpegSource>> = {
  'win32-x64': { url: `${BTBN}/ffmpeg-master-latest-win64-lgpl.zip`, label: 'BtbN win64 LGPL' },
  'linux-x64': { url: `${BTBN}/ffmpeg-master-latest-linux64-lgpl.tar.xz`, label: 'BtbN linux64 LGPL' },
  'linux-arm64': { url: `${BTBN}/ffmpeg-master-latest-linuxarm64-lgpl.tar.xz`, label: 'BtbN linuxarm64 LGPL' },
};

/** An ffmpeg archive is ~100 MB; wildly outside that is not the archive. */
const MIN_PLAUSIBLE_BYTES = 5_000_000;
const MAX_PLAUSIBLE_BYTES = 600 * 1024 * 1024;

export type InstallPhase = 'downloading' | 'extracting' | 'verifying';

export interface InstallProgress {
  readonly phase: InstallPhase;
  readonly receivedBytes: number;
  readonly totalBytes: number | null;
}

export interface FfmpegInstallerOptions {
  /** Writable root holding `bin/` — userData, never the install directory. */
  readonly overrideRoot: string;
  readonly runner: ProcessRunner;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly fetchImpl?: typeof fetch;
  readonly log?: Logger;
}

export interface InstallResult {
  readonly installed: boolean;
  readonly version: string | null;
  readonly message: string;
}

export class FfmpegInstaller {
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;

  constructor(private readonly options: FfmpegInstallerOptions) {
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
  }

  /** True when this platform has a build we can fetch without the user's help. */
  get isSupported(): boolean {
    return SOURCES[`${this.platform}-${this.arch}`] !== undefined;
  }

  targetPath(name: 'ffmpeg' | 'ffprobe'): string {
    return join(
      this.options.overrideRoot,
      'bin',
      platformDir(this.platform, this.arch),
      binaryFilename(name, this.platform),
    );
  }

  async install(onProgress?: (progress: InstallProgress) => void, signal?: AbortSignal): Promise<InstallResult> {
    const key = `${this.platform}-${this.arch}`;
    const source = SOURCES[key];
    if (!source) {
      throw new AppError(
        'FFMPEG_FAILED',
        `no automatic ffmpeg build is available for ${key}. Install ffmpeg yourself and put it on PATH, or see docs/SIDECARS.md.`,
      );
    }

    const workDir = mkdtempSync(join(tmpdir(), 'ffmpeg-install-'));
    try {
      const archive = join(workDir, source.url.endsWith('.zip') ? 'ffmpeg.zip' : 'ffmpeg.tar.xz');
      await this.download(source, archive, onProgress, signal);

      onProgress?.({ phase: 'extracting', receivedBytes: 0, totalBytes: null });
      await this.extract(archive, workDir, signal);

      const found = findBinaries(workDir, this.platform);
      if (!found.ffmpeg || !found.ffprobe) {
        throw new AppError('FFMPEG_FAILED', 'the archive did not contain ffmpeg and ffprobe where expected');
      }

      onProgress?.({ phase: 'verifying', receivedBytes: 0, totalBytes: null });
      const version = await this.installBoth(found.ffmpeg, found.ffprobe, signal);

      this.options.log?.info({ version, source: source.label }, 'ffmpeg installed');
      return { installed: true, version, message: `Installed ffmpeg ${version ?? ''} (${source.label}).`.trim() };
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }

  private async download(
    source: FfmpegSource,
    destination: string,
    onProgress?: (progress: InstallProgress) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;

    let response: Response;
    try {
      response = await fetchImpl(source.url, { redirect: 'follow', ...(signal ? { signal } : {}) });
    } catch (err) {
      throw new AppError(
        'FFMPEG_FAILED',
        `could not reach the ffmpeg download server: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    if (!response.ok) {
      throw new AppError('FFMPEG_FAILED', `the download server returned ${response.status} for ${source.url}`);
    }

    const total = Number(response.headers.get('content-length') ?? '');
    const totalBytes = Number.isFinite(total) && total > 0 ? total : null;

    const bytes = Buffer.from(await response.arrayBuffer());
    onProgress?.({ phase: 'downloading', receivedBytes: bytes.length, totalBytes });

    if (bytes.length < MIN_PLAUSIBLE_BYTES || bytes.length > MAX_PLAUSIBLE_BYTES) {
      throw new AppError(
        'FFMPEG_FAILED',
        `the download was ${bytes.length} bytes, which is not an ffmpeg archive — a proxy or captive portal may have replaced it`,
      );
    }

    writeFileSync(destination, bytes);
  }

  private async extract(archive: string, into: string, signal?: AbortSignal): Promise<void> {
    const result = await this.options.runner.run('tar', ['-xf', archive, '-C', into], {
      timeoutMs: 5 * 60_000,
      ...(signal ? { signal } : {}),
    });

    if (result.exitCode !== 0) {
      throw new AppError(
        'FFMPEG_FAILED',
        `could not unpack the ffmpeg archive: ${result.stderr.trim() || `tar exited ${result.exitCode}`}`,
      );
    }
  }

  /**
   * Moves both binaries into place only once ffmpeg has proven it runs.
   *
   * Half an install is worse than none: an ffmpeg present but broken makes the
   * capability probe report a build with no filters, which reads as "your
   * machine cannot do watermark removal" rather than "the download failed".
   */
  private async installBoth(ffmpegSrc: string, ffprobeSrc: string, signal?: AbortSignal): Promise<string | null> {
    if (this.platform !== 'win32') {
      chmodSync(ffmpegSrc, 0o755);
      chmodSync(ffprobeSrc, 0o755);
    }

    const version = await this.probeVersion(ffmpegSrc, signal);
    if (version === null) {
      throw new AppError('FFMPEG_FAILED', 'the downloaded ffmpeg did not run on this machine');
    }

    const targets: [string, string][] = [
      [ffmpegSrc, this.targetPath('ffmpeg')],
      [ffprobeSrc, this.targetPath('ffprobe')],
    ];

    mkdirSync(join(this.options.overrideRoot, 'bin', platformDir(this.platform, this.arch)), { recursive: true });

    for (const [from, to] of targets) {
      // A cross-device rename fails, and the temp directory is routinely on a
      // different filesystem, so fall back to a copy.
      try {
        renameSync(from, to);
      } catch {
        writeFileSync(to, readFileSync(from));
        if (this.platform !== 'win32') chmodSync(to, 0o755);
      }
    }

    await this.recordInManifest();
    return version;
  }

  private async probeVersion(binaryPath: string, signal?: AbortSignal): Promise<string | null> {
    try {
      const result = await this.options.runner.run(binaryPath, ['-hide_banner', '-version'], {
        timeoutMs: 30_000,
        ...(signal ? { signal } : {}),
      });
      if (result.exitCode !== 0) return null;
      return /^ffmpeg version (\S+)/m.exec(result.stdout)?.[1] ?? null;
    } catch {
      return null;
    }
  }

  private async recordInManifest(): Promise<void> {
    const manifestPath = join(this.options.overrideRoot, 'bin', 'manifest.json');

    let manifest: SidecarManifest = { files: {}, sources: {} };
    if (existsSync(manifestPath)) {
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as SidecarManifest;
      } catch {
        // A corrupt manifest is replaced rather than allowed to block installs.
      }
    }

    const files = { ...manifest.files };
    const sources = { ...manifest.sources };
    const source = SOURCES[`${this.platform}-${this.arch}`];

    for (const name of ['ffmpeg', 'ffprobe'] as const) {
      const path = this.targetPath(name);
      if (!existsSync(path)) continue;
      const key = `${platformDir(this.platform, this.arch)}/${binaryFilename(name, this.platform)}`;
      files[key] = await sha256File(path);
      if (source) sources[key] = source.url;
    }

    writeFileSync(manifestPath, `${JSON.stringify({ files, sources }, null, 2)}\n`);
  }
}

/**
 * Finds ffmpeg and ffprobe anywhere in an extracted tree.
 *
 * The archive nests them under a versioned directory whose name changes with
 * every build (`ffmpeg-master-latest-win64-lgpl/bin/…`), so hard-coding the
 * path would break on the next release. Exported for its own test: this is the
 * step most likely to break silently when upstream rearranges an archive.
 */
export function findBinaries(
  root: string,
  platform: NodeJS.Platform,
): { ffmpeg: string | null; ffprobe: string | null } {
  const wanted = new Map([
    [binaryFilename('ffmpeg', platform), 'ffmpeg' as const],
    [binaryFilename('ffprobe', platform), 'ffprobe' as const],
  ]);
  const found: { ffmpeg: string | null; ffprobe: string | null } = { ffmpeg: null, ffprobe: null };

  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const path = join(dir, entry);
      let stats;
      try {
        stats = statSync(path);
      } catch {
        continue;
      }

      if (stats.isDirectory()) {
        walk(path, depth + 1);
        continue;
      }

      const which = wanted.get(entry);
      // Guard against a same-named text file — a licence or a man page — being
      // mistaken for the executable.
      if (which && found[which] === null && stats.size > 100_000) found[which] = path;
    }
  };

  walk(root, 0);
  return found;
}
