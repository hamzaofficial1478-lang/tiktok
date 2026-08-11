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
 * Bounds come straight from the spec: concurrency 1-4 (section 8), rate limit
 * 0.5-10s (section 8). Values outside those are rejected rather than clamped,
 * because silently clamping a user's setting is how you get a support ticket
 * about a slider that "doesn't work".
 */

export const FilenameTemplateSchema = z
  .string()
  .min(1, 'Filename template cannot be empty')
  .max(200)
  .refine((t) => !/[\\/]/.test(t), 'Filename template cannot contain path separators')
  .refine((t) => /\{(id|index)\}/.test(t), {
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

  /** 'best' picks the highest resolution clean stream available. */
  qualityPreference: z.enum(['best', '1080p', '720p', '480p']),
  audioOnly: z.boolean(),
  saveThumbnail: z.boolean(),
  saveMetadataSidecar: z.boolean(),
  saveSubtitles: z.boolean(),

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

export const CONFIG_SCHEMA_VERSION = 1;

export const DEFAULT_CONFIG: AppConfig = {
  outputDir: '',
  filenameTemplate: '{author} - {id}',

  concurrency: 1,
  rateLimitMs: 1_500,
  rateLimitJitterMs: 400,

  watermarkMode: 'auto',
  outroMode: 'ask',

  qualityPreference: 'best',
  audioOnly: false,
  saveThumbnail: true,
  saveMetadataSidecar: false,
  saveSubtitles: false,

  hardwareAcceleration: true,
  proxyUrl: '',

  reduceEffects: false,
  logLevel: 'info',

  schemaVersion: CONFIG_SCHEMA_VERSION,
};
