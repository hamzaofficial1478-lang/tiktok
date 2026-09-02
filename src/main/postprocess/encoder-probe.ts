import type { Logger } from 'pino';
import type { MediaCapabilities } from '@shared/ipc/contract';
import type { ProcessRunner } from '../resolve/process-runner';
import { encoderCandidates, type EncoderChoice } from './encoder';

/**
 * Which H.264 encoder this computer can actually run.
 *
 * ## The gap this closes
 *
 * `ffmpeg -encoders` answers a question about the *build*, not about the
 * machine. The LGPL builds this app installs are compiled with NVENC, QuickSync,
 * AMF and VAAPI support, so every one of those is listed as available on a
 * laptop with none of the corresponding hardware. The capability probe reads
 * that list, `selectEncoder` takes the first name off it, and the encode fails
 * at run time with a device-initialisation error the moment it starts.
 *
 * That failure is caught, deliberately and correctly: a filter chain misbehaving
 * must never cost somebody a video that downloaded perfectly well. But the
 * consequence is that the conversion to H.264 silently does not happen, the file
 * stays H.265, and it is refused by every upload form — days later, with an
 * error that points nowhere near ffmpeg. The user's report is "the videos are
 * not getting uploaded on Facebook", and nothing in the app disagrees with them.
 *
 * ## How it decides
 *
 * By trying. One frame of black at 64x64 through the real encoder, output
 * discarded — a hundred milliseconds, and it initialises exactly the hardware
 * the real encode would. Anything that cannot start is struck off; the first
 * that works is remembered for the rest of the session.
 *
 * `reject` exists for the case the probe cannot see: an encoder that starts on a
 * test frame and then fails on a real 1080x1920 video (a busy GPU, a session
 * limit, a driver that only falls over under load). The caller that hit it says
 * so, and the next video uses the next encoder down rather than repeating the
 * failure once per item for the rest of the batch.
 */

/** Black, one frame, tiny — enough to make the encoder open its device. */
const TEST_INPUT = ['-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=0.1'];

export interface EncoderProbeOptions {
  readonly ffmpegPath: () => string | null;
  readonly runner: ProcessRunner;
  readonly log?: Logger | undefined;
  /** Overridable so a test does not wait on a real spawn. */
  readonly timeoutMs?: number | undefined;
}

export class EncoderProbe {
  private readonly rejected = new Set<string>();
  private readonly verified = new Map<string, boolean>();

  constructor(private readonly options: EncoderProbeOptions) {}

  /**
   * The encoders worth trying, best first, with the ones known not to work here
   * removed.
   *
   * A list rather than a single answer because the caller falls back through it:
   * the probe removes the encoders that cannot start at all, and the real encode
   * is still the final word on the ones that can.
   */
  async usable(capabilities: MediaCapabilities, preferHardware: boolean): Promise<EncoderChoice[]> {
    const candidates = encoderCandidates(capabilities, preferHardware).filter(
      (candidate) => !this.rejected.has(candidate.name),
    );

    const usable: EncoderChoice[] = [];
    for (const candidate of candidates) {
      if (await this.works(candidate)) usable.push(candidate);
      // Everything after the first working software encoder is a worse choice
      // that will never be reached, so there is no point probing it.
      if (usable.length > 0 && !candidate.hardware) break;
    }
    return usable;
  }

  /**
   * Marks an encoder as unusable after a real encode failed with it.
   *
   * Session-scoped rather than persisted: a GPU that was busy an hour ago is not
   * permanently broken, and a stale "this machine cannot encode" written to disk
   * would be much harder to notice than one extra failed attempt after a
   * restart.
   */
  reject(name: string): void {
    if (this.rejected.has(name)) return;
    this.rejected.add(name);
    this.verified.delete(name);
    this.options.log?.warn({ encoder: name }, 'an encoder failed on a real video; not using it again this session');
  }

  /** For tests, and for a re-probe after ffmpeg is installed or replaced. */
  reset(): void {
    this.rejected.clear();
    this.verified.clear();
  }

  private async works(candidate: EncoderChoice): Promise<boolean> {
    const cached = this.verified.get(candidate.name);
    if (cached !== undefined) return cached;

    const ffmpegPath = this.options.ffmpegPath();
    if (!ffmpegPath) return false;

    const args = [
      '-v',
      'error',
      ...TEST_INPUT,
      '-frames:v',
      '1',
      '-c:v',
      candidate.name,
      '-pix_fmt',
      'yuv420p',
      '-f',
      'null',
      '-',
    ];

    let ok = false;
    try {
      const result = await this.options.runner.run(ffmpegPath, args, {
        timeoutMs: this.options.timeoutMs ?? 20_000,
      });
      ok = result.exitCode === 0;
      if (!ok) {
        this.options.log?.info(
          { encoder: candidate.name, stderr: result.stderr.trim().slice(0, 200) },
          'this build lists an encoder that this machine cannot run',
        );
      }
    } catch (err) {
      this.options.log?.info(
        { encoder: candidate.name, err: err instanceof Error ? err.message : String(err) },
        'could not test an encoder; treating it as unavailable',
      );
      ok = false;
    }

    this.verified.set(candidate.name, ok);
    if (ok) this.options.log?.info({ encoder: candidate.name }, 'encoding with this encoder');
    return ok;
  }
}
