import { ONCE_ONLY_STAGES, type PipelineStage, type StageState } from '@shared/stages';
import type { ResumeState } from '../queue/types';

/**
 * Keeps track of which step the pipeline is on and which are already banked.
 *
 * Two jobs, both of which the pipeline used to do implicitly and neither of
 * which it recorded:
 *
 *  - **Say what is happening.** Every step announces itself, so the queue row
 *    can name it and, when the attempt throws, name the step it threw in.
 *  - **Remember what not to do twice.** A step that rewrites the file is banked
 *    the moment it succeeds, together with whatever it concluded. The next
 *    attempt reads the note, skips those steps, and starts at the one that
 *    failed — rather than starting at the link and downloading the video again.
 *
 * Kept out of the pipeline itself because it is bookkeeping with rules
 * (`ONCE_ONLY_STAGES`, the ordering of `started` before `done`) that are much
 * easier to get right in one place than sprinkled through a 500-line method.
 */
export class StageTracker {
  private readonly finished: Set<PipelineStage>;
  private filePath: string | null;
  private banked: Omit<ResumeState, 'filePath' | 'done'>;

  constructor(
    private readonly hooks: {
      readonly resume?: ResumeState | undefined;
      readonly onStage?: ((stage: PipelineStage, state: StageState) => void) | undefined;
      readonly onResumable?: ((state: ResumeState) => void) | undefined;
    },
  ) {
    this.finished = new Set(hooks.resume?.done ?? []);
    this.filePath = hooks.resume?.filePath ?? null;
    const { filePath: _path, done: _done, ...rest } = hooks.resume ?? { filePath: '', done: [] };
    this.banked = rest;
  }

  /** Did a previous attempt already finish this step? */
  isDone(stage: PipelineStage): boolean {
    return this.finished.has(stage);
  }

  /** What a previous attempt concluded, for steps this one is skipping. */
  get carried(): Omit<ResumeState, 'filePath' | 'done'> {
    return this.banked;
  }

  start(stage: PipelineStage): void {
    this.hooks.onStage?.(stage, 'started');
  }

  /** Announced rather than silent: "already done" is information, not a no-op. */
  skip(stage: PipelineStage): void {
    this.hooks.onStage?.(stage, 'skipped');
  }

  /**
   * The step went wrong without taking the item down with it.
   *
   * Deliberately does *not* mark the step finished: it did not happen, so a
   * later attempt should do it rather than skip it.
   */
  failed(stage: PipelineStage): void {
    this.hooks.onStage?.(stage, 'failed');
  }

  /**
   * The bytes are on disk under their final name.
   *
   * Everything banked from here on is anchored to this path, and nothing is
   * resumable before it — there is nothing to resume from until a file exists.
   */
  committed(filePath: string, bytes: number): void {
    this.filePath = filePath;
    this.banked = { ...this.banked, bytes };
  }

  /**
   * Marks a step finished, with anything it concluded that must not be
   * recomputed by doing the step again.
   */
  done(stage: PipelineStage, concluded: Partial<Omit<ResumeState, 'filePath' | 'done'>> = {}): void {
    this.finished.add(stage);
    this.banked = { ...this.banked, ...concluded };
    this.hooks.onStage?.(stage, 'done');
    // Steps that only measure or read are not banked: they are cheap, and their
    // results are inputs the steps after them need computed fresh.
    if (ONCE_ONLY_STAGES.includes(stage)) this.publish();
  }

  private publish(): void {
    if (!this.filePath || !this.hooks.onResumable) return;
    this.hooks.onResumable({
      filePath: this.filePath,
      done: [...this.finished].filter((stage) => ONCE_ONLY_STAGES.includes(stage)),
      ...this.banked,
    });
  }
}
