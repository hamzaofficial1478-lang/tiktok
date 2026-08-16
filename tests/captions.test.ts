import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { normaliseCues, parseSubtitles, stripMarkup, wrapLine, type Cue } from '@main/captions/cues';
import { buildAss, escapeText, fittedLineChars, fontSizeFor, toAssColour, toAssTime, assFontName } from '@main/captions/ass';
import { planBurn, softSubtitlesLoseStyling, SUBTITLE_FILENAME } from '@main/captions/burn';
import { DEFAULT_CAPTION_STYLE, translationIsSupported, DEFAULT_CAPTION_SETTINGS } from '@shared/caption-schema';

const SRT = `1
00:00:01,000 --> 00:00:02,500
First line
Second line

2
00:00:03,000 --> 00:00:04,000
Another cue
`;

const VTT = `WEBVTT

00:00:01.000 --> 00:00:02.500 line:90%
<v Speaker><i>Styled</i> text
`;

describe('reading subtitle files', () => {
  it('reads SRT and WebVTT with the same routine', () => {
    expect(parseSubtitles(SRT)).toEqual([
      { startMs: 1_000, endMs: 2_500, lines: ['First line', 'Second line'] },
      { startMs: 3_000, endMs: 4_000, lines: ['Another cue'] },
    ]);
    // A dot instead of a comma, a header, and cue settings after the timing.
    expect(parseSubtitles(VTT)).toEqual([{ startMs: 1_000, endMs: 2_500, lines: ['Styled text'] }]);
  });

  it('ignores a cue with no text or no duration rather than emitting an empty one', () => {
    expect(parseSubtitles('1\n00:00:01,000 --> 00:00:01,000\nzero length\n')).toEqual([]);
    expect(parseSubtitles('1\n00:00:01,000 --> 00:00:02,000\n\n')).toEqual([]);
  });

  it('survives a file with no cues at all', () => {
    expect(parseSubtitles('')).toEqual([]);
    expect(parseSubtitles('WEBVTT\n\nNOTE just a comment\n')).toEqual([]);
  });
});

describe('stripping markup', () => {
  /**
   * The security-relevant one. Cue text arrives from a remote track or from a
   * model reading audio, and lands inside a file ffmpeg parses as markup — so a
   * caption containing an override block is a caption that can move, recolour
   * or hide itself over the video.
   */
  it('removes ASS override blocks, including a lone brace', () => {
    expect(stripMarkup('{\\pos(0,0)}hidden')).toBe('hidden');
    expect(stripMarkup('a { b } c')).toBe('a c');
    expect(stripMarkup('unbalanced { brace')).toBe('unbalanced brace');
  });

  it('removes WebVTT tags but keeps the words', () => {
    expect(stripMarkup('<c.yellow><i>hello</i></c> there')).toBe('hello there');
    expect(stripMarkup('<00:00:01.000>timed')).toBe('timed');
  });
});

describe('wrapping', () => {
  it('fills greedily and never splits a word', () => {
    expect(wrapLine('the quick brown fox jumps', 12, 4)).toEqual(['the quick', 'brown fox', 'jumps']);
  });

  it('leaves an over-long word long rather than breaking it', () => {
    expect(wrapLine('antidisestablishmentarianism ok', 10, 3)).toEqual(['antidisestablishmentarianism', 'ok']);
  });

  it('folds the tail into the last line rather than losing the end of a sentence', () => {
    expect(wrapLine('one two three four five six', 9, 2)).toEqual(['one two', 'three four five six']);
  });

  it('derives the real limit from the frame, not from the setting alone', () => {
    // 32 characters of bold text at 5% of a 540-wide portrait frame overflows
    // it — the first render clipped the first and last letter off every line.
    const fontSize = fontSizeFor(DEFAULT_CAPTION_STYLE, 960);
    expect(fittedLineChars(540, fontSize)).toBeLessThan(DEFAULT_CAPTION_STYLE.maxLineChars);
    // A wide frame can carry more than the default asks for.
    expect(fittedLineChars(1920, fontSize)).toBeGreaterThan(DEFAULT_CAPTION_STYLE.maxLineChars);
  });
});

describe('normalising cues for display', () => {
  const base = { maxLineChars: 40, maxLines: 2, uppercase: false };

  it('never leaves two cues on screen at once', () => {
    // TikTok's auto-captions routinely overlap, and stacked captions are the
    // most obvious way for this feature to look broken.
    const overlapping: Cue[] = [
      { startMs: 0, endMs: 3_000, lines: ['first'] },
      { startMs: 2_000, endMs: 4_000, lines: ['second'] },
    ];
    const out = normaliseCues(overlapping, base);
    expect(out[0]?.endMs).toBe(2_000);
    expect(out[1]?.startMs).toBe(2_000);
  });

  it('gives a flicker-short cue time to be read', () => {
    const out = normaliseCues([{ startMs: 0, endMs: 100, lines: ['hi'] }], base);
    expect((out[0] as Cue).endMs).toBe(700);
  });

  it('cannot extend past the end of the video', () => {
    const out = normaliseCues([{ startMs: 4_800, endMs: 9_000, lines: ['late'] }], { ...base, durationMs: 5_000 });
    expect((out[0] as Cue).endMs).toBe(5_000);
    // A cue starting after the video ends is dropped, not clamped to zero width.
    expect(normaliseCues([{ startMs: 6_000, endMs: 7_000, lines: ['past'] }], { ...base, durationMs: 5_000 })).toEqual([]);
  });

  it('sorts what arrives out of order', () => {
    const out = normaliseCues(
      [
        { startMs: 5_000, endMs: 6_000, lines: ['b'] },
        { startMs: 1_000, endMs: 2_000, lines: ['a'] },
      ],
      base,
    );
    expect(out.map((c) => c.lines[0])).toEqual(['a', 'b']);
  });

  it('applies uppercase as a style, not by mangling the source', () => {
    const out = normaliseCues([{ startMs: 0, endMs: 2_000, lines: ['hello there'] }], { ...base, uppercase: true });
    expect((out[0] as Cue).lines).toEqual(['HELLO THERE']);
  });
});

describe('writing ASS', () => {
  const context = { frameWidth: 540, frameHeight: 960 };
  const cues: Cue[] = [{ startMs: 1_230, endMs: 2_500, lines: ['Hola', 'mundo'] }];

  it('converts colour to ASS byte order, which is reversed', () => {
    // &HAABBGGRR — blue, green, red — and alpha where 00 is opaque.
    expect(toAssColour('#ff0000')).toBe('&H000000FF');
    expect(toAssColour('#0000ff')).toBe('&H00FF0000');
    expect(toAssColour('#ffffff')).toBe('&H00FFFFFF');
  });

  it('inverts opacity, because ASS alpha counts transparency', () => {
    expect(toAssColour('#000000', 100)).toBe('&H00000000');
    expect(toAssColour('#000000', 0)).toBe('&HFF000000');
  });

  it('writes centisecond timestamps with an unpadded hour', () => {
    expect(toAssTime(1_230)).toBe('0:00:01.23');
    expect(toAssTime(3_661_000)).toBe('1:01:01.00');
  });

  it('declares the real frame so percentage settings resolve against it', () => {
    const ass = buildAss(cues, DEFAULT_CAPTION_STYLE, context);
    expect(ass).toContain('PlayResX: 540');
    expect(ass).toContain('PlayResY: 960');
    // 5% of 960.
    expect(ass).toMatch(/Style: Caption,[^,]+,48,/);
  });

  it('lets libass wrap as a backstop, so a line cannot overflow the frame', () => {
    expect(buildAss(cues, DEFAULT_CAPTION_STYLE, context)).toContain('WrapStyle: 0');
  });

  it('draws a box only when the background is actually wanted', () => {
    // BorderStyle 3 is an opaque box; 1 is outline only. A box at zero opacity
    // still darkens the text's edges, so "none" has to mean a different mode.
    const withBox = buildAss(cues, { ...DEFAULT_CAPTION_STYLE, backgroundOpacity: 60 }, context);
    const without = buildAss(cues, { ...DEFAULT_CAPTION_STYLE, backgroundOpacity: 0 }, context);
    expect(withBox).toMatch(/,3,\d/);
    expect(without).toMatch(/,1,\d/);
  });

  it('emits one dialogue line per cue, with a hard line break between lines', () => {
    const ass = buildAss(cues, { ...DEFAULT_CAPTION_STYLE, animation: 'none' }, context);
    expect(ass).toContain('Dialogue: 0,0:00:01.23,0:00:02.50,Caption,,0,0,0,,Hola\\Nmundo');
  });

  it('animates with override tags rather than a second filter pass', () => {
    expect(buildAss(cues, { ...DEFAULT_CAPTION_STYLE, animation: 'fade' }, context)).toMatch(/\{\\fad\(\d+,\d+\)\}/);
    expect(buildAss(cues, { ...DEFAULT_CAPTION_STYLE, animation: 'pop' }, context)).toContain('\\fscx80');
    expect(buildAss(cues, { ...DEFAULT_CAPTION_STYLE, animation: 'rise' }, context)).toMatch(/\{\\move\(/);
  });

  it('never animates for longer than the cue is on screen', () => {
    const brief: Cue[] = [{ startMs: 0, endMs: 150, lines: ['x'] }];
    const ass = buildAss(brief, { ...DEFAULT_CAPTION_STYLE, animation: 'fade' }, context);
    expect(ass).toContain('\\fad(50,50)');
  });

  it('strips markup a cue could use to reposition itself', () => {
    const hostile: Cue[] = [{ startMs: 0, endMs: 2_000, lines: ['{\\pos(0,0)}gone'] }];
    const ass = buildAss(hostile, { ...DEFAULT_CAPTION_STYLE, animation: 'none' }, context);
    expect(ass).not.toContain('\\pos');
    expect(ass).toContain('gone');
  });

  it('gives libass one font name, not a CSS stack it will ignore', () => {
    expect(assFontName('Inter, Segoe UI, sans-serif')).toBe('Inter');
    expect(assFontName('"Comic Sans MS"')).toBe('Comic Sans MS');
    expect(escapeText('a\nb')).toBe('a b');
  });
});

describe('getting captions into the file', () => {
  const options = { subtitleDir: '/tmp/work dir', subtitlePath: '/tmp/work dir/captions.ass', outputExtension: '.mp4' };

  /**
   * The filename is never put in the filter graph. `:` separates a filter's
   * options, `,` chains filters and `\` escapes — and a real Windows path
   * (`C:\Users\ammar laptops\...`) contains three of the four. ffmpeg is run
   * from the file's directory instead and handed a bare ASCII name.
   */
  it('references the subtitle by a bare name and sets the working directory', () => {
    const plan = planBurn({ ...options, mode: 'burn' });
    expect(plan.videoFilter).toBe(`subtitles=${SUBTITLE_FILENAME}`);
    expect(plan.videoFilter).not.toContain('/');
    expect(plan.videoFilter).not.toContain(':');
    expect(plan.cwd).toBe('/tmp/work dir');
    expect(plan.reencodes).toBe(true);
  });

  it('adds a track without re-encoding when captions are soft', () => {
    const plan = planBurn({ ...options, mode: 'soft' });
    expect(plan.reencodes).toBe(false);
    expect(plan.videoFilter).toBeNull();
    // Without explicit maps the subtitle input replaces the video.
    expect(plan.args).toContain('0:v?');
    expect(plan.args).toContain('1:0');
    expect(plan.args[plan.args.indexOf('-c:s') + 1]).toBe('mov_text');
  });

  it('picks a subtitle codec the container can actually carry', () => {
    expect(planBurn({ ...options, mode: 'soft', outputExtension: '.mkv' }).args).toContain('ass');
    expect(planBurn({ ...options, mode: 'soft', outputExtension: '.webm' }).args).toContain('webvtt');
    // MP4 takes mov_text and nothing else, which loses the styling.
    expect(softSubtitlesLoseStyling('.mp4')).toBe(true);
    expect(softSubtitlesLoseStyling('.mkv')).toBe(false);
  });

  it('does nothing at all when captions are off', () => {
    const plan = planBurn({ ...options, mode: 'off' });
    expect(plan).toEqual({ videoFilter: null, args: [], cwd: null, reencodes: false });
  });
});

describe('what can honestly be translated', () => {
  it('accepts leaving the language alone, and translating to English', () => {
    expect(translationIsSupported(DEFAULT_CAPTION_SETTINGS)).toBe(true);
    expect(translationIsSupported({ ...DEFAULT_CAPTION_SETTINGS, targetLanguage: 'en' })).toBe(true);
  });

  it('rejects a target the offline model cannot produce', () => {
    // Whisper translates into English and no further. Silently captioning in
    // the original language would look like the setting simply did nothing.
    expect(translationIsSupported({ ...DEFAULT_CAPTION_SETTINGS, targetLanguage: 'es' })).toBe(false);
  });
});

describe('the burn-in encoder', () => {
  /**
   * The bug this pins: burn-in defaulted to libx264, which is a GPL component
   * and is deliberately absent from the LGPL ffmpeg this app downloads for
   * itself. Every burned-in caption would have failed with "Encoder not
   * found" on a build the app installed.
   */
  it('is required, so no caller can fall back to an encoder that may not exist', () => {
    // A compile-time guarantee: the field has no default any more. This test
    // documents why, and fails loudly if someone reintroduces one.
    const source = readFileSync(new URL('../src/main/captions/caption-step.ts', import.meta.url), 'utf8');
    expect(source).not.toContain("encoderArgs ?? ['libx264'");
    expect(source).toContain('readonly encoderArgs: readonly string[];');
  });
});
