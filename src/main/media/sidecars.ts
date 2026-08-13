import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { access, constants } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Logger } from 'pino';
import type { SidecarStatus } from '@shared/ipc/contract';

const execFileAsync = promisify(execFile);

export const SIDECAR_NAMES = ['ffmpeg', 'ffprobe', 'yt-dlp'] as const;
export type SidecarName = (typeof SIDECAR_NAMES)[number];

/**
 * Sidecar binaries — spec section 2: ship yt-dlp as a bundled binary, never as
 * a package dependency, so "Update extractor" can replace it independently of
 * an app release.
 *
 * Layout under `<resources>/bin/`:
 *
 *   bin/manifest.json
 *   bin/win32-x64/{ffmpeg.exe,ffprobe.exe,yt-dlp.exe}
 *   bin/darwin-arm64/{ffmpeg,ffprobe,yt-dlp}
 *   bin/darwin-x64/…
 *   bin/linux-x64/…
 *
 * The binaries are not committed to the repository — they are fetched by
 * `scripts/fetch-sidecars.mjs` and verified against manifest.json. This module
 * only resolves and validates them, which is why it is testable with stub
 * files that contain no actual ffmpeg.
 */

export function platformDir(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  return `${platform}-${arch}`;
}

export function binaryFilename(name: SidecarName, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `${name}.exe` : name;
}

export interface SidecarManifest {
  /** `"<platform>-<arch>/<filename>"` -> lowercase hex sha256. */
  readonly files: Readonly<Record<string, string>>;
  /** Informational: which upstream release each binary came from. */
  readonly sources?: Readonly<Record<string, string>>;
}

export interface SidecarResolverOptions {
  /** Root that contains `bin/` — the repo's `resources/` in dev, `process.resourcesPath` when packaged. */
  resourcesRoot: string;
  /**
   * Writable root that holds updated binaries, checked before the bundled
   * ones. userData in the app; omitted in tests that only exercise bundling.
   */
  overrideRoot?: string;
  /**
   * Allow falling back to a binary on PATH when the bundled one is absent.
   * On in development; a packaged build must use its own binaries so that what
   * we test is what the user runs.
   */
  allowPathFallback?: boolean;
  platform?: NodeJS.Platform;
  arch?: string;
  log?: Logger;
}

export interface ResolvedSidecar {
  readonly name: SidecarName;
  readonly path: string | null;
  readonly source: 'updated' | 'bundled' | 'path' | 'missing';
}

/** Locate an executable on PATH without shelling out (`which`/`where` are not portable). */
function findOnPath(filename: string, platform: NodeJS.Platform): string | null {
  const pathEnv = process.env['PATH'] ?? '';
  const exts = platform === 'win32' ? (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, filename.endsWith(ext.toLowerCase()) ? filename : `${filename}${ext.toLowerCase()}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export class SidecarResolver {
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly manifest: SidecarManifest | null;

  constructor(private readonly options: SidecarResolverOptions) {
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.manifest = this.loadManifest();
  }

  private get binRoot(): string {
    return join(this.options.resourcesRoot, 'bin');
  }

  private loadManifest(): SidecarManifest | null {
    const file = join(this.binRoot, 'manifest.json');
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as SidecarManifest;
    } catch (err) {
      this.options.log?.warn({ err: String(err) }, 'sidecar manifest unreadable');
      return null;
    }
  }

  resolve(name: SidecarName): ResolvedSidecar {
    const filename = binaryFilename(name, this.platform);

    /**
     * An updated binary wins over the bundled one.
     *
     * Updates are written under userData because an installed app sits in a
     * directory the user cannot write to. If the bundled copy were still
     * preferred here, "Update extractor" would download successfully and then
     * change nothing, which is worse than failing.
     */
    if (this.options.overrideRoot) {
      const updated = join(this.options.overrideRoot, 'bin', platformDir(this.platform, this.arch), filename);
      if (existsSync(updated)) return { name, path: updated, source: 'updated' };
    }

    const bundled = join(this.binRoot, platformDir(this.platform, this.arch), filename);
    if (existsSync(bundled)) return { name, path: bundled, source: 'bundled' };

    if (this.options.allowPathFallback !== false) {
      const onPath = findOnPath(filename, this.platform);
      if (onPath) return { name, path: onPath, source: 'path' };
    }

    return { name, path: null, source: 'missing' };
  }

  /**
   * Full status for one sidecar: present, executable, checksum-valid, version.
   *
   * A checksum mismatch is reported rather than thrown. The distinction the UI
   * needs is "missing" versus "modified" versus "fine", and a hard throw here
   * would take the whole Settings screen down over one bad file.
   */
  async status(name: SidecarName): Promise<SidecarStatus> {
    const resolved = this.resolve(name);
    if (!resolved.path) {
      return {
        name,
        path: null,
        present: false,
        checksumValid: null,
        version: null,
        error: `${name} is not installed. Run the sidecar fetch script, or reinstall the app.`,
      };
    }

    try {
      await access(resolved.path, constants.X_OK);
    } catch {
      return {
        name,
        path: resolved.path,
        present: true,
        checksumValid: null,
        version: null,
        error: `${name} is present but not executable.`,
      };
    }

    // Only bundled binaries are covered by the manifest; one found on PATH is
    // the developer's own and is intentionally not checksummed.
    let checksumValid: boolean | null = null;
    if (resolved.source === 'bundled' && this.manifest) {
      const key = `${platformDir(this.platform, this.arch)}/${binaryFilename(name, this.platform)}`;
      const expected = this.manifest.files[key];
      if (expected) checksumValid = (await sha256File(resolved.path)) === expected.toLowerCase();
    }

    const version = await this.version(name, resolved.path);
    return {
      name,
      path: resolved.path,
      present: true,
      checksumValid,
      version,
      error: checksumValid === false ? `${name} does not match its expected checksum and may be corrupt.` : null,
    };
  }

  async statusAll(): Promise<SidecarStatus[]> {
    return Promise.all(SIDECAR_NAMES.map((n) => this.status(n)));
  }

  private async version(name: SidecarName, binPath: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(binPath, ['-version'], { timeout: 10_000, windowsHide: true });
      if (name === 'yt-dlp') return stdout.trim().split('\n')[0]?.trim() ?? null;
      // "ffmpeg version 7.1 Copyright (c) …" -> "7.1"
      return /^ffmpeg version (\S+)/m.exec(stdout)?.[1] ?? stdout.trim().split('\n')[0] ?? null;
    } catch {
      // yt-dlp uses --version, not -version.
      try {
        const { stdout } = await execFileAsync(binPath, ['--version'], { timeout: 10_000, windowsHide: true });
        return stdout.trim().split('\n')[0]?.trim() ?? null;
      } catch {
        return null;
      }
    }
  }
}
