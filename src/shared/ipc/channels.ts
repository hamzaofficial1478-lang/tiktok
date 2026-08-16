/**
 * Channel names — deliberately dependency-free.
 *
 * The preload script imports this module and nothing else from the contract,
 * because a preload running with `sandbox: true` cannot `require` anything
 * from node_modules. Importing contract.ts there would drag zod into the
 * preload bundle, which either fails at runtime or bloats the most
 * security-sensitive file in the app.
 *
 * These lists are not a second source of truth: contract.ts declares its
 * schema map `satisfies Record<InvokeChannel, …>`, so a channel added here
 * without a schema — or a schema added there without a name here — is a
 * compile error, not a runtime surprise.
 */

export const INVOKE_CHANNELS = [
  'app:getVersions',
  'app:getSidecarStatus',
  'app:updateExtractor',
  'app:installFfmpeg',
  'app:whisperStatus',
  'app:installWhisper',
  'config:get',
  'config:update',
  'log:tail',

  'queue:getSnapshot',
  'queue:addLinks',
  'queue:expandProfile',
  'creators:list',
  'creators:add',
  'creators:update',
  'creators:remove',
  'creators:plan',
  'creators:run',
  'creators:cancelRun',
  'queue:start',
  'queue:pause',
  'queue:resume',
  'queue:cancelItem',
  'queue:retryItem',
  'queue:retryAllFailed',
  'queue:removeItem',
  'queue:removeCompleted',
  'queue:clear',
  'queue:reorder',
  'queue:getPendingDuplicates',
  'queue:resolveDuplicate',
  'queue:getPendingPhotoPosts',
  'queue:resolvePhotoPost',

  'library:list',
  'library:dailyStats',
  'library:deleteRecord',
  'library:clearRecords',
  'library:deleteFile',

  'system:getResources',
  'system:chooseFolder',
  'system:showInFolder',
  'system:openPath',
  'system:testProxy',
] as const;

export type InvokeChannel = (typeof INVOKE_CHANNELS)[number];

export const EVENT_CHANNELS = [
  'log:entry',
  'sidecars:changed',
  'sidecars:installProgress',
  'whisper:installProgress',
  'config:changed',
  'queue:itemUpdated',
  'queue:itemProgress',
  'queue:itemsAdded',
  'queue:itemRemoved',
  'queue:duplicatePending',
  'queue:photoPending',
  'queue:photoResolved',
  'queue:duplicateResolved',
  'creators:progress',
  'queue:batchComplete',
  'queue:state',
] as const;

export type EventChannel = (typeof EVENT_CHANNELS)[number];
