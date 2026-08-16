/**
 * The caption model, and reading the formats captions arrive in.
 *
 * Everything upstream — TikTok's own tracks, a transcription — reduces to a
 * list of cues before anything downstream looks at it. That is what lets the
 * styling, wrapping and burn-in be written once instead of once per source, and
 * what lets all of it be tested without a video file.
 *
 * The text is treated as untrusted throughout. It comes from a remote response
 * or from a model reading someone's audio, and it ends up inside an ASS file
 * that ffmpeg parses as markup — so a cue containing `{\\pos(0,0)}` is a caption
 * that can move itself off screen unless the braces are dealt with here.
 */

export interface Cue {
  readonly startMs: number;
  readonly endMs: number;
  /** Already wrapped: one array entry per rendered line. */
  readonly lines: readonly string[];
  /**
   * When each word is spoken, if the source knew.
   *
   * TikTok's tracks are sentence-level and leave this absent. Transcription
   * produces it, and it is what the word-by-word caption styles are built on —
   * highlighting the word being said is impossible without knowing when each
   * one starts, which is why those styles only appear once a video has been
   * transcribed.
   */
  readonly words?: readonly CueWord[];
}

export interface CueWord {
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
}

/** Timestamps as SRT writes them: `00:01:02,500`. WebVTT uses a dot. */
const TIMESTAMP = /(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})/;
const CUE_TIMING = new RegExp(`${TIMESTAMP.source}\\s*-->\\s*${TIMESTAMP.source}`);

function toMs(hours: string, minutes: string, seconds: string, fraction: string): number {
  return (
    Number(hours) * 3_600_000 +
    Number(minutes) * 60_000 +
    Number(seconds) * 1_000 +
    Number(fraction.padEnd(3, '0'))
  );
}

/**
 * Parses SRT and WebVTT with one routine.
 *
 * They differ in a header, a comma versus a dot, and cue settings after the
 * timing — none of which changes what a cue is. Two parsers would be two places
 * for the same bug.
 */
export function parseSubtitles(text: string): readonly Cue[] {
  const cues: Cue[] = [];
  let pending: { startMs: number; endMs: number; lines: string[] } | null = null;

  const flush = (): void => {
    if (!pending) return;
    const lines = pending.lines.map(stripMarkup).filter((line) => line !== '');
    if (lines.length > 0 && pending.endMs > pending.startMs) {
      cues.push({ startMs: pending.startMs, endMs: pending.endMs, lines });
    }
    pending = null;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();

    const timing = CUE_TIMING.exec(line);
    if (timing) {
      flush();
      pending = {
        startMs: toMs(timing[1] as string, timing[2] as string, timing[3] as string, timing[4] as string),
        endMs: toMs(timing[5] as string, timing[6] as string, timing[7] as string, timing[8] as string),
        lines: [],
      };
      continue;
    }

    if (line === '') {
      flush();
      continue;
    }

    // A bare number before a timing is SRT's cue index; WEBVTT and its headers
    // sit before the first cue. Both are noise once the timings are found.
    if (pending) pending.lines.push(line);
  }

  flush();
  return cues;
}

/**
 * Removes the markup a caption may carry, and the markup it must not.
 *
 * WebVTT allows `<i>`, `<c.classname>` and `<00:00:01.000>` word timings; ASS
 * treats `{...}` as an override block. Stripping both means a cue is plain text
 * by the time anything renders it, and a track containing positioning tags
 * cannot reposition itself over the video.
 */
export function stripMarkup(line: string): string {
  return line
    .replace(/<[^>]*>/g, '')
    .replace(/\{[^}]*\}/g, '')
    // A lone brace would still open an override block in ASS.
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Wraps a line to a width, without breaking words.
 *
 * Greedy rather than balanced on purpose. A balanced wrap looks better in
 * print, but captions are read in the half-second they are on screen, and a
 * consistent left-to-right fill is easier to track than lines that change
 * length to look tidy. A word longer than the limit is left over-long instead
 * of being split — a broken word is harder to read than a wide line.
 */
export function wrapLine(text: string, maxChars: number, maxLines: number): readonly string[] {
  const words = text.split(/\s+/).filter((word) => word !== '');
  if (words.length === 0) return [];

  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current === '' ? word : `${current} ${word}`;
    if (candidate.length <= maxChars || current === '') {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = word;
  }
  if (current !== '') lines.push(current);

  if (lines.length <= maxLines) return lines;

  /**
   * Over the line budget: the tail is folded into the last line rather than
   * dropped. Losing the end of a sentence is a worse failure than a line that
   * runs slightly long, and this only happens on a cue that was already too
   * long for the chosen size.
   */
  const kept = lines.slice(0, maxLines - 1);
  kept.push(lines.slice(maxLines - 1).join(' '));
  return kept;
}

export interface NormaliseOptions {
  /**
   * The user's preference, treated as an upper bound rather than an
   * instruction. `fittedLineChars` supplies the frame's hard limit, and the
   * smaller of the two wins — a setting cannot ask for a line wider than the
   * video it is drawn on.
   */
  readonly maxLineChars: number;
  readonly maxLines: number;
  readonly uppercase: boolean;
  /** Clamps cues to the video, so a track longer than the file cannot extend it. */
  readonly durationMs?: number | null;
  /** Shortest a cue may be shown, so a one-frame cue does not flicker. */
  readonly minDurationMs?: number;
}

const DEFAULT_MIN_CUE_MS = 700;

/**
 * Turns parsed cues into what the renderer will actually draw.
 *
 * Ordering, overlap and duration are all fixed here rather than trusted:
 * TikTok's auto-captions routinely overlap by a few milliseconds, and two cues
 * on screen at once is the single most obvious way for captions to look broken.
 */
export function normaliseCues(cues: readonly Cue[], options: NormaliseOptions): readonly Cue[] {
  const minDuration = options.minDurationMs ?? DEFAULT_MIN_CUE_MS;
  const limit = options.durationMs ?? null;

  const prepared = cues
    .map((cue) => {
      const text = cue.lines.join(' ');
      const cased = options.uppercase ? text.toUpperCase() : text;
      return {
        startMs: Math.max(0, Math.round(cue.startMs)),
        endMs: Math.max(0, Math.round(cue.endMs)),
        lines: wrapLine(cased, options.maxLineChars, options.maxLines),
        /**
         * Word timings survive normalisation, and uppercase applies to them
         * too. Dropping them here would have silently disabled every
         * word-by-word style — the cue would render, just with no idea when
         * each word is spoken, which looks like the animation not working.
         */
        ...(cue.words
          ? { words: cue.words.map((word) => ({ ...word, text: options.uppercase ? word.text.toUpperCase() : word.text })) }
          : {}),
      };
    })
    .filter((cue) => cue.lines.length > 0)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  const out: Cue[] = [];
  for (const cue of prepared) {
    let { startMs, endMs } = cue;

    if (limit !== null) {
      if (startMs >= limit) continue;
      endMs = Math.min(endMs, limit);
    }

    // Give a too-short cue time to be read, but never past the next one.
    if (endMs - startMs < minDuration) endMs = startMs + minDuration;

    const previous = out[out.length - 1];
    if (previous) {
      // The earlier cue yields; a caption that is still on screen when its
      // replacement arrives is what makes two lines appear stacked.
      if (previous.endMs > startMs) {
        out[out.length - 1] = { ...previous, endMs: Math.max(previous.startMs + 1, startMs) };
      }
      if (startMs < previous.startMs) continue;
    }

    if (limit !== null) endMs = Math.min(endMs, limit);
    if (endMs <= startMs) continue;

    out.push({
      startMs,
      endMs,
      lines: cue.lines,
      // Clamped to the cue they belong to: a word timed past a shortened cue
      // would highlight after the line has left the screen.
      ...(cue.words
        ? {
            words: cue.words
              .filter((word) => word.startMs < endMs)
              .map((word) => ({ ...word, endMs: Math.min(word.endMs, endMs) })),
          }
        : {}),
    });
  }

  return out;
}
