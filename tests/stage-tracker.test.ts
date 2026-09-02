import { describe, expect, it } from 'vitest';
import { StageTracker } from '@main/download/stage-tracker';
import { ONCE_ONLY_STAGES, PIPELINE_STAGES, describeStageFailure } from '@shared/stages';
import type { ResumeState } from '@main/queue/types';
import type { PipelineStage, StageState } from '@shared/stages';

function collect(resume?: ResumeState): {
  tracker: StageTracker;
  events: string[];
  notes: ResumeState[];
} {
  const events: string[] = [];
  const notes: ResumeState[] = [];
  const tracker = new StageTracker({
    resume,
    onStage: (stage: PipelineStage, state: StageState) => events.push(`${stage}:${state}`),
    onResumable: (state) => notes.push(state),
  });
  return { tracker, events, notes };
}

/**
 * The bookkeeping that decides what a retry does.
 *
 * Small enough to look harmless, and it is the whole of the difference between
 * "the retry finishes the job" and "the retry downloads the video again". Two
 * rules carry it: only steps that rewrite the file are banked, and nothing is
 * banked before there is a file to bank it against.
 */
describe('the stage tracker', () => {
  it('says nothing is done before an attempt has banked anything', () => {
    const { tracker } = collect();
    for (const stage of PIPELINE_STAGES) expect(tracker.isDone(stage)).toBe(false);
  });

  it('does not offer a resume point until the bytes are somewhere', () => {
    const { tracker, notes } = collect();
    tracker.start('download');
    tracker.done('download');

    /**
     * The transfer finishing is not the same as the file existing.
     *
     * At this moment the bytes are in a `.part` under a name nothing else knows
     * about. A note pointing there would send the next attempt to a file that
     * `commitPart` may never have renamed.
     */
    expect(notes).toEqual([]);
  });

  it('offers one the moment the file has its final name', () => {
    const { tracker, notes } = collect();
    tracker.start('download');
    tracker.done('download');
    tracker.committed('/out/video.mp4', 2_048);
    tracker.done('verify');

    expect(notes).toHaveLength(1);
    expect(notes[0]?.filePath).toBe('/out/video.mp4');
    expect(notes[0]?.done).toEqual(['download', 'verify']);
    expect(notes[0]?.bytes).toBe(2_048);
  });

  it('banks only the steps that rewrite the file', () => {
    const { tracker, notes } = collect();
    tracker.committed('/out/video.mp4', 1);
    tracker.done('verify');
    tracker.done('colour');

    /**
     * A measurement is not banked, and that is deliberate rather than an
     * oversight: its answer is an input to the watermark and finishing passes,
     * so a resumed attempt that skipped it would run those passes with no
     * correction at all — silently producing exactly the dull output the colour
     * step exists to fix.
     */
    const latest = notes[notes.length - 1];
    expect(latest?.done).not.toContain('colour');
    expect(latest?.done).toEqual(['verify']);
  });

  it('does not bank a step that failed', () => {
    const { tracker, events, notes } = collect();
    tracker.committed('/out/video.mp4', 1);
    tracker.done('verify');
    const banked = notes.length;

    tracker.start('watermark');
    tracker.failed('watermark');

    // It did not happen, so the next attempt must do it rather than skip it.
    expect(tracker.isDone('watermark')).toBe(false);
    expect(notes).toHaveLength(banked);
    expect(events).toContain('watermark:failed');
  });

  it('carries what a skipped step concluded, so the badge stays right', () => {
    const first = collect();
    first.tracker.committed('/out/video.mp4', 1);
    first.tracker.done('verify');
    first.tracker.done('watermark', { sourceStrategy: 'removelogo', watermarkRemoved: true, outroTrimmedMs: 900 });

    const note = first.notes[first.notes.length - 1] as ResumeState;
    const second = collect(note);

    /**
     * Without this the resumed attempt would report the watermark as still
     * present — the selector's opinion of the *source* — on a video whose
     * watermark had been filtered out on the previous run. A badge that lies
     * about the file on disk is worse than no badge.
     */
    expect(second.tracker.isDone('watermark')).toBe(true);
    expect(second.tracker.carried.sourceStrategy).toBe('removelogo');
    expect(second.tracker.carried.watermarkRemoved).toBe(true);
    expect(second.tracker.carried.outroTrimmedMs).toBe(900);
  });

  it('keeps banking on a resumed attempt, so a third one skips more', () => {
    const first = collect();
    first.tracker.done('download');
    first.tracker.committed('/out/video.mp4', 1);
    first.tracker.done('verify');

    const second = collect(first.notes[first.notes.length - 1] as ResumeState);
    second.tracker.done('captions', { captionNote: 'no track published' });

    const note = second.notes[second.notes.length - 1];
    expect(note?.done).toEqual(['download', 'verify', 'captions']);
    expect(note?.captionNote).toBe('no track published');
    // Still the file the first attempt committed; a resumption never renames.
    expect(note?.filePath).toBe('/out/video.mp4');
  });

  it('announces every step it is asked to, including the ones it skips', () => {
    const { tracker, events } = collect({ filePath: '/out/video.mp4', done: ['download', 'verify'] });
    tracker.skip('download');
    tracker.skip('verify');
    tracker.start('finish');
    tracker.done('finish');

    // "Already done" is information. A step that silently vanished from the
    // ladder would read as a step that never ran.
    expect(events).toEqual(['download:skipped', 'verify:skipped', 'finish:started', 'finish:done']);
  });

  it('agrees with the list of steps that must not run twice', () => {
    const { tracker, notes } = collect();
    tracker.committed('/out/video.mp4', 1);
    for (const stage of PIPELINE_STAGES) tracker.done(stage);

    expect(notes[notes.length - 1]?.done).toEqual(ONCE_ONLY_STAGES);
  });
});

describe('stage wording', () => {
  it('reads as a sentence for every step', () => {
    // Shown verbatim on a failed row, so a step whose label does not fit the
    // frame produces visible nonsense rather than a test failure.
    for (const stage of PIPELINE_STAGES) {
      expect(describeStageFailure(stage)).toMatch(/^Failed while [a-z]/);
    }
    expect(describeStageFailure('colour')).toBe('Failed while measuring colour');
  });
});
