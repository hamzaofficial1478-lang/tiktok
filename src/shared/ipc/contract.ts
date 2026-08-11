import { z } from 'zod';
import { ERROR_CODES } from '../errors';
import { LOG_LEVELS } from '../types';
import { AppConfigSchema } from '../config-schema';
import { INVOKE_CHANNELS, EVENT_CHANNELS, type InvokeChannel, type EventChannel } from './channels';

export { INVOKE_CHANNELS, EVENT_CHANNELS };
export type { InvokeChannel, EventChannel };

/**
 * The IPC contract — spec section 4: "Every privileged action is an IPC call
 * with a validated payload."
 *
 * This file is the single place a channel is declared. Main derives its
 * handler signatures from it, preload derives the bridge surface from it, and
 * the renderer derives its client types from it. A channel that is not here
 * cannot be called: the preload bridge only forwards known names, so a typo in
 * the renderer is a compile error rather than a silently dead call.
 *
 * Adding a channel in later phases means adding one entry here and one handler
 * in main/ipc — nothing else.
 */

/* ------------------------------------------------------------------ *
 * Common payload shapes
 * ------------------------------------------------------------------ */

export const SerializedErrorSchema = z.object({
  code: z.enum(ERROR_CODES),
  message: z.string(),
  detail: z.string().optional(),
});

export const VersionsSchema = z.object({
  app: z.string(),
  electron: z.string(),
  chrome: z.string(),
  node: z.string(),
  /** null when the sidecar is missing — the UI shows "not installed", not "unknown". */
  ffmpeg: z.string().nullable(),
  ytDlp: z.string().nullable(),
});

export const SidecarStatusSchema = z.object({
  name: z.enum(['ffmpeg', 'ffprobe', 'yt-dlp']),
  path: z.string().nullable(),
  present: z.boolean(),
  /** false when the on-disk hash does not match the shipped manifest. */
  checksumValid: z.boolean().nullable(),
  version: z.string().nullable(),
  error: z.string().nullable(),
});

export const MediaCapabilitiesSchema = z.object({
  probed: z.boolean(),
  /** LGPL builds report no "--enable-gpl" in their configuration string. */
  isGplBuild: z.boolean().nullable(),
  filters: z.record(z.string(), z.boolean()),
  encoders: z.record(z.string(), z.boolean()),
  missingRequired: z.array(z.string()),
});

export const LogEntrySchema = z.object({
  time: z.number(),
  level: z.enum(LOG_LEVELS),
  scope: z.string(),
  msg: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
});

/* ------------------------------------------------------------------ *
 * Renderer -> main (request/response)
 * ------------------------------------------------------------------ */

interface InvokeSpec {
  readonly request: z.ZodType;
  readonly response: z.ZodType;
}

/**
 * `satisfies Record<InvokeChannel, InvokeSpec>` is what keeps channels.ts and
 * this file in lockstep: a name without a schema fails to compile, and a
 * schema without a name does too. `satisfies` rather than a type annotation so
 * the literal shapes survive for InvokeRequest/InvokeResponse inference.
 */
export const invokeContract = {
  'app:getVersions': {
    request: z.void(),
    response: VersionsSchema,
  },
  'app:getSidecarStatus': {
    request: z.void(),
    response: z.object({
      sidecars: z.array(SidecarStatusSchema),
      capabilities: MediaCapabilitiesSchema,
    }),
  },
  'config:get': {
    request: z.void(),
    response: AppConfigSchema,
  },
  'config:update': {
    request: AppConfigSchema.partial(),
    response: AppConfigSchema,
  },
  'log:tail': {
    request: z.object({ limit: z.number().int().min(1).max(5000) }),
    response: z.object({ entries: z.array(LogEntrySchema) }),
  },
} as const satisfies Record<InvokeChannel, InvokeSpec>;

export type InvokeContract = typeof invokeContract;
export type InvokeRequest<C extends InvokeChannel> = z.infer<InvokeContract[C]['request']>;
export type InvokeResponse<C extends InvokeChannel> = z.infer<InvokeContract[C]['response']>;

/* ------------------------------------------------------------------ *
 * Main -> renderer (push events)
 *
 * Spec section 4: "Progress and state changes flow main -> renderer as events,
 * never as polling." Phase 1 only needs log streaming; queue progress events
 * land here in phase 3.
 * ------------------------------------------------------------------ */

export const eventContract = {
  'log:entry': LogEntrySchema,
  'sidecars:changed': z.object({
    sidecars: z.array(SidecarStatusSchema),
    capabilities: MediaCapabilitiesSchema,
  }),
  'config:changed': AppConfigSchema,
} as const satisfies Record<EventChannel, z.ZodType>;

export type EventContract = typeof eventContract;
export type EventPayload<C extends EventChannel> = z.infer<EventContract[C]>;

export type Versions = z.infer<typeof VersionsSchema>;
export type SidecarStatus = z.infer<typeof SidecarStatusSchema>;
export type MediaCapabilities = z.infer<typeof MediaCapabilitiesSchema>;
export type LogEntry = z.infer<typeof LogEntrySchema>;
export type SerializedError = z.infer<typeof SerializedErrorSchema>;
