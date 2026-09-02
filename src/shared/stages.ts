/**
 * The named steps a download passes through, shared by main and the renderer.
 *
 * ## Why these have names at all
 *
 * A download is not one operation. It is a lookup, a transfer, a check, a
 * colour measurement, a watermark pass, a caption pass and a finishing encode —
 * and until now the interface described all seven as "Downloading…" followed,
 * if something went wrong, by a sentence about whatever threw. Someone watching
 * a video sit at 100% for four minutes had no way to know whether it was
 * re-encoding, transcribing, or stuck; someone whose item failed was told the
 * error but not the step, so "it failed" and "it failed at colour correction"
 * were the same message.
 *
 * Naming the steps buys two things that are worth the column they cost:
 *
 *  - The user can see what is happening and, on a failure, which part of the
 *    job produced it. That is the difference between a bug report that says
 *    "downloads keep failing" and one that says "it fails at the finishing
 *    pass", and the second one is fixable.
 *  - The queue can **resume**. A failure after the bytes are on disk used to
 *    fail the whole item, and the retry started from the link — re-fetching a
 *    video that was already sitting in the output folder, under a second name.
 *    With the finished steps written down, a retry picks up at the step that
 *    failed instead of at the beginning.
 */

export const PIPELINE_STAGES = [
  'resolve',
  'download',
  'verify',
  'colour',
  'watermark',
  'captions',
  'finish',
  'record',
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/**
 * `started` and then exactly one of the other three.
 *
 * `failed` is separate from a thrown error on purpose. The watermark, caption
 * and finishing passes are all caught — a filter chain misbehaving must never
 * cost someone a video that downloaded perfectly well — so from the item's
 * point of view they succeed, and the only trace of them going wrong was a line
 * in a log nobody reads. `failed` is how that reaches the row: the item
 * completes, and it can still say the finishing pass did not run.
 */
export type StageState = 'started' | 'done' | 'skipped' | 'failed';

/**
 * What each step is called in front of a person.
 *
 * Present tense, because they are shown while the step is running. The failure
 * wording adds "Failed while …" around them rather than needing a second table.
 */
export const STAGE_LABELS: Record<PipelineStage, string> = {
  resolve: 'Looking up the video',
  download: 'Downloading',
  verify: 'Checking the file',
  colour: 'Measuring colour',
  watermark: 'Removing the watermark',
  captions: 'Adding captions',
  finish: 'Finishing and sharpening',
  record: 'Saving to the library',
};

/**
 * Steps that rewrite the file, and so must never run a second time on it.
 *
 * This is the list that makes resuming safe. Re-running the transfer would
 * fetch the video again; re-running the watermark, caption or finishing pass
 * would put an already-encoded file through another generation of compression
 * and burn a second copy of the captions onto frames that already have them.
 *
 * Everything not in this list is either a measurement (`colour`), a lookup
 * (`resolve`) or a database write (`record`) — all of them safe to repeat, all
 * of them things a resumed attempt genuinely needs to do again, because their
 * results are inputs to the steps that follow.
 */
export const ONCE_ONLY_STAGES: readonly PipelineStage[] = [
  'download',
  'verify',
  'watermark',
  'captions',
  'finish',
];

export function isPipelineStage(value: unknown): value is PipelineStage {
  return typeof value === 'string' && (PIPELINE_STAGES as readonly string[]).includes(value);
}

/** "Removing the watermark" → "Failed while removing the watermark". */
export function describeStageFailure(stage: PipelineStage): string {
  const label = STAGE_LABELS[stage];
  return `Failed while ${label.charAt(0).toLowerCase()}${label.slice(1).toLowerCase()}`;
}
