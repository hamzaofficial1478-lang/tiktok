import { z } from 'zod';

/**
 * Caption settings — the shape both the Settings screen and the burn-in step
 * validate against, so an impossible combination is impossible to save.
 *
 * ## The two decisions that shape everything else
 *
 * **Where the words come from.** TikTok publishes caption tracks for a large
 * share of videos — yt-dlp's extractor reads them out of `auto_captions`,
 * `cla_info.caption_infos` and the page's `subtitleInfos`. Those are free,
 * instant and already correct, so they are tried first and transcription is the
 * fallback rather than the default. Transcribing a video that already has
 * captions would cost minutes of CPU to produce something worse.
 *
 * **Whether they are painted on.** Soft subtitles are a track in the file: no
 * re-encode, no quality loss, toggleable, and invisible on any player or
 * platform that ignores them — which includes most social re-uploads. Burned-in
 * captions survive anywhere and cannot be turned off, and cost a full re-encode.
 * Neither is the right default for everyone, so it is a choice rather than an
 * assumption.
 */

export const CAPTION_MODES = ['off', 'soft', 'burn'] as const;
export type CaptionMode = (typeof CAPTION_MODES)[number];

export const CAPTION_SOURCES = ['auto', 'tiktok', 'transcribe'] as const;
export type CaptionSource = (typeof CAPTION_SOURCES)[number];

/**
 * Where the caption block sits.
 *
 * Not free-form coordinates: TikTok's own interface occupies the bottom left
 * (caption, handle, music) and the right edge (the action rail), and a caption
 * placed under either is unreadable on the platform this footage came from.
 */
export const CAPTION_POSITIONS = ['bottom', 'middle', 'top'] as const;
export type CaptionPosition = (typeof CAPTION_POSITIONS)[number];

/**
 * How a cue arrives on screen.
 *
 * All four are expressible in ASS override tags, so they cost nothing beyond
 * the burn-in that was already happening — no extra pass, no filter chain per
 * cue. `none` exists because a hard cut is what a subtitle traditionally does
 * and some people want exactly that.
 */
export const CAPTION_ANIMATIONS = [
  'none',
  'fade',
  'pop',
  'rise',
  'slide',
  'bounce',
  'typewriter',
  // The four below need word timings, which only transcription produces.
  'karaoke',
  'word-pop',
  'highlight',
  'one-word',
] as const;

/**
 * Styles that need to know when each word is spoken.
 *
 * TikTok's own caption tracks are sentence-level, so these only work on a
 * transcribed video. Offered anyway, and labelled — the alternative is hiding
 * the best-looking options behind a setting nobody would think to change.
 */
export const WORD_LEVEL_ANIMATIONS = ['karaoke', 'word-pop', 'highlight', 'one-word'] as const;

export function needsWordTimings(animation: CaptionAnimation): boolean {
  return (WORD_LEVEL_ANIMATIONS as readonly string[]).includes(animation);
}
export type CaptionAnimation = (typeof CAPTION_ANIMATIONS)[number];

/** `#RRGGBB`, the form a colour input produces. */
const HexColour = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Colour must be #RRGGBB');

/**
 * Sizes are a percentage of frame height, never a point size.
 *
 * A 24pt caption is readable on a 1080-tall video and unreadable on a 480-tall
 * one, and TikTok serves both. Anchoring to the frame means the setting means
 * the same thing whatever resolution the video turns out to be.
 */
export const CaptionStyleSchema = z.object({
  fontFamily: z.string().min(1).max(64),
  /** Percentage of frame height. 5% is roughly TikTok's own caption size. */
  fontSizePct: z.number().min(2).max(15),
  bold: z.boolean(),
  uppercase: z.boolean(),

  textColour: HexColour,
  outlineColour: HexColour,
  /** Outline thickness as a percentage of font size, so it scales with the text. */
  outlinePct: z.number().min(0).max(30),
  /** 0 disables the box entirely and leaves outlined text on the video. */
  backgroundOpacity: z.number().min(0).max(100),
  backgroundColour: HexColour,

  position: z.enum(CAPTION_POSITIONS),
  /** Distance from the chosen edge, as a percentage of frame height. */
  marginPct: z.number().min(0).max(40),
  /** Longest line before wrapping, in characters. */
  maxLineChars: z.number().int().min(12).max(60),
  maxLines: z.number().int().min(1).max(4),

  animation: z.enum(CAPTION_ANIMATIONS),
  /** The colour a word turns as it is spoken, for the word-level styles. */
  highlightColour: HexColour,
  /** Letter spacing as a percentage of font size; a look, not a fix. */
  letterSpacingPct: z.number().min(-5).max(30),
  /** Degrees, for captions that sit at an angle. */
  rotation: z.number().min(-15).max(15),
  /** Drop shadow distance as a percentage of font size. */
  shadowPct: z.number().min(0).max(30),
});

export type CaptionStyle = z.infer<typeof CaptionStyleSchema>;

export const CaptionSettingsSchema = z.object({
  mode: z.enum(CAPTION_MODES),
  source: z.enum(CAPTION_SOURCES),
  /**
   * The language to caption in. 'auto' keeps whatever the video is spoken in.
   *
   * Anything else means translation, and the honest limit is stated in the UI:
   * offline transcription translates *into English* and no further, because
   * that is the only direction the model was trained for. A target of 'en' on a
   * Spanish video is a supported translation; a target of 'es' on an English
   * video is not, and the setting is rejected rather than silently ignored.
   */
  targetLanguage: z.string().regex(/^(auto|[a-z]{2})$/, 'Language must be "auto" or a two-letter code'),
  style: CaptionStyleSchema,
});

export type CaptionSettings = z.infer<typeof CaptionSettingsSchema>;

/**
 * Rejects a translation nobody can perform.
 *
 * Kept as a function rather than a schema refinement so the Settings screen can
 * explain the limit next to the control instead of showing a validation error
 * after the fact.
 */
export function translationIsSupported(settings: CaptionSettings): boolean {
  return settings.targetLanguage === 'auto' || settings.targetLanguage === 'en';
}

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  // Every platform this runs on has one of these; the list ends in a generic
  // family so a missing font degrades to something rather than to nothing.
  fontFamily: 'Inter, Segoe UI, Helvetica Neue, sans-serif',
  fontSizePct: 5,
  bold: true,
  uppercase: false,

  textColour: '#ffffff',
  outlineColour: '#000000',
  outlinePct: 12,
  // A light box by default: white-on-outline is readable over most footage, but
  // not over a bright sky, and the failure is silent.
  backgroundOpacity: 55,
  backgroundColour: '#000000',

  position: 'bottom',
  // Clear of TikTok's own caption furniture, which occupies the lower ~18%.
  marginPct: 20,
  maxLineChars: 32,
  maxLines: 2,

  animation: 'fade',
  // TikTok's own caption highlight is a saturated yellow-green; this is the
  // same idea without borrowing their exact value.
  highlightColour: '#3ce88a',
  letterSpacingPct: 0,
  rotation: 0,
  shadowPct: 0,
};

export const DEFAULT_CAPTION_SETTINGS: CaptionSettings = {
  // Off by default. Captions change the video, cost a re-encode when burned in,
  // and nobody should discover them by finding them already applied.
  mode: 'off',
  source: 'auto',
  targetLanguage: 'auto',
  style: DEFAULT_CAPTION_STYLE,
};
