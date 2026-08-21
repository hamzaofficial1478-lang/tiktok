import { useCallback, useEffect, useState, type ChangeEvent } from 'react';
import { parseProfile } from '@shared/url-parse';
import type { CreatorDto, InvokeResponse } from '@shared/ipc/contract';
import { CAPTION_MODES, type CaptionMode } from '@shared/caption-schema';
import { invoke, subscribe } from '../lib/ipc';
import { useAppStore } from '../store/app-store';
import { Button, Panel, Stat } from './primitives';
import { Icon } from './icons';
import { NumberInput, Select, Switch } from './form';

/**
 * The saved creator list.
 *
 * The list is the point, not the paste box. Accounts survive restarts, each
 * carries its own count and its own caption choice, and a run works through
 * them one at a time — so this panel has to answer, at a glance: how many
 * accounts are saved, how many videos each is set to take, and which one is
 * being worked on right now.
 *
 * Sequential is stated rather than implied. "Downloading 3 of 5 from
 * @creator, account 2 of 10" is a sentence with one meaning at any moment;
 * ten accounts progressing at once is a screen nobody can read and ten times
 * the concurrent load on TikTok from one machine.
 */

interface RunProgress {
  readonly creatorId: number;
  readonly handle: string;
  readonly phase: 'listing' | 'queued' | 'downloading' | 'done' | 'failed' | 'nothing-new' | 'caught-up';
  readonly queued: number;
  readonly index: number;
  readonly total: number;
  readonly message?: string;
}

const PHASE_LABEL: Record<RunProgress['phase'], string> = {
  listing: 'listing videos…',
  queued: 'queued',
  downloading: 'downloading…',
  done: 'done',
  failed: 'could not be listed',
  'nothing-new': 'nothing new',
  'caught-up': 'already has everything you asked for',
};

type Plan = InvokeResponse<'creators:plan'>;

export function Creators(): React.JSX.Element {
  const [creators, setCreators] = useState<CreatorDto[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [input, setInput] = useState('');
  const [defaultLimit, setDefaultLimit] = useState(5);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [progress, setProgress] = useState<RunProgress | null>(null);
  /** True while the "take another round?" question is on screen. */
  const [confirmingTopUp, setConfirmingTopUp] = useState(false);
  const pushToast = useAppStore((s) => s.pushToast);
  /**
   * Completed downloads, watched so the Run button's count comes down.
   *
   * The plan is computed in main from the ledger; the one thing that changes
   * it is a video finishing, and that is a queue event. Reading the count here
   * rather than polling keeps the button honest without a timer.
   */
  const completed = useAppStore((s) => {
    let n = 0;
    for (const item of s.queueItems.values()) if (item.status === 'completed') n++;
    return n;
  });

  const reload = useCallback(async (): Promise<void> => {
    const [list, next] = await Promise.all([invoke('creators:list'), invoke('creators:plan')]);
    setCreators(list.creators);
    setPlan(next);
  }, []);

  useEffect(() => {
    void reload();
    return subscribe('creators:progress', (event) => {
      setProgress(event);
      // The run is over when the last account reports a terminal phase.
      if (event.index === event.total && ['done', 'failed', 'nothing-new', 'caught-up'].includes(event.phase)) {
        setRunning(false);
        /**
         * Say what happened, and what the choice is now.
         *
         * The old behaviour was to finish silently and then, on the next press
         * of Run, take another full count without a word — which is how an
         * account set to 3 ended up with 6 videos. Ending a run by stating the
         * position, and offering the two things the user might want, is the
         * other half of that fix.
         */
        void invoke('creators:plan')
          .then((next) => {
            setPlan(next);
            if (next.remaining > 0 || next.creators.length === 0) return;
            pushToast({
              kind: 'success',
              message: 'Every account now has the videos you asked for. Change a count, or run again to take the next set.',
              action: { label: 'Run again', run: () => setConfirmingTopUp(true) },
            });
          })
          .catch(() => undefined);
      }
      void reload();
    });
  }, [reload, pushToast]);

  // Re-read after each finished download, so "12 left" becomes "11 left"
  // without waiting for the run to end.
  useEffect(() => {
    void invoke('creators:plan').then(setPlan).catch(() => undefined);
  }, [completed]);

  const candidates = input
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const valid = candidates.filter((line) => parseProfile(line) !== null).length;

  async function add(): Promise<void> {
    setBusy(true);
    try {
      const result = await invoke('creators:add', { input, videoLimit: defaultLimit });
      setCreators(result.creators);
      void invoke('creators:plan').then(setPlan).catch(() => undefined);
      setInput('');

      const parts = [`${result.added} added`];
      if (result.alreadySaved.length > 0) parts.push(`${result.alreadySaved.length} already saved`);
      if (result.invalid.length > 0) parts.push(`${result.invalid.length} not a profile link`);
      pushToast({ kind: result.added > 0 ? 'success' : 'warning', message: parts.join(' · ') });
    } catch (err) {
      pushToast({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  async function patch(
    id: number,
    changes: { videoLimit?: number; captionMode?: CaptionMode | null; enabled?: boolean },
  ): Promise<void> {
    const result = await invoke('creators:update', { id, ...changes });
    if (result.creator) setCreators((list) => list.map((c) => (c.id === id ? result.creator! : c)));
    // Raising or lowering a count changes what the run owes, and so does
    // switching an account off — the plan only counts the ones that are on.
    void invoke('creators:plan').then(setPlan).catch(() => undefined);
  }

  /**
   * Switch an account on or off for the next run.
   *
   * The row is updated before the round trip, because a switch that waits for
   * a database write before it moves reads as a switch that did not work. The
   * server's answer replaces it either way, so a rejected change corrects
   * itself rather than sticking.
   */
  function setEnabled(id: number, enabled: boolean): void {
    setCreators((list) => list.map((c) => (c.id === id ? { ...c, enabled } : c)));
    void patch(id, { enabled }).catch((err: unknown) => {
      void reload();
      pushToast({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    });
  }

  /** All on, or all off — the fast way back from "I only wanted one of these". */
  function setAllEnabled(enabled: boolean): void {
    const changing = creators.filter((c) => c.enabled !== enabled);
    if (changing.length === 0) return;
    setCreators((list) => list.map((c) => ({ ...c, enabled })));
    void Promise.all(changing.map((c) => invoke('creators:update', { id: c.id, enabled })))
      .then(() => reload())
      .catch(() => reload());
  }

  async function remove(id: number): Promise<void> {
    await invoke('creators:remove', { id });
    setCreators((list) => list.filter((c) => c.id !== id));
    void invoke('creators:plan').then(setPlan).catch(() => undefined);
  }

  /**
   * What the run still owes, per account and in total.
   *
   * Not the sum of everyone's limit: that number never moved, so the button
   * went on offering to download videos that were already on disk. This is the
   * limit minus what has actually been taken, and it reaches zero when the
   * list is finished.
   */
  const remainingFor = (creatorId: number): number =>
    plan?.creators.find((entry) => entry.creatorId === creatorId)?.remaining ?? 0;
  const takenFor = (creatorId: number): number =>
    plan?.creators.find((entry) => entry.creatorId === creatorId)?.taken ?? 0;
  const totalRemaining = plan?.remaining ?? 0;
  const enabled = creators.filter((c) => c.enabled).length;

  /**
   * A run is under way — asked of the engine, not remembered by this screen.
   *
   * The local flag alone was wrong in exactly the case that matters: it is
   * lost when the window reloads and when the app restarts, so a run cut short
   * by a power failure came back with the button enabled, inviting a second
   * run on top of the first one still resuming in the background. `plan.running`
   * is true while the runner is working *or* the queue still has items, which
   * is the whole span the button must stay shut for.
   *
   * The local flag is kept as well, purely so the button reacts on the click
   * rather than after the next round trip.
   */
  const busyRunning = running || plan?.running === true;

  /**
   * Everything the list asks for is already downloaded.
   *
   * This is the state that used to be invisible, and that invisibility was the
   * bug: pressing Run again quietly took another three from an account set to
   * three, so a setting that said 3 produced 6 files. Running again is still
   * available — it is a reasonable thing to want — but it is now a thing the
   * user is told about and agrees to.
   */
  const caughtUp = enabled > 0 && totalRemaining === 0 && !busyRunning;
  /** What another round would take, if the user asks for one. */
  const nextRoundSize = creators.filter((c) => c.enabled).reduce((sum, c) => sum + c.videoLimit, 0);

  function startRun(topUp: boolean): void {
    setRunning(true);
    setPlan((current) => (current ? { ...current, running: true } : current));
    setProgress(null);
    setConfirmingTopUp(false);
    void invoke('creators:run', { topUp })
      .then((result) => {
        if (result.visited === 0) {
          setRunning(false);
          pushToast({ kind: 'info', message: 'Every account already has the videos you asked for.' });
        }
      })
      .catch((err: unknown) => {
        setRunning(false);
        pushToast({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      });
  }

  return (
    <Panel
      title="Creators"
      description="Saved accounts, each with its own count. A run works through them one at a time, newest videos first, into a folder per account."
      actions={
        creators.length > 0 && (
          <>
            {busyRunning ? (
              /**
               * While a run is on, Run is not merely hidden — there is nothing
               * to press that would start a second one. The count keeps
               * falling as videos land, so this reads as progress rather than
               * as a frozen button.
               */
              <>
                <span className="text-sm tabular-nums text-ink-300" aria-live="polite">
                  <strong className="font-medium text-ink-100">{totalRemaining}</strong> left to download
                </span>
                <Button
                  variant="secondary"
                  icon="pause"
                  title="Finishes the account it is on, then stops. Nothing already downloaded is lost."
                  onClick={() => {
                    void invoke('creators:cancelRun');
                    setRunning(false);
                  }}
                >
                  Stop after this one
                </Button>
              </>
            ) : (
              <Button
                variant="primary"
                icon="play"
                disabled={enabled === 0}
                title={
                  enabled === 0
                    ? 'Every saved account is switched off, so a run would have nothing to visit. Switch at least one on.'
                    : caughtUp
                      ? 'Every account that is switched on has given you the number of videos you asked for. Running again asks first.'
                      : 'Lists each account that is switched on, in turn, and downloads what it has not taken yet'
                }
                // Caught up, Run asks rather than starting: taking another
                // round is a reasonable thing to want and a terrible thing to
                // do without saying so.
                onClick={() => (caughtUp ? setConfirmingTopUp(true) : startRun(false))}
              >
                {enabled === 0
                  ? 'Run — every account is switched off'
                  : caughtUp
                    ? `Run again — take ${nextRoundSize} more`
                    : `Run — download ${totalRemaining} video${totalRemaining === 1 ? '' : 's'}`}
              </Button>
            )}
          </>
        )
      }
    >
      <div className="grid gap-5">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-64 flex-1">
            <label htmlFor="creator-input" className="mb-1.5 block text-sm font-medium text-ink-100">
              Add accounts
            </label>
            <textarea
              id="creator-input"
              value={input}
              onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setInput(event.target.value)}
              spellCheck={false}
              rows={3}
              placeholder={'https://www.tiktok.com/@creator\n@another\n…one per line, paste as many as you like'}
              className="w-full resize-none rounded-lg border border-white/8 bg-base-900/60 px-3 py-2 font-mono
                text-xs text-ink-100 placeholder:text-ink-500/60 focus:border-accent-500/50 focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="creator-limit" className="mb-1.5 block text-sm font-medium text-ink-100">
              Videos each
            </label>
            <NumberInput id="creator-limit" value={defaultLimit} min={1} max={1000} onChange={setDefaultLimit} />
          </div>

          <Button variant="secondary" icon="add" disabled={valid === 0 || busy} onClick={() => void add()}>
            {busy ? 'Adding…' : `Add ${valid || ''}`.trim()}
          </Button>
        </div>

        {/**
         * "Everything you asked for is downloaded — what now?"
         *
         * Inline rather than a modal, because it is not urgent and it must not
         * cover the list it is talking about: the two answers are "take another
         * round" and "change the counts", and the counts are the rows below.
         */}
        {confirmingTopUp && (
          <div className="rounded-lg border border-accent-500/30 bg-accent-500/8 p-4">
            <p className="text-sm font-medium text-ink-100">
              Every account has already given you the videos you asked for.
            </p>
            <p className="mt-2 text-sm text-ink-300">
              Running again takes the <strong className="text-ink-100">next {nextRoundSize}</strong> — the same count
              you set for each account, applied to the videos below the ones you already have. Your settings for each
              account do not change, and nothing already downloaded is taken a second time.
            </p>
            <ul className="mt-3 grid gap-0.5 text-xs text-ink-500">
              {creators
                .filter((creator) => creator.enabled)
                .map((creator) => (
                  <li key={creator.id}>
                    @{creator.handle} — the next {creator.videoLimit}
                    {creator.captionMode ? ` · captions ${creator.captionMode}` : ''}
                  </li>
                ))}
            </ul>

            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="primary" icon="play" onClick={() => startRun(true)}>
                Yes, take the next {nextRoundSize}
              </Button>
              <Button variant="secondary" icon="settings" onClick={() => setConfirmingTopUp(false)}>
                No — let me change the counts first
              </Button>
            </div>
          </div>
        )}

        {creators.length > 0 && (
          <>
            <div className="flex flex-wrap items-center gap-x-8 gap-y-3 border-t border-white/5 pt-4">
              <Stat
                label="Accounts"
                value={enabled === creators.length ? creators.length : `${enabled} of ${creators.length}`}
                title="Switched on, out of saved. Only the ones switched on are visited by a run."
              />
              <Stat
                label="Left to download"
                value={totalRemaining}
                tone={totalRemaining === 0 ? 'good' : 'neutral'}
                title="What every account that is switched on still owes: its count minus the videos already taken from it."
              />
              <Stat label="Taken so far" value={plan?.taken ?? 0} />
              {progress && (
                <div className="text-sm">
                  <div className="font-medium text-ink-100">
                    @{progress.handle} — {PHASE_LABEL[progress.phase]}
                  </div>
                  <div className="text-xs text-ink-500">
                    Account {progress.index} of {progress.total}
                    {progress.message ? ` · ${progress.message}` : ''}
                  </div>
                </div>
              )}
            </div>

            {/**
             * Which accounts a run will visit, and the fast way to change it.
             *
             * The list used to be all-or-nothing: every saved account was
             * fetched every time, so wanting one account's videos meant
             * deleting the other four and adding them back afterwards — which
             * also threw away their counts and their caption settings. The
             * switches are per account and are remembered, so a list can be
             * left standing and only part of it run.
             */}
            {creators.length > 1 && (
              <div className="flex flex-wrap items-center gap-2 text-xs text-ink-500">
                <span>
                  A run visits the {enabled} account{enabled === 1 ? '' : 's'} switched on
                  {enabled < creators.length && `, and skips the other ${creators.length - enabled}`}.
                </span>
                <Button variant="ghost" size="sm" disabled={enabled === creators.length} onClick={() => setAllEnabled(true)}>
                  Turn all on
                </Button>
                <Button variant="ghost" size="sm" disabled={enabled === 0} onClick={() => setAllEnabled(false)}>
                  Turn all off
                </Button>
              </div>
            )}

            <ul className="grid gap-1.5">
              {creators.map((creator, index) => {
                const active = progress?.creatorId === creator.id && running;
                const off = !creator.enabled;
                return (
                  <li
                    key={creator.id}
                    className={`rounded-lg border px-3 py-2.5 transition-colors ${
                      active
                        ? 'border-accent-500/40 bg-accent-500/8'
                        : off
                          ? 'border-white/6 border-dashed bg-base-900/15'
                          : 'border-white/6 bg-base-900/30'
                    }`}
                  >
                    <div className="flex flex-wrap items-center gap-3">
                      <Switch
                        checked={creator.enabled}
                        onChange={(next) => setEnabled(creator.id, next)}
                        label={`Include @${creator.handle} in a run`}
                        title={
                          creator.enabled
                            ? `On — a run downloads from @${creator.handle}. Switch off to skip it without removing it.`
                            : `Off — a run skips @${creator.handle}. Its count and settings are kept.`
                        }
                      />
                      <span className="w-6 shrink-0 text-xs tabular-nums text-ink-500">{index + 1}</span>
                      <span
                        className={`min-w-0 flex-1 truncate text-sm font-medium ${off ? 'text-ink-500' : 'text-ink-100'}`}
                      >
                        @{creator.handle}
                      </span>

                      {/* Per account, the same sentence the button makes:
                          how many are still owed, out of how many were asked
                          for. "5 videos" alone said nothing about whether any
                          of them were still to come. */}
                      <span className="shrink-0 text-xs text-ink-500">
                        {off ? (
                          // Said outright rather than shown only by a dimmed
                          // row: "why did this account download nothing" has to
                          // be answerable from the row itself.
                          <span>skipped — switched off</span>
                        ) : remainingFor(creator.id) === 0 ? (
                          // The real number downloaded, not the count that was
                          // asked for. They can differ on accounts that were
                          // run more than once before runs were capped.
                          <span className="text-mint-300">{takenFor(creator.id)} downloaded</span>
                        ) : (
                          `${remainingFor(creator.id)} of ${creator.videoLimit} left`
                        )}
                        {creator.captionMode && ` · captions ${creator.captionMode}`}
                      </span>

                      <div className="flex shrink-0 gap-0.5">
                        <Button
                          variant="ghost"
                          size="sm"
                          icon="settings"
                          title={editing === creator.id ? 'Close' : 'Edit this account'}
                          onClick={() => setEditing(editing === creator.id ? null : creator.id)}
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          icon="trash"
                          title="Remove"
                          onClick={() => void remove(creator.id)}
                        />
                      </div>
                    </div>

                    {editing === creator.id && (
                      <div className="mt-3 grid gap-3 border-t border-white/5 pt-3 sm:grid-cols-2">
                        <div>
                          <span className="mb-1.5 block text-xs font-medium text-ink-300">
                            Videos to take each run
                          </span>
                          <NumberInput
                            value={creator.videoLimit}
                            min={1}
                            max={1000}
                            suffix="newest, skipping any already downloaded"
                            onChange={(videoLimit) => void patch(creator.id, { videoLimit })}
                          />
                        </div>
                        <div>
                          <span className="mb-1.5 block text-xs font-medium text-ink-300">Captions</span>
                          <Select
                            value={creator.captionMode ?? 'inherit'}
                            onChange={(mode) =>
                              void patch(creator.id, {
                                captionMode: mode === 'inherit' ? null : (mode as CaptionMode),
                              })
                            }
                            options={[
                              { value: 'inherit', label: 'Use the app setting' },
                              ...CAPTION_MODES.map((mode) => ({
                                value: mode,
                                label: { off: 'Off', soft: 'Subtitle track', burn: 'Burned in' }[mode],
                              })),
                            ]}
                          />
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>

            <p className="flex items-start gap-2 text-xs text-ink-500">
              <Icon name="check" size={13} className="mt-0.5 text-mint-400" />
              Saved on this machine — these accounts and their settings are still here after you close the app. A
              video already downloaded from an account is never taken again, so a second run picks up where the first
              left off. Switching an account off keeps everything about it and simply leaves it out of the next run.
            </p>
          </>
        )}
      </div>
    </Panel>
  );
}
