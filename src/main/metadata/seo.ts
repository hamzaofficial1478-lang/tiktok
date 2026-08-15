import type { Cue } from '../captions/cues';

/**
 * A title and a description for each downloaded video.
 *
 * ## Why this is extractive, and not a generator
 *
 * The requirement was explicit: not a random pick and not random generation.
 * That rules out templates ("Amazing video by @creator!") which say nothing
 * about the video, and it rules out inventing sentences — an invented sentence
 * about a video nobody has watched is a guess dressed as a fact, and the way
 * these are used, a wrong one is worse than none.
 *
 * So every word here comes from the video itself: the transcript of what is
 * actually said, the caption the creator wrote, and their hashtags. The system
 * chooses and shapes; it never composes. The hook — the first thing said — is
 * the title's raw material for the same reason it is a hook: it is the sentence
 * written to make someone stay, so it is already doing the job a title does.
 *
 * ## What "SEO" means here, concretely
 *
 * Not vibes. Each rule below is a measurable property, and `scoreTitle` reports
 * which ones a title met, so the number can be argued with rather than trusted:
 *
 *   length      50-60 characters. Search results truncate around 60; under 30
 *               wastes the slot.
 *   front-load  the primary keyword inside the first 40 characters, because
 *               that is what survives truncation on a narrow display.
 *   opener      does not start with a stop word — "the thing that happened"
 *               spends its most valuable position on nothing.
 *   substance   a number, a question, or a comparative. These are the forms
 *               that describe specific content rather than gesture at it.
 *   honesty     no all-caps shouting and no punctuation pile-ups, which
 *               platforms demote and readers distrust.
 */

export interface SeoSource {
  /** What is said in the video, best-effort; empty when there is no transcript. */
  readonly cues: readonly Cue[];
  /** The creator's own caption for the post. */
  readonly caption: string | null;
  readonly hashtags: readonly string[];
  readonly authorHandle: string | null;
  readonly durationMs: number | null;
  /** The sound the post uses — often the only thing a silent video says. */
  readonly musicTitle?: string | null;
  /** When it was posted, used only to tell two otherwise identical posts apart. */
  readonly uploadedAt?: number | null;
}

export interface SeoResult {
  readonly title: string;
  readonly description: string;
  /** Ranked, most important first — the terms both texts are built around. */
  readonly keywords: readonly string[];
  readonly score: TitleScore;
  /** What the text was derived from, so a weak result is explainable. */
  readonly basis: 'transcript' | 'caption' | 'thin';
}

export interface TitleScore {
  readonly total: number;
  readonly checks: readonly { readonly name: string; readonly passed: boolean; readonly note: string }[];
}

/** Ideal title window. Search listings truncate near 60 characters. */
const TITLE_MIN = 30;
const TITLE_TARGET = 60;
const TITLE_MAX = 70;

/** The brief: "30 to 40 words round about". */
const DESCRIPTION_MIN_WORDS = 30;
const DESCRIPTION_MAX_WORDS = 42;

/**
 * Words that carry no meaning on their own.
 *
 * Used for two different jobs: keeping them out of the keyword ranking, and
 * refusing to let a title start with one. Deliberately short — an aggressive
 * stop list strips the words that make a sentence readable, and the result
 * reads like a telegram.
 */
const STOP_WORDS = new Set([
  'a','an','and','are','as','at','be','been','but','by','can','did','do','does','for','from','get','got','had','has',
  'have','he','her','here','hers','him','his','how','i','if','in','into','is','it','its','just','like','me','my','no',
  'not','now','of','on','one','or','our','out','over','own','she','so','some','such','than','that','the','their',
  'them','then','there','these','they','this','to','too','up','us','very','was','we','were','what','when','where',
  'which','while','who','why','will','with','you','your','yours','im','ive','dont','thats','were','gonna','really',
  'actually','basically','literally','okay','ok','yeah','yes','well','right','know','going','want','make','made',
]);

/** Fillers a spoken hook opens with that a written title should not. */
const SPOKEN_FILLER = /^(?:so|and|but|ok|okay|now|well|yeah|um+|uh+|like|alright|hey|guys|listen|look)\b[\s,]*/i;

export function generateSeo(source: SeoSource): SeoResult {
  const transcript = source.cues.map((cue) => cue.lines.join(' ')).join(' ').trim();
  const caption = cleanCaption(source.caption ?? '');
  const basis: SeoResult['basis'] = transcript.length > 80 ? 'transcript' : caption.length > 20 ? 'caption' : 'thin';

  const keywords = rankKeywords(
    [transcript, caption, source.hashtags.join(' '), source.musicTitle ?? ''].join(' '),
  );
  const title = buildTitle({ transcript, caption, keywords, hashtags: source.hashtags, source });
  const description = buildDescription({ transcript, caption, keywords, source });

  return { title, description, keywords, score: scoreTitle(title, keywords), basis };
}

/**
 * The most informative terms, by frequency against length.
 *
 * A plain frequency count returns "the" and "you". Weighting by word length
 * approximates what a corpus-based measure would say without shipping a corpus:
 * in spoken English the longer words are the ones carrying the subject, and
 * the short ones that survive the stop list are usually genuinely repeated
 * topic words. It is a heuristic, and it is a heuristic that can be read.
 */
export function rankKeywords(text: string, limit = 8): readonly string[] {
  const counts = new Map<string, number>();

  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}'-]+/u)) {
    const word = raw.replace(/^['-]+|['-]+$/g, '');
    if (word.length < 3 || STOP_WORDS.has(word)) continue;
    if (/^\d+$/.test(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([word, count]) => ({ word, weight: count * Math.min(3, Math.sqrt(word.length)) }))
    .sort((a, b) => b.weight - a.weight || a.word.localeCompare(b.word))
    .slice(0, limit)
    .map((entry) => entry.word);
}

/** Splits into sentences, keeping the spoken ones that have no punctuation. */
export function splitSentences(text: string): readonly string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .flatMap((part) => (part.length > 140 ? part.split(/,\s+(?=\w{4,})/) : [part]))
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function buildTitle(input: {
  transcript: string;
  caption: string;
  keywords: readonly string[];
  hashtags: readonly string[];
  source: SeoSource;
}): string {
  /**
   * The hook is the first thing said, and it is the title's raw material.
   *
   * Falling back through caption and then hashtags rather than to a template:
   * each fallback is still the video's own words, just less of them. Only a
   * video with no transcript, no caption and no tags reaches the last line, and
   * for that one there is genuinely nothing to say.
   */
  const spoken = splitSentences(input.transcript);
  const hookCandidates = [...spoken.slice(0, 2), ...splitSentences(input.caption).slice(0, 2)];

  for (const candidate of hookCandidates) {
    const title = shapeTitle(candidate, input.keywords);
    if (title.length >= TITLE_MIN) return title;
  }

  // Two short spoken lines joined often make one good title where neither did.
  if (spoken.length >= 2) {
    const joined = shapeTitle(`${spoken[0]} ${spoken[1]}`, input.keywords);
    if (joined.length >= TITLE_MIN) return joined;
  }

  const fromCaption = shapeTitle(input.caption, input.keywords);
  if (fromCaption.length >= 12) return fromCaption;

  /**
   * Nothing was said and the caption is too short to be one — a silent clip
   * with a two-word caption, which a whole account can consist of.
   *
   * What is left still differs from post to post: the tags the creator chose,
   * the sound they used. Both are the creator's own words about this video and
   * neither is invented, so they are used in that order rather than falling
   * through to a template. That template is what produced "Video by @creator"
   * as the title of every video in a batch — a result so useless it read as
   * the feature being broken, which is fair.
   */
  const tags = input.hashtags.filter((tag) => tag.length > 2).slice(0, 4);
  const parts: string[] = [];
  if (fromCaption !== '') parts.push(fromCaption);
  if (tags.length > 0) parts.push(tags.map(spaceOutTag).join(', '));
  if (input.source.musicTitle) parts.push(`sound: ${input.source.musicTitle}`);

  const assembled = shapeTitle(parts.join(' — '), input.keywords);
  if (assembled.length >= 8) return assembled;

  // Genuinely nothing: no speech, no caption, no tags, no sound. The date is
  // the last thing that distinguishes one of these from the next.
  const when = input.source.uploadedAt ? new Date(input.source.uploadedAt).toISOString().slice(0, 10) : null;
  const who = input.source.authorHandle ? `@${input.source.authorHandle}` : 'Unknown creator';
  return when ? `${who} — ${when}` : who;
}

/** `guitarpractice` reads as one word; `guitar practice` reads as two. */
function spaceOutTag(tag: string): string {
  return tag
    .replace(/[_-]+/g, ' ')
    // camelCase and digit boundaries are the only splits that are safe without
    // a dictionary; splitting a lowercase run would mangle real words.
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .toLowerCase()
    .trim();
}

/**
 * Turns a spoken line into a title.
 *
 * Trimming happens at a word boundary and, past the target length, at a clause
 * boundary where one exists — a title cut mid-clause reads as broken, while one
 * cut at a comma reads as deliberate. Nothing is added: no ellipsis, no
 * "| brand", no emoji.
 */
export function shapeTitle(raw: string, keywords: readonly string[] = []): string {
  let text = raw
    .replace(/#[\p{L}\p{N}_]+/gu, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  text = text.replace(SPOKEN_FILLER, '').trim();
  // Repeated punctuation is the pattern platforms demote and readers distrust.
  text = text.replace(/([!?.])\1+/g, '$1').replace(/\s+([,.!?])/g, '$1');

  // Shouting is not emphasis. A title that is entirely capitals is rewritten in
  // sentence case rather than discarded — the words are still the video's.
  if (text.length > 8 && text === text.toUpperCase()) text = sentenceCase(text.toLowerCase());

  text = text.replace(/[.,;:]+$/, '').trim();
  if (text === '') return '';

  if (text.length > TITLE_MAX) {
    const clause = text.slice(0, TITLE_TARGET).lastIndexOf(',');
    text = clause > TITLE_MIN ? text.slice(0, clause) : cutAtWord(text, TITLE_TARGET);
  }

  text = ensureLeadingKeyword(text, keywords);
  return sentenceCase(text).replace(/[.,;:]+$/, '').trim();
}

/**
 * Drops a leading stop word when doing so does not break the sentence.
 *
 * The first words of a title are the ones that survive truncation, so spending
 * them on "so" or "the" is spending the most valuable position on nothing.
 *
 * Two guards, and the second was learned the hard way. A keyword must follow
 * immediately, and that keyword must not be capitalised in the original — an
 * article before a proper noun belongs to it. "The metronome trick" loses its
 * article happily; "The Rock lifts a car" becomes a different subject entirely.
 */
function ensureLeadingKeyword(text: string, keywords: readonly string[]): string {
  const words = text.split(' ');
  const first = (words[0] ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const nextWord = words[1] ?? '';
  const second = nextWord.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const isProperNoun = /^\p{Lu}/u.test(nextWord);

  if (words.length > 3 && STOP_WORDS.has(first) && keywords.includes(second) && !isProperNoun) {
    return words.slice(1).join(' ');
  }
  return text;
}

function buildDescription(input: {
  transcript: string;
  caption: string;
  keywords: readonly string[];
  source: SeoSource;
}): string {
  /**
   * Built from the sentences that carry the most keywords, in the order they
   * were said.
   *
   * Ranking by keyword coverage picks the parts that are about the subject;
   * restoring the original order keeps it readable as a description of the
   * video rather than as three highlights stapled together.
   */
  const sentences = [...splitSentences(input.transcript), ...splitSentences(input.caption)]
    .map((text) => clean(text))
    .filter((text) => wordCount(text) >= 4);

  const ranked = sentences
    .map((text, index) => ({ text, index, hits: countKeywords(text, input.keywords) }))
    .sort((a, b) => b.hits - a.hits || a.index - b.index);

  const chosen: { text: string; index: number }[] = [];
  let words = 0;
  for (const candidate of ranked) {
    if (words >= DESCRIPTION_MIN_WORDS) break;
    if (chosen.some((entry) => entry.text === candidate.text)) continue;
    chosen.push(candidate);
    words += wordCount(candidate.text);
  }

  let description = chosen
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.text)
    .join('. ')
    .replace(/\.\s*\./g, '.')
    .trim();

  if (description !== '' && !/[.!?]$/.test(description)) description += '.';

  /**
   * Too short to be a description: state what is known rather than padding it
   * out with words the video never contained.
   *
   * Everything added here varies per post — the tags the creator chose, the
   * sound, the length — so two silent videos from the same account do not end
   * up with the same paragraph, which is what happened when the only fallback
   * mentioned the creator and the duration.
   */
  if (wordCount(description) < 12) {
    const who = input.source.authorHandle ? `@${input.source.authorHandle}` : 'this creator';
    const seconds = input.source.durationMs ? Math.round(input.source.durationMs / 1_000) : null;
    const tags = input.source.hashtags.slice(0, 5);

    const facts = [
      `A ${seconds ? `${seconds}-second ` : ''}clip from ${who}`,
      tags.length > 0 ? `tagged ${tags.map((tag) => `#${tag}`).join(' ')}` : '',
      input.source.musicTitle ? `set to ${input.source.musicTitle}` : '',
      input.keywords.length > 0 ? `about ${input.keywords.slice(0, 4).join(', ')}` : '',
    ].filter((part) => part !== '');

    description = [description, `${facts.join(', ')}.`].filter((part) => part !== '').join(' ').trim();
  }

  return trimToWords(description, DESCRIPTION_MAX_WORDS);
}

/**
 * Reports which SEO rules a title met.
 *
 * Returned rather than applied, and each check carries its own note, so a low
 * score is a list of specific complaints instead of a number to be taken on
 * faith. Nothing here rewrites the title — a scorer that edits what it measures
 * can only ever report success.
 */
export function scoreTitle(title: string, keywords: readonly string[]): TitleScore {
  const words = title.split(/\s+/).filter((word) => word !== '');
  const first = (words[0] ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const head = title.slice(0, 40).toLowerCase();

  const checks = [
    {
      name: 'length',
      passed: title.length >= TITLE_MIN && title.length <= TITLE_MAX,
      note: `${title.length} characters; ${TITLE_MIN}-${TITLE_MAX} reads fully in a search result`,
    },
    {
      name: 'keyword-front-loaded',
      passed: keywords.length === 0 || keywords.slice(0, 3).some((word) => head.includes(word)),
      note: 'a main term appears in the first 40 characters, which is what survives truncation',
    },
    {
      name: 'strong-opener',
      passed: first !== '' && !STOP_WORDS.has(first),
      note: 'does not open on a stop word',
    },
    {
      name: 'substance',
      passed: /\d/.test(title) || /\?$/.test(title) || /\b(best|worst|why|how|never|always|before|after)\b/i.test(title),
      note: 'carries a number, a question or a comparative rather than gesturing',
    },
    {
      name: 'not-shouting',
      passed: !(title.length > 8 && title === title.toUpperCase()) && !/[!?]{2,}/.test(title),
      note: 'no all-caps and no punctuation pile-ups, both of which platforms demote',
    },
  ];

  return { total: Math.round((checks.filter((check) => check.passed).length / checks.length) * 100), checks };
}

function countKeywords(text: string, keywords: readonly string[]): number {
  const lower = text.toLowerCase();
  return keywords.reduce((total, word) => (lower.includes(word) ? total + 1 : total), 0);
}

function cleanCaption(caption: string): string {
  return clean(caption.replace(/#[\p{L}\p{N}_]+/gu, ' '));
}

function clean(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[.,;:]+$/, '')
    .trim();
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter((word) => word !== '').length;
}

function cutAtWord(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  return (space > limit * 0.6 ? cut.slice(0, space) : cut).trim();
}

function trimToWords(text: string, limit: number): string {
  const words = text.split(/\s+/).filter((word) => word !== '');
  if (words.length <= limit) return text;
  const trimmed = words.slice(0, limit).join(' ').replace(/[.,;:]+$/, '');
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Capitalises the first letter only; the rest of the words are left as said. */
function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
