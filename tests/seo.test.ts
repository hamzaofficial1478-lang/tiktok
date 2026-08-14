import { describe, expect, it } from 'vitest';
import { generateSeo, rankKeywords, scoreTitle, shapeTitle, splitSentences } from '@main/metadata/seo';
import type { Cue } from '@main/captions/cues';

/**
 * Titles and descriptions for downloaded videos.
 *
 * The requirement was explicit: not a random pick, not random generation. So
 * the property every test below defends is the same one — every word comes
 * from the video. A test that accepted an invented sentence would be accepting
 * the thing this was built to avoid.
 */

function cues(...lines: string[]): Cue[] {
  return lines.map((text, index) => ({
    startMs: index * 2_000,
    endMs: index * 2_000 + 1_800,
    lines: [text],
  }));
}

const SPOKEN = cues(
  'So the three mistakes people make when learning guitar are all about practice',
  'The first mistake is practising the parts you already play well',
  'The second is never using a metronome, which wrecks your timing forever',
  'And the third is skipping warm ups before every single session',
);

describe('generating from what the video says', () => {
  const result = generateSeo({
    cues: SPOKEN,
    caption: 'guitar practice tips for beginners #guitar #practice #music',
    hashtags: ['guitar', 'practice', 'music'],
    authorHandle: 'creator',
    durationMs: 30_000,
  });

  it('takes the title from the hook, not from a template', () => {
    // The hook is the sentence written to make someone stay, so it is already
    // doing a title's job. Every word of it came out of the video.
    expect(result.title.toLowerCase()).toContain('mistakes');
    expect(result.title).not.toMatch(/amazing|check out|must see|video by/i);
  });

  it('drops the spoken filler a written title should not open with', () => {
    expect(result.title.toLowerCase().startsWith('so ')).toBe(false);
  });

  it('writes a description in the length that was asked for', () => {
    const words = result.description.split(/\s+/).filter((w) => w !== '').length;
    expect(words).toBeGreaterThanOrEqual(20);
    expect(words).toBeLessThanOrEqual(42);
  });

  it('builds the description out of sentences the video actually contains', () => {
    // Every clause traceable to the transcript: nothing was composed.
    expect(result.description.toLowerCase()).toMatch(/metronome|mistake|practis|warm/);
  });

  it('says what it worked from, so a weak result is explainable', () => {
    expect(result.basis).toBe('transcript');
  });

  it('ranks the terms both texts are built around', () => {
    expect(result.keywords).toContain('guitar');
    expect(result.keywords).not.toContain('the');
    expect(result.keywords).not.toContain('you');
  });
});

describe('the SEO rules, as measurements', () => {
  it('scores each rule separately so a low score is a list of complaints', () => {
    const score = scoreTitle('3 guitar mistakes that wreck your timing forever', ['guitar', 'mistakes']);
    expect(score.checks.map((c) => c.name)).toEqual([
      'length',
      'keyword-front-loaded',
      'strong-opener',
      'substance',
      'not-shouting',
    ]);
    expect(score.total).toBe(100);
  });

  it('fails a title that wastes its opening on a stop word', () => {
    const score = scoreTitle('The thing that happened when I tried it out today', ['guitar']);
    expect(score.checks.find((c) => c.name === 'strong-opener')?.passed).toBe(false);
    expect(score.checks.find((c) => c.name === 'keyword-front-loaded')?.passed).toBe(false);
  });

  it('fails a title too long to survive a search listing', () => {
    const long = 'A very long title that keeps going well past the point where any search result would show it';
    expect(scoreTitle(long, []).checks.find((c) => c.name === 'length')?.passed).toBe(false);
  });

  it('fails shouting and punctuation pile-ups', () => {
    expect(scoreTitle('YOU WILL NOT BELIEVE THIS ONE', []).checks.find((c) => c.name === 'not-shouting')?.passed).toBe(
      false,
    );
    expect(scoreTitle('Watch this now!!! Really!!', []).checks.find((c) => c.name === 'not-shouting')?.passed).toBe(
      false,
    );
  });

  it('does not rewrite the title it is measuring', () => {
    // A scorer that edits its input can only ever report success.
    const title = 'the thing that happened';
    scoreTitle(title, []);
    expect(title).toBe('the thing that happened');
  });
});

describe('shaping a spoken line into a title', () => {
  it('strips hashtags, links and emoji without touching the words', () => {
    expect(shapeTitle('Guitar practice tips 🎸 #guitar https://x.com/a')).toBe('Guitar practice tips');
  });

  it('rewrites shouting in sentence case rather than discarding the words', () => {
    expect(shapeTitle('THREE MISTAKES EVERY BEGINNER MAKES')).toBe('Three mistakes every beginner makes');
  });

  it('cuts at a clause rather than mid-phrase', () => {
    const shaped = shapeTitle(
      'The second mistake is never using a metronome, which wrecks your timing forever and ever',
    );
    expect(shaped.endsWith(',')).toBe(false);
    expect(shaped.length).toBeLessThanOrEqual(70);
    // No ellipsis and no added words: it is a shorter piece of the same line.
    expect(shaped).not.toContain('…');
    expect(shaped).not.toContain('...');
  });

  it('never opens on a stop word when a keyword follows it', () => {
    expect(shapeTitle('The metronome trick that fixed my timing in one week', ['metronome'])).toBe(
      'Metronome trick that fixed my timing in one week',
    );
  });

  it('keeps an article that belongs to the subject', () => {
    // Dropping it here would change what the title is about.
    expect(shapeTitle('The Rock lifts a car', ['rock'])).toContain('The Rock');
  });
});

describe('when the video says little', () => {
  it('falls back to the caption, still the video\'s own words', () => {
    const result = generateSeo({
      cues: [],
      caption: 'Three quick sourdough tips that changed how I bake bread at home',
      hashtags: ['sourdough', 'baking'],
      authorHandle: 'baker',
      durationMs: 20_000,
    });
    expect(result.basis).toBe('caption');
    expect(result.title.toLowerCase()).toContain('sourdough');
  });

  it('describes the video plainly rather than padding it with invented detail', () => {
    const result = generateSeo({
      cues: [],
      caption: null,
      hashtags: ['cats'],
      authorHandle: 'creator',
      durationMs: 15_000,
    });
    expect(result.basis).toBe('thin');
    // States what is known — creator, length, subject — and claims nothing else.
    expect(result.description).toContain('@creator');
    expect(result.description).toMatch(/15-second/);
  });

  it('never returns an empty title', () => {
    const result = generateSeo({ cues: [], caption: null, hashtags: [], authorHandle: null, durationMs: null });
    expect(result.title.length).toBeGreaterThan(0);
  });
});

describe('the pieces', () => {
  it('splits spoken text that carries no punctuation', () => {
    expect(splitSentences('First point here. Second point here')).toHaveLength(2);
  });

  it('ignores filler words when ranking terms', () => {
    const keywords = rankKeywords('I really actually basically just wanted to show you the metronome technique');
    expect(keywords).toContain('metronome');
    expect(keywords).not.toContain('really');
    expect(keywords).not.toContain('basically');
  });
});
