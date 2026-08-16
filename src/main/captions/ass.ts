import type { CaptionStyle } from '@shared/caption-schema';
import type { Cue, CueWord } from './cues';

/**
 * Rendering cues as an ASS subtitle file.
 *
 * ASS rather than SRT because SRT carries no styling at all — no font, no
 * colour, no position, no animation — and every one of those is a setting the
 * user asked for. ffmpeg's `subtitles` filter renders ASS natively through
 * libass, so the entire look is decided in this file and costs nothing beyond
 * the burn-in pass that was already happening.
 *
 * The format is positional and unforgiving: fields are comma-separated, so a
 * comma in a value silently shifts every field after it. Everything written
 * here is either a number this module produced or text that has been through
 * `escapeText`.
 */

/** ASS measures its script in pixels; the frame is declared so % settings land. */
export interface AssContext {
  readonly frameWidth: number;
  readonly frameHeight: number;
}

/**
 * ASS colours are `&HAABBGGRR` — alpha first, then **blue, green, red**.
 *
 * The byte order is reversed from every colour picker on earth, and the alpha
 * channel is inverted on top of that: `00` is opaque and `FF` is invisible.
 * Getting either wrong produces a caption in the wrong colour or no caption at
 * all, with no error, so this is the only place either conversion happens.
 */
export function toAssColour(hex: string, opacityPercent = 100): string {
  const value = hex.replace('#', '');
  const r = value.slice(0, 2);
  const g = value.slice(2, 4);
  const b = value.slice(4, 6);

  const clamped = Math.min(100, Math.max(0, opacityPercent));
  const alpha = Math.round(255 - (clamped / 100) * 255)
    .toString(16)
    .padStart(2, '0');

  return `&H${alpha}${b}${g}${r}`.toUpperCase();
}

/** ASS alignment numpad: 2 is bottom-centre, 5 middle-centre, 8 top-centre. */
const ALIGNMENT: Record<CaptionStyle['position'], number> = { bottom: 2, middle: 5, top: 8 };

/** `0:00:01.23` — centiseconds, and hours are not zero-padded. */
export function toAssTime(ms: number): string {
  const total = Math.max(0, Math.round(ms / 10));
  const centiseconds = total % 100;
  const seconds = Math.floor(total / 100) % 60;
  const minutes = Math.floor(total / 6_000) % 60;
  const hours = Math.floor(total / 360_000);

  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${hours}:${pad(minutes)}:${pad(seconds)}.${pad(centiseconds)}`;
}

/**
 * Makes caption text safe to place in a dialogue line.
 *
 * Three things would otherwise break: a newline ends the event, a comma is a
 * field separator in some positions, and a brace opens an override block —
 * which is the one that matters, because a caption that can open an override
 * block can reposition, recolour or hide itself. Cue text reaches here from a
 * remote track or a transcription, so it is never trusted to be plain.
 */
export function escapeText(text: string): string {
  return text
    .replace(/\\/g, '＼')
    .replace(/[{}]/g, '')
    .replace(/\r?\n/g, ' ')
    .trim();
}

/**
 * The override tags that animate a cue.
 *
 * Each is a libass primitive, so the whole animation costs one string per line
 * rather than a filter pass:
 *
 *   fade  `\fad(in,out)`    — the conventional subtitle behaviour
 *   pop   `\fscx\fscy` + `\t` — scales up from 80% over 120ms, the bounce a
 *                              social caption usually has
 *   rise  `\move` + `\fad`  — drifts up a fraction of the frame while fading in
 */
/**
 * Renders a cue whose words are timed individually.
 *
 * `\k` is ASS's karaoke primitive: it takes a duration in centiseconds and
 * advances a highlight through the line as that time passes, with no per-word
 * events and no extra rendering cost. `\kf` sweeps the fill smoothly rather
 * than switching at each boundary, which is what makes it read as following
 * speech rather than as a flashing word.
 *
 * The other three are built from the same timings: `word-pop` scales each word
 * as it arrives, `highlight` recolours only the current word, and `one-word`
 * shows a single word at a time — the style most social captions use, because
 * one large word is readable at arm's length on a phone.
 */
function wordLevelText(style: CaptionStyle, words: readonly CueWord[], cueStartMs: number): string | null {
  if (words.length === 0) return null;

  const cs = (ms: number): number => Math.max(1, Math.round(ms / 10));

  switch (style.animation) {
    case 'karaoke':
      // SecondaryColour is what \k reveals from, so the style's highlight is
      // set as primary and the text colour is what the sweep leaves behind.
      return words
        .map((word, index) => {
          const next = words[index + 1];
          const until = (next?.startMs ?? word.endMs) - word.startMs;
          return `{\kf${cs(until)}}${escapeText(word.text)}`;
        })
        .join(' ');

    case 'highlight':
      return words
        .map((word, index) => {
          const next = words[index + 1];
          const from = cs(word.startMs - cueStartMs) * 10;
          const to = cs((next?.startMs ?? word.endMs) - cueStartMs) * 10;
          // Recolour on arrival, and back again when the next word starts.
          return (
            `{\t(${from},${from + 1},\c${toAssColour(style.highlightColour)})` +
            `\t(${to},${to + 1},\c${toAssColour(style.textColour)})}${escapeText(word.text)}`
          );
        })
        .join(' ');

    case 'word-pop':
      return words
        .map((word) => {
          const from = Math.max(0, word.startMs - cueStartMs);
          return (
            `{\fscx70\fscy70\t(${from},${from + 120},\fscx100\fscy100)}${escapeText(word.text)}`
          );
        })
        .join(' ');

    case 'one-word':
      // Handled by splitting into separate events; see buildAss.
      return null;

    default:
      return null;
  }
}

function animationTags(style: CaptionStyle, context: AssContext, cue: Cue): string {
  const durationMs = cue.endMs - cue.startMs;
  // Never animate for longer than the cue is on screen, or a short cue would
  // still be arriving when it is due to leave.
  const inMs = Math.min(180, Math.max(0, Math.floor(durationMs / 3)));

  switch (style.animation) {
    case 'fade':
      return `{\\fad(${inMs},${inMs})}`;
    case 'pop':
      return `{\\fscx80\\fscy80\\t(0,${inMs},\\fscx100\\fscy100)\\fad(${Math.floor(inMs / 2)},${inMs})}`;
    case 'rise': {
      const { x, y } = anchorPoint(style, context);
      const travel = Math.round(context.frameHeight * 0.02);
      return `{\\move(${x},${y + travel},${x},${y},0,${inMs})\\fad(${inMs},${inMs})}`;
    }
    case 'slide': {
      // In from the left, which reads as deliberate motion rather than the
      // vertical drift `rise` gives.
      const { x, y } = anchorPoint(style, context);
      const travel = Math.round(context.frameWidth * 0.12);
      return `{\\move(${x - travel},${y},${x},${y},0,${inMs})\\fad(${inMs},${Math.floor(inMs / 2)})}`;
    }
    case 'bounce': {
      // Overshoots past full size and settles back, in two chained transforms.
      const half = Math.max(1, Math.floor(inMs / 2));
      return (
        `{\\fscx60\\fscy60\\t(0,${half},\\fscx112\\fscy112)` +
        `\\t(${half},${inMs},\\fscx100\\fscy100)\\fad(${Math.floor(inMs / 3)},${inMs})}`
      );
    }
    case 'typewriter': {
      // A clip wipe left to right: the closest ASS gets to text arriving a
      // character at a time without one event per character.
      const width = context.frameWidth;
      const { y } = anchorPoint(style, context);
      const band = Math.round(context.frameHeight * 0.2);
      const reveal = Math.min(600, Math.max(120, (cue.endMs - cue.startMs) / 3));
      return (
        `{\\clip(0,${y - band},0,${y + band})` +
        `\\t(0,${Math.round(reveal)},\\clip(0,${y - band},${width},${y + band}))}`
      );
    }
    case 'none':
    default:
      return '';
  }
}

/**
 * Where the caption block is anchored, in script pixels.
 *
 * Only `rise` needs it — `\move` takes absolute coordinates — but it is derived
 * from the same margin and alignment the style sets, so the animation cannot
 * drift away from where the static caption would have been.
 */
function anchorPoint(style: CaptionStyle, context: AssContext): { x: number; y: number } {
  const margin = Math.round(context.frameHeight * (style.marginPct / 100));
  const x = Math.round(context.frameWidth / 2);

  if (style.position === 'top') return { x, y: margin };
  if (style.position === 'middle') return { x, y: Math.round(context.frameHeight / 2) };
  return { x, y: context.frameHeight - margin };
}

/**
 * Builds the whole ASS file.
 *
 * `PlayResX/Y` are set to the real frame size so every percentage setting
 * resolves against the video the user is actually looking at — libass scales a
 * script authored at a different resolution, and a caption sized as a
 * percentage of the wrong frame is the wrong size.
 */
export function buildAss(cues: readonly Cue[], style: CaptionStyle, context: AssContext): string {
  const fontSize = fontSizeFor(style, context.frameHeight);
  const outline = Math.max(0, Number((fontSize * (style.outlinePct / 100)).toFixed(1)));
  const margin = Math.round(context.frameHeight * (style.marginPct / 100));

  // BorderStyle 3 draws an opaque box behind the text; 1 draws outline and
  // shadow only. Choosing between them is what makes "no background" mean it,
  // rather than a box at zero opacity that still darkens the video's edges.
  const borderStyle = style.backgroundOpacity > 0 ? 3 : 1;

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    /**
     * 0 lets libass wrap as well, and that is deliberate rather than lazy.
     *
     * The lines are already wrapped here, by character count — and character
     * count is not width. A 32-character line of bold text at 5% of a 540-wide
     * portrait frame overflows it, and the first render of this file lost the
     * first and last letters of every long line off both edges with no error.
     * Explicit `\N` breaks are always honoured, so the pre-wrap still decides
     * where lines break; libass only steps in when one would not fit, which
     * makes overflow impossible rather than unlikely.
     */
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    `PlayResX: ${Math.round(context.frameWidth)}`,
    `PlayResY: ${Math.round(context.frameHeight)}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour,' +
      ' Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline,' +
      ' Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    [
      'Style: Caption',
      assFontName(style.fontFamily),
      String(fontSize),
      // Karaoke reveals *from* SecondaryColour to PrimaryColour, so for that
      // style the pair is swapped: the highlight is what a swept word becomes.
      style.animation === 'karaoke' ? toAssColour(style.highlightColour) : toAssColour(style.textColour),
      toAssColour(style.textColour),
      toAssColour(style.outlineColour),
      toAssColour(style.backgroundColour, style.backgroundOpacity),
      style.bold ? '-1' : '0', // ASS booleans are -1 and 0, not 1 and 0.
      '0',
      '0',
      '0',
      '100',
      '100',
      // Spacing and angle, both expressed against the resolved font size so
      // they mean the same thing at any resolution.
      String(Number(((fontSize * style.letterSpacingPct) / 100).toFixed(1))),
      String(style.rotation),
      String(borderStyle),
      String(outline),
      String(Number(((fontSize * style.shadowPct) / 100).toFixed(1))),
      String(ALIGNMENT[style.position]),
      '40',
      '40',
      String(margin),
      '1',
    ].join(','),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const event = (startMs: number, endMs: number, body: string): string =>
    ['Dialogue: 0', toAssTime(startMs), toAssTime(endMs), 'Caption', '', '0', '0', '0', '', body].join(',');

  const events = cues.flatMap((cue) => {
    /**
     * One word at a time gets one event per word.
     *
     * The other styles are a single event carrying override tags, but this one
     * genuinely shows different text at different moments, so it cannot be
     * expressed as one. It is also the style most social captions use, and the
     * reason word timings were worth extracting at all.
     */
    if (style.animation === 'one-word' && cue.words && cue.words.length > 0) {
      return cue.words.map((word, index) => {
        const next = cue.words?.[index + 1];
        const endMs = Math.min(cue.endMs, next?.startMs ?? word.endMs);
        const inMs = Math.min(90, Math.max(1, Math.floor((endMs - word.startMs) / 3)));
        return event(
          word.startMs,
          Math.max(word.startMs + 60, endMs),
          `{\\fscx80\\fscy80\\t(0,${inMs},\\fscx100\\fscy100)}${escapeText(word.text)}`,
        );
      });
    }

    const timed = cue.words ? wordLevelText(style, cue.words, cue.startMs) : null;
    const text = timed ?? cue.lines.map(escapeText).filter((line) => line !== '').join('\\N');

    // A word-level style on a cue with no word timings falls back to the plain
    // rendering rather than showing nothing, which is what a sentence-level
    // TikTok track would otherwise produce.
    const tags = timed === null ? animationTags(style, context, cue) : '';
    return [event(cue.startMs, cue.endMs, `${tags}${text}`)];
  });

  return [...header, ...events, ''].join('\n');
}

/**
 * The widest line, in characters, that will actually fit the frame.
 *
 * Wrapping by character count is the only practical option — measuring real
 * glyph advances would mean shipping a font rasteriser — but the count has to
 * be derived from the frame rather than chosen in the abstract. The factor is
 * the average advance of a bold sans-serif glyph as a fraction of its point
 * size, rounded up rather than down: a line that comes out slightly short is
 * invisible, and one that comes out slightly long is clipped at the frame edge.
 */
const AVERAGE_GLYPH_WIDTH_RATIO = 0.58;

export function fittedLineChars(frameWidth: number, fontSizePx: number, sideMarginPx = 40): number {
  const usable = Math.max(0, frameWidth - sideMarginPx * 2);
  const perGlyph = Math.max(1, fontSizePx * AVERAGE_GLYPH_WIDTH_RATIO);
  return Math.max(8, Math.floor(usable / perGlyph));
}

/** The font size a style resolves to on a given frame. */
export function fontSizeFor(style: CaptionStyle, frameHeight: number): number {
  return Math.max(8, Math.round(frameHeight * (style.fontSizePct / 100)));
}

/**
 * Takes the first family from a CSS-style list.
 *
 * The setting holds a fallback stack because that is how a font is chosen in a
 * UI, but ASS's Fontname is a single name — handed a whole stack, libass
 * matches nothing and silently renders in its default font.
 */
export function assFontName(fontFamily: string): string {
  const first = fontFamily.split(',')[0] ?? fontFamily;
  return first.replace(/["']/g, '').trim() || 'sans-serif';
}
