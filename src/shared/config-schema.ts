import { z } from 'zod';
import { BROWSER_COOKIE_SOURCES, OUTRO_MODES, PHOTO_SLIDESHOW_MODES, WATERMARK_MODES, LOG_LEVELS } from './types';
import { CaptionSettingsSchema, DEFAULT_CAPTION_SETTINGS } from './caption-schema';

/**
 * AppConfig — spec section 13: "keep a single AppConfig module rather than
 * reading settings from twelve places".
 *
 * The schema lives in shared/ because the Settings screen validates against
 * the identical rules the main process enforces, so an out-of-range value is
 * caught while typing rather than after a round trip. Defaults are declared
 * here and nowhere else; there is no second copy in the UI.
 *
 * Deliberately smaller than the original brief. Resolution choice, thumbnail
 * saving, the metadata sidecar and subtitle downloading were all removed: each
 * one asked the user a question they did not want to answer, and two of them
 * cost a full pass over the file with ffmpeg. Removing them is what makes the
 * common download path spawn no subprocess at all.
 *
 * Removed keys in an existing config.json are simply ignored — zod strips
 * unknown properties — so an upgrade needs no migration.
 */

export const FilenameTemplateSchema = z
  .string()
  .min(1, 'Filename template cannot be empty')
  .max(200)
  .refine((t) => !/[\\/]/.test(t), 'Filename template cannot contain path separators')
  // {n} is deliberately NOT accepted as the uniqueness token: it restarts at 1
  // for every paste, so a template of only {n} collides across batches and the
  // second batch silently becomes "001 (2)". {index} is the global counter and
  // is the right choice for pure sequential naming.
  .refine((t) => /\{(id|index)(?::\d+)?\}/.test(t), {
    message: 'Template must include {id} or {index} so filenames stay unique',
  });

export const AppConfigSchema = z.object({
  /** Empty string means "not chosen yet" — first run resolves it to ~/Videos/TikTok. */
  outputDir: z.string(),
  filenameTemplate: FilenameTemplateSchema,

  concurrency: z.number().int().min(1).max(4),
  /** Minimum gap between outbound resolution requests, milliseconds. */
  rateLimitMs: z.number().int().min(500).max(10_000),
  rateLimitJitterMs: z.number().int().min(0).max(2_000),

  watermarkMode: z.enum(WATERMARK_MODES),
  outroMode: z.enum(OUTRO_MODES),

  audioOnly: z.boolean(),

  /**
   * What to do with a photo slideshow.
   *
   * TikTok posts these through the same URL shape as a video and they carry no
   * video track at all, so they used to fail with "no video streams were
   * offered" — a message that reads like a broken app rather than a post that
   * is a set of images. Nor is refusing them obviously right: a slideshow is
   * still a thing someone linked to on purpose.
   *
   * 'ask' puts the question to the user once per post and remembers the answer
   * in the link ledger, so the same slideshow is never raised twice. The other
   * two are for anyone who has already decided.
   */
  photoSlideshows: z.enum(PHOTO_SLIDESHOW_MODES),

  /**
   * File every download under a folder named after the account that posted it.
   *
   * Queueing a whole account already did this — its videos went into a folder
   * of its own. Pasting a handful of links from three different creators did
   * not, so they landed loose together in the output folder, and the only way
   * to get the tidy version was to fetch each account separately. The two
   * paths produce the same shape now.
   *
   * The handle is only known once the video resolves, which is why this is
   * applied at download time rather than when the link is added: a short link
   * gives away nothing about who posted it.
   */
  groupByCreator: z.boolean(),

  /**
   * Never download H.265, even when it is the higher resolution on offer.
   *
   * TikTok serves the same video as H.264 and H.265, and sometimes offers H.265
   * at a resolution it has no H.264 for. Windows cannot decode H.265 without
   * the HEVC Video Extensions from the Store — a paid add-on — and Films & TV
   * and Media Player both show a black picture rather than saying so. A file
   * that will not play is worth less than a slightly smaller one that will.
   *
   * Off by default because it can cost a resolution step and the app's standing
   * rule is not to trade picture quality. On, it guarantees every download
   * opens in anything.
   */
  forceH264: z.boolean(),

  /**
   * Start the app when you sign in to the machine.
   *
   * An interrupted queue already resumes exactly where it stopped — but only
   * once something starts the app, and until now that something was a person
   * remembering to. This is what turns "it survives a power cut" into "you do
   * not have to notice there was one".
   *
   * Off by default. Adding an entry to a machine's startup without being asked
   * is precisely the behaviour that makes people distrust software, so it is a
   * switch rather than an assumption.
   */
  startOnLogin: z.boolean(),

  /**
   * Dedup layer 4's repost badge. Off by default because computing a
   * perceptual hash means decoding the video with ffmpeg — a second full pass
   * over every file, for a badge most users never look at.
   */
  detectReposts: z.boolean(),
  /** Check for a newer yt-dlp at start-up. On by default: a stale extractor is the most common cause of every download failing. */
  autoUpdateExtractor: z.boolean(),
  /**
   * Borrow TikTok cookies from an installed browser.
   *
   * The decisive case: the video plays fine in the browser and the app is
   * refused. That difference is the session, not the network, and this is the
   * only setting that closes it without a proxy.
   */
  browserCookies: z.enum(BROWSER_COOKIE_SOURCES),
  /**
   * Force IPv4 for every outbound request.
   *
   * TikTok's CDN answers some IPv6 clients with 403 while serving the same
   * request over IPv4. On by default because the cost of being wrong is one
   * address family, and the cost of the alternative is every download failing.
   */
  forceIpv4: z.boolean(),

  captions: CaptionSettingsSchema,
  /**
   * Write a title and description beside each download.
   *
   * Both are extracted from what the video actually says — see metadata/seo.ts.
   * Off by default: it writes a second file into the output folder, and a
   * folder that gains files nobody asked for is a folder people stop trusting.
   */
  seoMetadata: z.boolean(),

  hardwareAcceleration: z.boolean(),
  /** Empty string means no proxy. Validated as a URL only when non-empty. */
  proxyUrl: z
    .string()
    .refine((v) => v === '' || /^(https?|socks5h?):\/\/\S+$/i.test(v), 'Proxy must be an http(s):// or socks5:// URL'),

  /**
   * The device identity the mobile-app route presents to TikTok.
   *
   * Not a setting — there is no Settings control for it and no reason for
   * anyone to type one. It lives here because it has to survive restarts:
   * yt-dlp's app-API path is only taken when a device ID is supplied, and one
   * that changes on every launch is the signature of a bot rather than a
   * phone. Empty means "not generated yet"; start-up fills it in.
   */
  deviceId: z.string().regex(/^\d*$/, 'Device ID must be numeric'),
  /**
   * The install identity that goes with the device.
   *
   * Also not a setting. TikTok's app API is sent a device id, an install id
   * and an openudid together; supplying only the device left the install id
   * absent, because `filter_dict` in `_build_api_query` drops it when it is
   * None. A device with no install behind it is not a shape a real phone
   * produces. Kept for the same reason the device id is: one that changes
   * every launch is the signature of a script.
   */
  installId: z.string().regex(/^\d*$/, 'Install ID must be numeric'),

  reduceEffects: z.boolean(),
  logLevel: z.enum(LOG_LEVELS),

  /** Bumped by migrations if the config shape ever changes. */
  schemaVersion: z.number().int().min(1),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

export const CONFIG_SCHEMA_VERSION = 5;

export const DEFAULT_CONFIG: AppConfig = {
  outputDir: '',
  // Numbered by paste order first, so the output folder reads in the same
  // order the links were pasted, then identified so a file is still
  // recognisable once it is out of that folder.
  /**
   * `{index}`, not `{n}`, and the difference is the whole of a real bug.
   *
   * `{n}` numbers a link within its own paste, so it restarts at 001 for every
   * new paste and for every account a creator run visits. Five videos added in
   * two goes came out 001, 002, 003, 001, 002 — the same numbers twice, in a
   * folder meant to read in the order things were added.
   *
   * `{index}` is the counter that never restarts: it is allocated from a value
   * kept in the database, so it survives clearing the queue, closing the app
   * and starting a new batch. Existing configs holding the old default are
   * migrated to this one; a template someone edited themselves is left alone.
   */
  filenameTemplate: '{index:3} - {author} - {id}',

  concurrency: 1,
  rateLimitMs: 1_500,
  rateLimitJitterMs: 400,

  watermarkMode: 'auto',
  // On by default: a TikTok end card is not part of the video anyone wanted,
  // and the rails in outro-detector.ts are strict enough that the failure mode
  // is "did nothing" rather than "cut something real".
  outroMode: 'always',

  audioOnly: false,
  // Ask, because neither answer is right for everyone and the question is
  // asked at most once per post.
  photoSlideshows: 'ask',
  // On, because the alternative is a single folder that becomes unusable at a
  // few hundred files, and every account already had this when queued whole.
  groupByCreator: true,
  forceH264: false,
  startOnLogin: false,
  detectReposts: false,
  autoUpdateExtractor: true,
  browserCookies: 'none',
  forceIpv4: true,

  captions: DEFAULT_CAPTION_SETTINGS,
  seoMetadata: false,

  hardwareAcceleration: true,
  proxyUrl: '',

  deviceId: '',
  installId: '',

  reduceEffects: false,
  logLevel: 'info',

  schemaVersion: CONFIG_SCHEMA_VERSION,
};
