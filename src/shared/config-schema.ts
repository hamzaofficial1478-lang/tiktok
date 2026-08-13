import { z } from 'zod';
import { OUTRO_MODES, WATERMARK_MODES, LOG_LEVELS } from './types';

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
   * Dedup layer 4's repost badge. Off by default because computing a
   * perceptual hash means decoding the video with ffmpeg — a second full pass
   * over every file, for a badge most users never look at.
   */
  detectReposts: z.boolean(),
  /** Check for a newer yt-dlp at start-up. On by default: a stale extractor is the most common cause of every download failing. */
  autoUpdateExtractor: z.boolean(),

  hardwareAcceleration: z.boolean(),
  /** Empty string means no proxy. Validated as a URL only when non-empty. */
  proxyUrl: z
    .string()
    .refine((v) => v === '' || /^(https?|socks5h?):\/\/\S+$/i.test(v), 'Proxy must be an http(s):// or socks5:// URL'),

  reduceEffects: z.boolean(),
  logLevel: z.enum(LOG_LEVELS),

  /** Bumped by migrations if the config shape ever changes. */
  schemaVersion: z.number().int().min(1),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

export const CONFIG_SCHEMA_VERSION = 3;

export const DEFAULT_CONFIG: AppConfig = {
  outputDir: '',
  // Numbered by paste order first, so the output folder reads in the same
  // order the links were pasted, then identified so a file is still
  // recognisable once it is out of that folder.
  filenameTemplate: '{n:3} - {author} - {id}',

  concurrency: 1,
  rateLimitMs: 1_500,
  rateLimitJitterMs: 400,

  watermarkMode: 'auto',
  outroMode: 'never',

  audioOnly: false,
  detectReposts: false,
  autoUpdateExtractor: true,

  hardwareAcceleration: true,
  proxyUrl: '',

  reduceEffects: false,
  logLevel: 'info',

  schemaVersion: CONFIG_SCHEMA_VERSION,
};
