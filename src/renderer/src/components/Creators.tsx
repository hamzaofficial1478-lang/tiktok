import { useCallback, useEffect, useState, type ChangeEvent } from 'react';
import { parseProfile } from '@shared/url-parse';
import type { CreatorDto, InvokeResponse } from '@shared/ipc/contract';
import { CAPTION_MODES, type CaptionMode } from '@shared/caption-schema';
import { invoke, subscribe } from '../lib/ipc';
import { useAppStore } from '../store/app-store';
import { Button, Panel, Stat } from './primitives';
import { Icon } from './icons';
import { NumberInput, Select } from './form';

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
  readonly phase: 'listing' | 'queued' | 'downloading' | 'done' | 'failed' | 'nothing-new';
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
      if (event.index === event.total && ['done', 'failed', 'nothing-new'].includes(event.phase)) {
        setRunning(false);
      }
      void reload();
    });
  }, [reload]);

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

  async function patch(id: number, changes: { videoLimit?: number; captionMode?: CaptionMode | null }): Promise<void> {
    const result = await invoke('creators:update', { id, ...changes });
    if (result.creator) setCreators((list) => list.map((c) => (c.id === id ? result.creator! : c)));
    // Raising or lowering a count changes what the run owes.
    void invoke('creators:plan').then(setPlan).catch(() => undefined);
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
  const totalRemaining = plan?.remaining ?? 0;
  const enabled = creators.filter((c) => c.enabled).length;

  return (
    <Panel
      title="Creators"
      description="Saved accounts, each with its own count. A run works through them one at a time, newest videos first, into a folder per account."
      actions={
        creators.length > 0 && (
          <>
            {running ? (
              <Button
                variant="secondary"
                icon="pause"
                onClick={() => {
                  void invoke('creators:cancelRun');
                  setRunning(false);
                }}
              >
                Stop after this one
              </Button>
            ) : (
              <Button
                variant="primary"
                icon="play"
                // Nothing owed means nothing to do. A Run button that starts a
                // network round trip per account only to report "nothing new"
                // is a button that lies about having work.
                disabled={enabled === 0 || totalRemaining === 0}
                title={
                  totalRemaining === 0
                    ? 'Every saved account has already given you the number of videos you asked for. Raise a count to take more.'
                    : 'Lists each account in turn and downloads what it has not taken yet'
                }
                onClick={() => {
                  setRunning(true);
                  setProgress(null);
                  void invoke('creators:run').catch((err: unknown) => {
                    setRunning(false);
                    pushToast({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
                  });
                }}
              >
                {totalRemaining === 0
                  ? 'All caught up'
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

        {creators.length > 0 && (
          <>
            <div className="flex flex-wrap items-center gap-x-8 gap-y-3 border-t border-white/5 pt-4">
              <Stat label="Accounts" value={creators.length} />
              <Stat
                label="Left to download"
                value={totalRemaining}
                tone={totalRemaining === 0 ? 'good' : 'neutral'}
                title="What every enabled account still owes: its count minus the videos already taken from it."
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

            <ul className="grid gap-1.5">
              {creators.map((creator, index) => {
                const active = progress?.creatorId === creator.id && running;
                return (
                  <li
                    key={creator.id}
                    className={`rounded-lg border px-3 py-2.5 transition-colors ${
                      active ? 'border-accent-500/40 bg-accent-500/8' : 'border-white/6 bg-base-900/30'
                    }`}
                  >
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="w-6 shrink-0 text-xs tabular-nums text-ink-500">{index + 1}</span>
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink-100">
                        @{creator.handle}
                      </span>

                      {/* Per account, the same sentence the button makes:
                          how many are still owed, out of how many were asked
                          for. "5 videos" alone said nothing about whether any
                          of them were still to come. */}
                      <span className="shrink-0 text-xs text-ink-500">
                        {remainingFor(creator.id) === 0 ? (
                          <span className="text-mint-300">all {creator.videoLimit} taken</span>
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
              left off.
            </p>
          </>
        )}
      </div>
    </Panel>
  );
}
