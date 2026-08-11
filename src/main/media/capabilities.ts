import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Logger } from 'pino';
import type { MediaCapabilities } from '@shared/ipc/contract';

const execFileAsync = promisify(execFile);

/**
 * ffmpeg capability probe.
 *
 * This exists because of a verified conflict in the brief: section 3 requires
 * an LGPL ffmpeg build for a closed-source commercial product, but the filters
 * named in section 9 — `delogo` and `boxblur` — are both gated on `--enable-gpl`
 * in ffmpeg's own configure:
 *
 *     boxblur_filter_deps="gpl"
 *     delogo_filter_deps="gpl"
 *
 * An LGPL build simply does not contain them, so that filter chain would fail
 * at runtime on the only build we are allowed to ship. The LGPL-clean
 * replacements below were checked to support the timeline `enable=` flag, which
 * is what the time-segmented watermark approach depends on:
 *
 *     removelogo  interpolates from the region border, like delogo   (LGPL)
 *     gblur       tier-2 blur, replaces boxblur                      (LGPL)
 *     overlay     composites the treated region back                 (LGPL)
 *     crop/split  isolate the region to treat                        (LGPL)
 *
 * Probing at startup rather than trusting the build means a wrong or partial
 * ffmpeg is caught immediately, with a precise list of what is missing, instead
 * of surfacing as FFMPEG_FAILED on item 173 of a 300-item batch.
 */

/** Filters the watermark and outro pipelines require. All are LGPL-safe. */
export const REQUIRED_FILTERS = ['removelogo', 'gblur', 'overlay', 'crop', 'split', 'scale', 'trim'] as const;

/** Nice-to-have, probed for diagnostics rather than required. */
export const OPTIONAL_FILTERS = ['avgblur', 'boxblur', 'delogo', 'blackframe', 'silencedetect'] as const;

/**
 * At least one must exist for the re-encode fallback path (section 3: use
 * hardware encoders or OpenH264, never libx264, which is GPL).
 */
export const ENCODER_CANDIDATES = [
  'h264_nvenc',
  'h264_qsv',
  'h264_videotoolbox',
  'h264_amf',
  'h264_vaapi',
  'libopenh264',
  'mpeg4',
] as const;

export interface ProbeOptions {
  ffmpegPath: string | null;
  log?: Logger;
  timeoutMs?: number;
}

export const EMPTY_CAPABILITIES: MediaCapabilities = {
  probed: false,
  isGplBuild: null,
  filters: {},
  encoders: {},
  missingRequired: [],
};

/** Parses `ffmpeg -filters` / `-encoders` output; both list the name in column 2. */
function parseNames(stdout: string): Set<string> {
  const names = new Set<string>();
  for (const line of stdout.split('\n')) {
    const match = /^\s*[A-Z.]+\s+(\S+)/.exec(line);
    if (match?.[1]) names.add(match[1]);
  }
  return names;
}

export async function probeCapabilities(options: ProbeOptions): Promise<MediaCapabilities> {
  const { ffmpegPath } = options;
  if (!ffmpegPath) return EMPTY_CAPABILITIES;

  const timeout = options.timeoutMs ?? 15_000;
  const run = async (args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync(ffmpegPath, ['-hide_banner', ...args], {
      timeout,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  };

  try {
    const [filterOut, encoderOut, buildconf] = await Promise.all([
      run(['-filters']),
      run(['-encoders']),
      run(['-buildconf']).catch(() => ''),
    ]);

    const availableFilters = parseNames(filterOut);
    const availableEncoders = parseNames(encoderOut);

    const filters: Record<string, boolean> = {};
    for (const name of [...REQUIRED_FILTERS, ...OPTIONAL_FILTERS]) filters[name] = availableFilters.has(name);

    const encoders: Record<string, boolean> = {};
    for (const name of ENCODER_CANDIDATES) encoders[name] = availableEncoders.has(name);

    const missingRequired: string[] = REQUIRED_FILTERS.filter((f) => !availableFilters.has(f));
    if (!ENCODER_CANDIDATES.some((e) => availableEncoders.has(e))) {
      missingRequired.push('an H.264 encoder (hardware or libopenh264)');
    }

    // A GPL build is a licensing problem for a commercial release, not a
    // technical one — it is surfaced, not blocked, so a developer can still
    // run against a distro ffmpeg while the LGPL build is sourced.
    const isGplBuild = buildconf ? /--enable-gpl\b/.test(buildconf) : null;

    if (isGplBuild) {
      options.log?.warn(
        'ffmpeg reports --enable-gpl. A GPL build must not ship in the commercial product; see section 3 of the brief.',
      );
    }
    if (missingRequired.length > 0) {
      options.log?.error({ missingRequired }, 'ffmpeg build is missing required capabilities');
    }

    return { probed: true, isGplBuild, filters, encoders, missingRequired };
  } catch (err) {
    options.log?.error({ err: String(err) }, 'ffmpeg capability probe failed');
    return EMPTY_CAPABILITIES;
  }
}
