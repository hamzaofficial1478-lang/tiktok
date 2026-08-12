import { z } from 'zod';
import { ERROR_CODES } from '../errors';
import { DUPLICATE_ACTIONS, LOG_LEVELS, QUEUE_STATUSES, SOURCE_STRATEGIES } from '../types';
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

export const QueueItemSchema = z.object({
  id: z.number(),
  position: z.number(),
  batchId: z.string(),
  rawUrl: z.string(),
  canonicalUrl: z.string().nullable(),
  awemeId: z.string().nullable(),
  status: z.enum(QUEUE_STATUSES),
  progress: z.number(),
  bytesDone: z.number().nullable(),
  bytesTotal: z.number().nullable(),
  attemptCount: z.number(),
  errorCode: z.enum(ERROR_CODES).nullable(),
  errorDetail: z.string().nullable(),
  duplicateAction: z.enum(DUPLICATE_ACTIONS).nullable(),
  createdAt: z.number(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  sourceStrategy: z.enum(SOURCE_STRATEGIES).nullable(),
  watermarkRemoved: z.boolean().nullable(),
});

export const PendingDuplicateSchema = z.object({
  itemId: z.number(),
  batchId: z.string(),
  awemeId: z.string(),
  caption: z.string().nullable(),
  authorHandle: z.string().nullable(),
  existingFilePath: z.string(),
  downloadedAt: z.number(),
});

export const BatchSummarySchema = z.object({
  batchId: z.string(),
  completed: z.number(),
  skipped: z.number(),
  failed: z.number(),
  cancelled: z.number(),
});

export const QueueStateSchema = z.object({
  running: z.boolean(),
  paused: z.boolean(),
  active: z.number(),
});

export const AddLinksResultSchema = z.object({
  batchId: z.string(),
  added: z.number(),
  duplicatesRemoved: z.number(),
  alreadyInQueue: z.number(),
  invalid: z.array(z.object({ rawUrl: z.string(), code: z.enum(ERROR_CODES) })),
  totalFound: z.number(),
});

export const LibraryEntrySchema = z.object({
  downloadId: z.number(),
  awemeId: z.string(),
  canonicalUrl: z.string(),
  authorHandle: z.string().nullable(),
  authorName: z.string().nullable(),
  caption: z.string().nullable(),
  durationMs: z.number().nullable(),
  coverUrl: z.string().nullable(),
  filePath: z.string(),
  fileSize: z.number().nullable(),
  sourceStrategy: z.enum(SOURCE_STRATEGIES).nullable(),
  watermarkRemoved: z.boolean(),
  outroTrimmedMs: z.number().nullable(),
  completedAt: z.number(),
  fileExists: z.boolean(),
  /** Dedup layer 4: same content under a different aweme_id. */
  possibleRepost: z.boolean(),
});

/* ------------------------------------------------------------------ *
 * Renderer -> main (request/response)
 * ------------------------------------------------------------------ */

interface InvokeSpec {
  readonly request: z.ZodType;
  readonly response: z.ZodType;
}

const Ok = z.object({ ok: z.literal(true) });
const ItemId = z.object({ itemId: z.number().int().positive() });

/**
 * `satisfies Record<InvokeChannel, InvokeSpec>` is what keeps channels.ts and
 * this file in lockstep: a name without a schema fails to compile, and a
 * schema without a name does too. `satisfies` rather than a type annotation so
 * the literal shapes survive for InvokeRequest/InvokeResponse inference.
 */
export const invokeContract = {
  'app:getVersions': { request: z.void(), response: VersionsSchema },
  'app:getSidecarStatus': {
    request: z.void(),
    response: z.object({ sidecars: z.array(SidecarStatusSchema), capabilities: MediaCapabilitiesSchema }),
  },
  'app:updateExtractor': {
    request: z.void(),
    response: z.object({ version: z.string().nullable(), updated: z.boolean(), message: z.string() }),
  },
  'config:get': { request: z.void(), response: AppConfigSchema },
  'config:update': { request: AppConfigSchema.partial(), response: AppConfigSchema },
  'log:tail': {
    request: z.object({ limit: z.number().int().min(1).max(5000) }),
    response: z.object({ entries: z.array(LogEntrySchema) }),
  },

  'queue:getSnapshot': {
    request: z.void(),
    response: z.object({ items: z.array(QueueItemSchema), state: QueueStateSchema }),
  },
  'queue:addLinks': {
    request: z.object({ urls: z.array(z.string()).max(5000) }),
    response: AddLinksResultSchema,
  },
  'queue:start': { request: z.void(), response: Ok },
  'queue:pause': { request: z.void(), response: Ok },
  'queue:resume': { request: z.void(), response: Ok },
  'queue:cancelItem': { request: ItemId, response: Ok },
  'queue:retryItem': { request: ItemId, response: Ok },
  'queue:retryAllFailed': { request: z.void(), response: z.object({ retried: z.number() }) },
  'queue:removeItem': { request: ItemId, response: Ok },
  'queue:removeCompleted': { request: z.void(), response: z.object({ removed: z.number() }) },
  'queue:clear': { request: z.void(), response: z.object({ removed: z.number() }) },
  'queue:reorder': {
    request: z.object({ orderedIds: z.array(z.number().int().positive()).max(5000) }),
    response: Ok,
  },
  'queue:getPendingDuplicates': {
    request: z.void(),
    response: z.object({ pending: z.array(PendingDuplicateSchema) }),
  },
  'queue:resolveDuplicate': {
    request: z.object({
      itemId: z.number().int().positive(),
      action: z.enum(DUPLICATE_ACTIONS),
      applyToBatch: z.boolean(),
    }),
    response: Ok,
  },

  'library:list': {
    request: z.object({
      search: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(1000).optional(),
      offset: z.number().int().min(0).optional(),
    }),
    response: z.object({ entries: z.array(LibraryEntrySchema), total: z.number() }),
  },
  'library:deleteRecord': {
    request: z.object({ downloadId: z.number().int().positive() }),
    response: Ok,
  },
  'library:deleteFile': {
    request: z.object({ downloadId: z.number().int().positive() }),
    response: Ok,
  },

  'system:chooseFolder': {
    request: z.void(),
    response: z.object({ path: z.string().nullable() }),
  },
  'system:showInFolder': { request: z.object({ path: z.string() }), response: Ok },
  'system:openPath': { request: z.object({ path: z.string() }), response: Ok },
  'system:testProxy': {
    request: z.object({ proxyUrl: z.string() }),
    response: z.object({
      ok: z.boolean(),
      /** Ready to show verbatim; says what was reached and how, or what failed. */
      message: z.string(),
      latencyMs: z.number().nullable(),
    }),
  },
} as const satisfies Record<InvokeChannel, InvokeSpec>;

export type InvokeContract = typeof invokeContract;
export type InvokeRequest<C extends InvokeChannel> = z.infer<InvokeContract[C]['request']>;
export type InvokeResponse<C extends InvokeChannel> = z.infer<InvokeContract[C]['response']>;

/* ------------------------------------------------------------------ *
 * Main -> renderer (push events)
 *
 * Spec section 4: "Progress and state changes flow main -> renderer as events,
 * never as polling."
 * ------------------------------------------------------------------ */

export const eventContract = {
  'log:entry': LogEntrySchema,
  'sidecars:changed': z.object({
    sidecars: z.array(SidecarStatusSchema),
    capabilities: MediaCapabilitiesSchema,
  }),
  'config:changed': AppConfigSchema,
  'queue:itemUpdated': QueueItemSchema,
  'queue:itemsAdded': z.object({ batchId: z.string(), items: z.array(QueueItemSchema) }),
  'queue:itemRemoved': z.object({ itemId: z.number() }),
  'queue:duplicatePending': PendingDuplicateSchema,
  'queue:duplicateResolved': z.object({ itemId: z.number(), action: z.enum(DUPLICATE_ACTIONS) }),
  'queue:batchComplete': BatchSummarySchema,
  'queue:state': QueueStateSchema,
} as const satisfies Record<EventChannel, z.ZodType>;

export type EventContract = typeof eventContract;
export type EventPayload<C extends EventChannel> = z.infer<EventContract[C]>;

export type Versions = z.infer<typeof VersionsSchema>;
export type SidecarStatus = z.infer<typeof SidecarStatusSchema>;
export type MediaCapabilities = z.infer<typeof MediaCapabilitiesSchema>;
export type LogEntry = z.infer<typeof LogEntrySchema>;
export type SerializedError = z.infer<typeof SerializedErrorSchema>;
export type QueueItemDto = z.infer<typeof QueueItemSchema>;
export type PendingDuplicateDto = z.infer<typeof PendingDuplicateSchema>;
export type BatchSummaryDto = z.infer<typeof BatchSummarySchema>;
export type QueueStateDto = z.infer<typeof QueueStateSchema>;
export type AddLinksResultDto = z.infer<typeof AddLinksResultSchema>;
export type LibraryEntryDto = z.infer<typeof LibraryEntrySchema>;
