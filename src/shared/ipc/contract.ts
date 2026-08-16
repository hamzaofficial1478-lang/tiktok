import { z } from 'zod';
import { ERROR_CODES } from '../errors';
import { DUPLICATE_ACTIONS, LOG_LEVELS, QUEUE_STATUSES, SOURCE_STRATEGIES } from '../types';
import { AppConfigSchema } from '../config-schema';
import { CAPTION_MODES } from '../caption-schema';
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
/** A saved account, as the Creators panel renders it. */
export const CreatorSchema = z.object({
  id: z.number(),
  handle: z.string(),
  profileUrl: z.string(),
  videoLimit: z.number(),
  captionMode: z.enum(CAPTION_MODES).nullable(),
  enabled: z.boolean(),
  addedAt: z.number(),
  lastQueuedAt: z.number().nullable(),
  videosQueued: z.number(),
});
export type CreatorDto = z.infer<typeof CreatorSchema>;

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
  'app:installFfmpeg': {
    request: z.void(),
    response: z.object({ installed: z.boolean(), version: z.string().nullable(), message: z.string() }),
  },
  'app:whisperStatus': {
    request: z.void(),
    response: z.object({ installed: z.boolean(), model: z.string().nullable() }),
  },
  'app:installWhisper': {
    request: z.object({ model: z.enum(['tiny.en', 'base.en', 'small.en']).optional() }),
    response: z.object({ installed: z.boolean(), model: z.string().nullable(), message: z.string() }),
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
    request: z.object({
      urls: z.array(z.string()).max(5000),
      /**
       * Folder under the output directory these belong in — the account's
       * handle, when a whole profile was queued. Sanitised and confined to the
       * output folder in main; this is a name, never a path.
       */
      subfolder: z.string().max(64).nullable().optional(),
    }),
    response: AddLinksResultSchema,
  },
  /**
   * Lists an account's videos so a whole profile can be queued from one paste.
   *
   * Deliberately separate from `queue:addLinks` and deliberately not additive:
   * it returns the links and queues nothing. Listing an account is a network
   * call that can take a minute and can come back with two hundred videos, and
   * turning a single paste into two hundred downloads without showing the user
   * the list first is not a shortcut, it is a surprise.
   */
  'queue:expandProfile': {
    request: z.object({
      input: z.string().min(1).max(300),
      /**
       * Absent means every video the account has, which is the default and what
       * the UI sends. A limit is honoured when one is given, but none is
       * imposed: "the newest 500" is not what asking for a creator's videos
       * means, and a cap that quietly drops the rest is worse than a listing
       * that takes longer.
       */
      limit: z.number().int().min(1).max(20_000).optional(),
    }),
    response: z.object({
      handle: z.string(),
      profileUrl: z.string(),
      urls: z.array(z.string()),
      truncated: z.boolean(),
    }),
  },
  /**
   * The saved creator list — many accounts, each with its own count.
   *
   * Kept apart from `queue:addLinks` because it is a different kind of thing:
   * a standing list that survives restarts, rather than one paste. The run is
   * sequential and reports progress per account over `creators:progress`.
   */
  'creators:list': { request: z.void(), response: z.object({ creators: z.array(CreatorSchema) }) },
  'creators:add': {
    request: z.object({
      // One box, many links: pasting ten profile URLs at once is the point.
      input: z.string().min(1).max(20_000),
      videoLimit: z.number().int().min(1).max(1000).optional(),
    }),
    response: z.object({
      creators: z.array(CreatorSchema),
      added: z.number(),
      alreadySaved: z.array(z.string()),
      invalid: z.array(z.string()),
    }),
  },
  'creators:update': {
    request: z.object({
      id: z.number().int().positive(),
      videoLimit: z.number().int().min(1).max(1000).optional(),
      captionMode: z.enum(CAPTION_MODES).nullable().optional(),
      enabled: z.boolean().optional(),
    }),
    response: z.object({ creator: CreatorSchema.nullable() }),
  },
  'creators:remove': { request: z.object({ id: z.number().int().positive() }), response: Ok },
  /**
   * What pressing Run will actually fetch, before anything is fetched.
   *
   * Answered from the ledger alone — no network call — so the button can carry
   * a truthful number instead of the sum of everyone's limit, which never
   * moved and went on offering to download videos that were already on disk.
   */
  'creators:plan': {
    request: z.void(),
    response: z.object({
      creators: z.array(
        z.object({
          creatorId: z.number(),
          handle: z.string(),
          enabled: z.boolean(),
          videoLimit: z.number(),
          taken: z.number(),
          remaining: z.number(),
        }),
      ),
      accountsToVisit: z.number(),
      remaining: z.number(),
      taken: z.number(),
    }),
  },
  'creators:run': { request: z.void(), response: z.object({ queued: z.number(), creators: z.number() }) },
  'creators:cancelRun': { request: z.void(), response: Ok },

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
  /**
   * Clears the library's record of every download; deletes no files.
   *
   * Wiping the record also wipes what duplicate detection compares against, so
   * a video downloaded before this will not be recognised as a duplicate
   * afterwards. That is a consequence worth stating rather than discovering.
   */
  'library:clearRecords': { request: z.void(), response: z.object({ removed: z.number() }) },
  'library:deleteFile': {
    request: z.object({ downloadId: z.number().int().positive() }),
    response: Ok,
  },

  /**
   * What the app is costing the machine, polled by the status bar.
   *
   * GPU is a name and an on/off, never a percentage: Electron exposes no GPU
   * utilisation measurement, and a number invented from the GPU process's CPU
   * time would look authoritative and mean nothing.
   */
  'system:getResources': {
    request: z.void(),
    response: z.object({
      cpuPercent: z.number(),
      systemCpuPercent: z.number().nullable(),
      memoryBytes: z.number(),
      systemMemoryUsedBytes: z.number().nullable(),
      systemMemoryBytes: z.number().nullable(),
      processCount: z.number(),
      gpu: z
        .object({ name: z.string(), accelerated: z.boolean(), memoryBytes: z.number() })
        .nullable(),
    }),
  },
  'system:chooseFolder': {
    request: z.void(),
    response: z.object({ path: z.string().nullable() }),
  },
  'system:showInFolder': { request: z.object({ path: z.string() }), response: Ok },
  'library:dailyStats': {
    request: z.object({ days: z.number().int().min(1).max(365) }),
    response: z.object({
      days: z.array(
        z.object({
          day: z.string(),
          downloads: z.number(),
          watermarkFree: z.number(),
          reEncoded: z.number(),
          bytes: z.number(),
        }),
      ),
    }),
  },
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
  'sidecars:installProgress': z.object({
    name: z.string(),
    phase: z.enum(['downloading', 'extracting', 'verifying', 'done', 'failed']),
    receivedBytes: z.number(),
    totalBytes: z.number().nullable(),
    message: z.string().nullable(),
  }),
  'config:changed': AppConfigSchema,
  'queue:itemUpdated': QueueItemSchema,
  /** Volatile: never persisted, never replayed on reconnect. */
  'queue:itemProgress': z.object({
    itemId: z.number(),
    bytesDone: z.number(),
    bytesTotal: z.number().nullable(),
    /** Bytes per second, instantaneous. */
    speed: z.number().nullable(),
    etaMs: z.number().nullable(),
  }),
  'queue:itemsAdded': z.object({ batchId: z.string(), items: z.array(QueueItemSchema) }),
  'queue:itemRemoved': z.object({ itemId: z.number() }),
  'queue:duplicatePending': PendingDuplicateSchema,
  'queue:duplicateResolved': z.object({ itemId: z.number(), action: z.enum(DUPLICATE_ACTIONS) }),
  'queue:batchComplete': BatchSummarySchema,
  'queue:state': QueueStateSchema,
  'whisper:installProgress': z.object({
    phase: z.enum(['resolving', 'downloading-program', 'downloading-model', 'extracting', 'verifying', 'done']),
    receivedBytes: z.number(),
    totalBytes: z.number().nullable(),
    message: z.string(),
  }),
  'creators:progress': z.object({
    creatorId: z.number(),
    handle: z.string(),
    phase: z.enum(['listing', 'queued', 'downloading', 'done', 'failed', 'nothing-new']),
    queued: z.number(),
    index: z.number(),
    total: z.number(),
    message: z.string().optional(),
  }),
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
