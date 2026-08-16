import { chmodSync, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Logger } from 'pino';
import { AppError } from '@shared/errors';
import type { ProcessRunner } from '../resolve/process-runner';

/**
 * Installing the offline transcriber.
 *
 * Two downloads, and they are separate on purpose: the program that does the
 * work, and the model it does it with. The model is by far the larger of the
 * two and the one worth choosing, so a user who wants better accuracy replaces
 * a file rather than reinstalling anything.
 *
 * ## Why the release is resolved at runtime
 *
 * whisper.cpp's release assets are versioned and their names have changed more
 * than once — the CLI inside was `main` before it was `whisper-cli`. Hard-coding
 * a URL would work until the next release and then fail with a 404 that reads
 * like a network problem. Asking GitHub what the latest release contains and
 * matching by pattern survives a rename, and when nothing matches it can say so
 * precisely instead of guessing.
 */

const RELEASES_API = 'https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest';

/** Where the models are published. Same host for every size. */
const MODEL_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

/**
 * The English models, smallest first.
 *
 * `.en` rather than the multilingual builds: for English they are both smaller
 * and more accurate, because none of the model's capacity is spent on the other
 * ninety-eight languages. Base is the default because it is the point where
 * accuracy stops being the limiting factor for clear speech, and small is there
 * for anyone who would rather spend the time and the disk.
 */
export const WHISPER_MODELS = [
  { id: 'tiny.en', file: 'ggml-tiny.en.bin', approxBytes: 78_000_000, note: 'fastest, least accurate' },
  { id: 'base.en', file: 'ggml-base.en.bin', approxBytes: 148_000_000, note: 'recommended for English' },
  { id: 'small.en', file: 'ggml-small.en.bin', approxBytes: 488_000_000, note: 'most accurate, slowest' },
] as const;

export type WhisperModelId = (typeof WHISPER_MODELS)[number]['id'];

/**
 * The release asset for this platform.
 *
 * Windows is the only platform whisper.cpp publishes a ready-to-run binary for;
 * elsewhere the project expects a build from source. Returning null rather than
 * guessing lets the caller say that plainly instead of downloading something
 * that will not run.
 */
export function pickReleaseAsset(
  assets: readonly { readonly name: string; readonly browser_download_url: string }[],
  platform: NodeJS.Platform = process.platform,
): { readonly name: string; readonly url: string } | null {
  if (platform !== 'win32') return null;

  // Ordered by preference: a plain x64 build before any variant carrying a
  // vendor runtime, which are larger and only help on specific hardware.
  const patterns = [/^whisper-bin-x64\.zip$/i, /^whisper-.*x64.*\.zip$/i, /^whisper-bin.*\.zip$/i];

  for (const pattern of patterns) {
    const match = assets.find((asset) => pattern.test(asset.name));
    if (match) return { name: match.name, url: match.browser_download_url };
  }
  return null;
}

/**
 * The CLI inside an extracted release.
 *
 * The name changed from `main` to `whisper-cli`, and both are still in the
 * wild, so this looks for either rather than pinning the one that happened to
 * be current when it was written.
 */
export function findWhisperBinary(directory: string, platform: NodeJS.Platform = process.platform): string | null {
  const suffix = platform === 'win32' ? '.exe' : '';
  const candidates = [`whisper-cli${suffix}`, `main${suffix}`, `whisper${suffix}`];

  const walk = (dir: string, depth = 0): string | null => {
    if (depth > 3) return null;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return null;
    }

    for (const name of candidates) {
      if (entries.includes(name)) return join(dir, name);
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        const found = walk(full, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };

  return walk(directory);
}

export interface WhisperInstallProgress {
  readonly phase: 'resolving' | 'downloading-program' | 'downloading-model' | 'extracting' | 'verifying' | 'done';
  readonly receivedBytes: number;
  readonly totalBytes: number | null;
  readonly message: string;
}

export interface WhisperInstallerOptions {
  /** Where the binary and model are kept; under userData, never in Program Files. */
  readonly root: string;
  readonly runner: ProcessRunner;
  readonly fetchImpl?: typeof fetch;
  readonly onProgress?: (progress: WhisperInstallProgress) => void;
  readonly log?: Logger;
}

export interface WhisperPaths {
  readonly binaryPath: string | null;
  readonly modelPath: string | null;
  readonly modelId: WhisperModelId | null;
}

export class WhisperInstaller {
  constructor(private readonly options: WhisperInstallerOptions) {}

  private get dir(): string {
    return join(this.options.root, 'whisper');
  }

  /** What is installed right now, without touching the network. */
  status(): WhisperPaths {
    const binary = findWhisperBinary(this.dir);

    for (const model of WHISPER_MODELS) {
      const path = join(this.dir, model.file);
      // A partial download is not an installed model; size is the cheapest
      // check that catches one, and half a model fails with a parse error
      // deep inside whisper rather than anything a user could act on.
      if (existsSync(path) && statSync(path).size > model.approxBytes * 0.5) {
        return { binaryPath: binary, modelPath: path, modelId: model.id };
      }
    }
    return { binaryPath: binary, modelPath: null, modelId: null };
  }

  async install(modelId: WhisperModelId = 'base.en'): Promise<WhisperPaths> {
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
    const report = (progress: WhisperInstallProgress): void => this.options.onProgress?.(progress);
    mkdirSync(this.dir, { recursive: true });

    if (!findWhisperBinary(this.dir)) {
      report({ phase: 'resolving', receivedBytes: 0, totalBytes: null, message: 'finding the latest release' });

      const response = await fetchImpl(RELEASES_API, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'tiktok-downloader' },
      });
      if (!response.ok) {
        throw new AppError('NETWORK_ERROR', `could not reach GitHub to find the transcriber (${response.status})`);
      }

      const release = (await response.json()) as {
        tag_name?: string;
        assets?: { name: string; browser_download_url: string }[];
      };
      const asset = pickReleaseAsset(release.assets ?? []);

      if (!asset) {
        throw new AppError(
          'UNSUPPORTED_MEDIA',
          process.platform === 'win32'
            ? `the latest whisper.cpp release (${release.tag_name ?? 'unknown'}) has no Windows build to install`
            : 'a ready-made transcriber is only published for Windows; on this platform whisper.cpp must be built from source',
        );
      }

      const archive = join(this.dir, asset.name);
      await this.download(asset.url, archive, (received, total) =>
        report({ phase: 'downloading-program', receivedBytes: received, totalBytes: total, message: asset.name }),
      );

      report({ phase: 'extracting', receivedBytes: 0, totalBytes: null, message: 'unpacking' });
      await this.extract(archive);
      rmSync(archive, { force: true });
    }

    const model = WHISPER_MODELS.find((entry) => entry.id === modelId) ?? WHISPER_MODELS[1];
    const modelPath = join(this.dir, model.file);

    if (!existsSync(modelPath) || statSync(modelPath).size < model.approxBytes * 0.5) {
      await this.download(`${MODEL_BASE}/${model.file}`, modelPath, (received, total) =>
        report({
          phase: 'downloading-model',
          receivedBytes: received,
          totalBytes: total,
          message: `${model.id} — ${model.note}`,
        }),
      );
    }

    report({ phase: 'verifying', receivedBytes: 0, totalBytes: null, message: 'checking it runs' });
    const status = this.status();
    if (!status.binaryPath || !status.modelPath) {
      throw new AppError('EXTRACTOR_FAILED', 'the transcriber was downloaded but could not be found afterwards');
    }

    // Run it once before claiming it is installed. A binary that unpacked but
    // cannot start — a missing runtime DLL is the usual cause on Windows — is
    // better discovered here than on the first video of a batch.
    const check = await this.options.runner.run(status.binaryPath, ['--help'], { timeoutMs: 30_000 });
    if (check.exitCode !== 0 && !/usage/i.test(check.stdout + check.stderr)) {
      throw new AppError(
        'EXTRACTOR_FAILED',
        `the transcriber was installed but will not run: ${check.stderr.trim().slice(0, 200)}`,
      );
    }

    report({ phase: 'done', receivedBytes: 0, totalBytes: null, message: `${model.id} ready` });
    return status;
  }

  /** Streams to a `.part` and renames, so an interrupted download is never mistaken for a finished one. */
  private async download(url: string, target: string, onProgress: (received: number, total: number | null) => void): Promise<void> {
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
    const response = await fetchImpl(url, { redirect: 'follow' });
    if (!response.ok || !response.body) {
      throw new AppError('NETWORK_ERROR', `could not download ${url.split('/').pop()} (${response.status})`);
    }

    const total = Number(response.headers.get('content-length') ?? '');
    const partPath = `${target}.part`;
    let received = 0;

    const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    source.on('data', (chunk: Buffer) => {
      received += chunk.length;
      onProgress(received, Number.isFinite(total) && total > 0 ? total : null);
    });

    await pipeline(source, createWriteStream(partPath));
    renameSync(partPath, target);
    if (process.platform !== 'win32') chmodSync(target, 0o755);
  }

  /** Windows ships tar, and it reads zips; nothing else needs installing. */
  private async extract(archive: string): Promise<void> {
    const result = await this.options.runner.run('tar', ['-xf', archive, '-C', this.dir], { timeoutMs: 5 * 60_000 });
    if (result.exitCode !== 0) {
      throw new AppError('EXTRACTOR_FAILED', `could not unpack the transcriber: ${result.stderr.slice(0, 200)}`);
    }
  }
}
