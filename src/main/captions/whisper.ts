import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { AppError } from '@shared/errors';
import type { ProcessRunner } from '../resolve/process-runner';
import type { Cue, CueWord } from './cues';

/**
 * Speech to captions, offline.
 *
 * whisper.cpp rather than an API: no key to manage, no per-video cost, nothing
 * leaving the machine, and it keeps working on a laptop with no internet. The
 * cost is a one-time model download and CPU time per video, both of which are
 * visible and finite.
 *
 * ## Why the audio is extracted first
 *
 * whisper.cpp reads 16 kHz mono PCM and nothing else. Handing it an MP4 gets a
 * refusal, so ffmpeg — already installed for watermark work — converts first.
 * That conversion is also where the audio track gets normalised to one channel,
 * which is what the model was trained on; downmixing later would be worse.
 */

/** What the model was trained on. Anything else is resampled by ffmpeg first. */
export const WHISPER_SAMPLE_RATE = 16_000;

export interface WhisperOptions {
  readonly binaryPath: string | null;
  readonly modelPath: string | null;
  readonly ffmpegPath: string | null;
  readonly runner: ProcessRunner;
  /** Physical cores to use. Whisper is CPU-bound and scales close to linearly. */
  readonly threads?: number;
  readonly log?: Logger;
}

export interface TranscribeInput {
  readonly filePath: string;
  /** Whisper's translate task, which targets English and only English. */
  readonly translateToEnglish: boolean;
  readonly signal?: AbortSignal;
}

/**
 * whisper.cpp's `--output-json-full` shape, narrowed to what is read.
 *
 * The token list is the reason for asking for the full form: it carries a
 * per-token offset, and word-level timing is what the word-by-word caption
 * styles need. Sentence-level JSON would be smaller and useless for that.
 */
interface WhisperJson {
  readonly transcription?: readonly {
    readonly offsets?: { readonly from?: number; readonly to?: number };
    readonly text?: string;
    readonly tokens?: readonly {
      readonly text?: string;
      readonly offsets?: { readonly from?: number; readonly to?: number };
    }[];
  }[];
}

/**
 * Builds the ffmpeg call that produces what whisper.cpp can read.
 *
 * `-vn` matters more than it looks: without it ffmpeg decodes the video track
 * to throw it away, which on a long clip is most of the time spent here.
 */
export function audioExtractArgs(inputPath: string, outputPath: string): readonly string[] {
  return [
    '-v',
    'error',
    '-i',
    inputPath,
    '-vn',
    '-ac',
    '1',
    '-ar',
    String(WHISPER_SAMPLE_RATE),
    '-c:a',
    'pcm_s16le',
    '-y',
    outputPath,
  ];
}

export function transcribeArgs(input: {
  readonly modelPath: string;
  readonly audioPath: string;
  readonly outputPrefix: string;
  readonly translateToEnglish: boolean;
  readonly threads: number;
  readonly english: boolean;
}): readonly string[] {
  const args = [
    '-m',
    input.modelPath,
    '-f',
    input.audioPath,
    '--output-json-full',
    '--output-file',
    input.outputPrefix,
    '-t',
    String(input.threads),
    // Printing every segment as it is recognised doubles the output for no
    // benefit; the JSON is what gets read.
    '--no-prints',
  ];

  /**
   * Telling it the language rather than letting it detect one.
   *
   * Detection costs a pass over the first thirty seconds and gets it wrong on
   * short clips with music under the speech — which is most of TikTok. An
   * English-only model cannot do anything else anyway, so saying so is free.
   */
  if (input.english) args.push('-l', 'en');
  else args.push('-l', 'auto');

  /**
   * The translate task, and only when it would do something.
   *
   * Asking an English-only model to translate into English is a contradiction
   * — it has no other language to translate from — and whisper.cpp handles it
   * by producing worse output rather than by refusing. The guard belongs here
   * rather than at the call site, where it could be forgotten.
   */
  if (input.translateToEnglish && !input.english) args.push('--translate');

  return args;
}

/**
 * Turns whisper.cpp's JSON into cues with word timings.
 *
 * Tokens are not words: the model emits sub-word pieces, and a leading space
 * is how it marks a word boundary. Joining on that rule is what turns
 * `[" pra", "ctice"]` into one word with one start and one end, rather than
 * two highlights firing mid-syllable.
 */
export function parseWhisperJson(raw: string): readonly Cue[] {
  let payload: WhisperJson;
  try {
    payload = JSON.parse(raw) as WhisperJson;
  } catch (err) {
    throw new AppError('FFMPEG_FAILED', 'the transcriber produced output that could not be read', { cause: err });
  }

  const cues: Cue[] = [];

  for (const segment of payload.transcription ?? []) {
    const text = (segment.text ?? '').trim();
    const startMs = segment.offsets?.from ?? 0;
    const endMs = segment.offsets?.to ?? startMs;
    if (text === '' || endMs <= startMs) continue;

    // Whisper marks silence and noise with bracketed labels; they are not
    // speech and burning "[Music]" onto a video is not a caption.
    if (/^[[(].*[\])]$/.test(text)) continue;

    const words = groupTokensIntoWords(segment.tokens ?? []);
    cues.push({ startMs, endMs, lines: [text], ...(words.length > 0 ? { words } : {}) });
  }

  return cues;
}

export function groupTokensIntoWords(
  tokens: readonly { text?: string; offsets?: { from?: number; to?: number } }[],
): readonly CueWord[] {
  const words: CueWord[] = [];

  for (const token of tokens) {
    const raw = token.text ?? '';
    // Special tokens carry timing but no text worth showing.
    if (raw === '' || /^\[_[A-Z]+_/.test(raw) || /^<\|.*\|>$/.test(raw)) continue;

    const startsWord = raw.startsWith(' ') || words.length === 0;
    const text = raw.trim();
    if (text === '') continue;

    const from = token.offsets?.from ?? 0;
    const to = token.offsets?.to ?? from;

    const previous = words[words.length - 1];
    if (startsWord || !previous) {
      words.push({ text, startMs: from, endMs: to });
      continue;
    }
    // A continuation piece extends the word it belongs to.
    words[words.length - 1] = { text: `${previous.text}${text}`, startMs: previous.startMs, endMs: to };
  }

  return words.filter((word) => word.endMs > word.startMs || word.text !== '');
}

export class WhisperTranscriber {
  constructor(private readonly options: WhisperOptions) {}

  get available(): boolean {
    return this.options.binaryPath !== null && this.options.modelPath !== null;
  }

  async transcribe(input: TranscribeInput): Promise<readonly Cue[] | null> {
    const { binaryPath, modelPath, ffmpegPath } = this.options;
    if (!binaryPath || !modelPath) return null;
    if (!ffmpegPath) {
      throw new AppError('FFMPEG_FAILED', 'ffmpeg is needed to prepare audio for transcription');
    }

    // A directory of our own: whisper writes its JSON next to the prefix it is
    // given, and the user's output folder should never gain either file.
    const workDir = mkdtempSync(join(tmpdir(), 'tiktok-whisper-'));
    const audioPath = join(workDir, 'audio.wav');
    const outputPrefix = join(workDir, 'transcript');

    try {
      const extract = await this.options.runner.run(ffmpegPath, audioExtractArgs(input.filePath, audioPath), {
        timeoutMs: 5 * 60_000,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (extract.exitCode !== 0) {
        // A video with no audio track is not an error, it is a silent video.
        this.options.log?.info({ stderr: extract.stderr.slice(0, 200) }, 'no audio could be extracted');
        return null;
      }

      const english = /\.en\.bin$/i.test(modelPath);
      const result = await this.options.runner.run(
        binaryPath,
        transcribeArgs({
          modelPath,
          audioPath,
          outputPrefix,
          translateToEnglish: input.translateToEnglish,
          threads: this.options.threads ?? 4,
          english,
        }),
        {
          /**
           * Generous, and deliberately so. Transcription is CPU-bound and a
           * slower machine can take several times the video's length; a budget
           * tuned to a fast one would turn "slow" into "failed".
           */
          timeoutMs: 30 * 60_000,
          ...(input.signal ? { signal: input.signal } : {}),
        },
      );

      if (result.exitCode !== 0) {
        throw new AppError(
          'FFMPEG_FAILED',
          result.stderr.trim().split('\n').pop() ?? `the transcriber exited ${result.exitCode}`,
        );
      }

      const cues = parseWhisperJson(readFileSync(`${outputPrefix}.json`, 'utf8'));
      this.options.log?.info({ cues: cues.length }, 'transcribed');
      return cues.length > 0 ? cues : null;
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }
}
