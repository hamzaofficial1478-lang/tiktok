import { useCallback, useEffect, useMemo, useState } from 'react';
import { describeError } from '@shared/errors';
import type { InvokeResponse } from '@shared/ipc/contract';
import { orderedItems, useAppStore } from '../store/app-store';
import { invoke, subscribe } from '../lib/ipc';
import { Button, Panel, Stat, formatEta, formatSpeed } from './primitives';
import { Icon } from './icons';

/**
 * How much is left, on the page where the work is started.
 *
 * The headline is a count that goes *down*. That is the whole point of it: the
 * button used to say "Download 16 videos" and went on saying it after all
 * sixteen were on disk, because it was showing the sum of everyone's
 * per-account limit rather than what was still owed. A number that never moves
 * is not a progress indicator, it is a label.
 *
 * "Left to download" comes from the run plan, which is the accounts' limits
 * minus what the ledger says has actually been taken — so it falls by one as
 * each video finishes, reaches zero when the list is done, and does not need a
 * run to be in progress to be true.
 *
 * The other three come from the queue and describe this session: what is
 * moving now, what finished, and what failed. Failures are on this page and
 * not only on the Queue screen because a failure the user never sees is a
 * video they think they have.
 */

type Plan = InvokeResponse<'creators:plan'>;

export function RunStatus({ onOpenQueue }: { onOpenQueue?: () => void }): React.JSX.Element | null {
  const [plan, setPlan] = useState<Plan | null>(null);
  const queueItems = useAppStore((s) => s.queueItems);
  const liveProgress = useAppStore((s) => s.liveProgress);
  const queueState = useAppStore((s) => s.queueState);

  const items = useMemo(() => orderedItems(queueItems), [queueItems]);

  const totals = useMemo(() => {
    let done = 0;
    let failed = 0;
    let waiting = 0;
    for (const item of items) {
      if (item.status === 'completed') done++;
      else if (item.status === 'failed') failed++;
      else if (item.status !== 'skipped' && item.status !== 'cancelled') waiting++;
    }
    return { done, failed, waiting };
  }, [items]);

  const failures = useMemo(() => items.filter((item) => item.status === 'failed'), [items]);

  const refresh = useCallback(() => {
    void invoke('creators:plan')
      .then(setPlan)
      // A plan that cannot be read is not worth a toast on a screen the user
      // is trying to work on; the panel simply shows what the queue knows.
      .catch(() => undefined);
  }, []);

  /**
   * Re-read the plan when a download finishes, and not on every progress tick.
   *
   * `done` only changes when an item reaches `completed`, which is exactly when
   * the ledger gains a row and the count owed drops. Depending on the queue map
   * itself would re-query four times a second per item for an answer that had
   * not changed.
   */
  useEffect(refresh, [refresh, totals.done]);

  useEffect(() => {
    // A run queues links and updates each account's tally, so the plan moves
    // for reasons the queue alone cannot see.
    const stop = subscribe('creators:progress', () => refresh());
    return stop;
  }, [refresh]);

  const combined = useMemo(() => {
    let speed = 0;
    let etaMs = 0;
    for (const progress of liveProgress.values()) {
      if (progress.speed) speed += progress.speed;
      if (progress.etaMs) etaMs = Math.max(etaMs, progress.etaMs);
    }
    return { speed: speed || null, etaMs: etaMs || null };
  }, [liveProgress]);

  const left = plan?.remaining ?? 0;
  // Nothing saved, nothing queued, nothing done: there is no run to report on
  // and an empty strip of zeroes is worse than no strip at all.
  if (left === 0 && items.length === 0) return null;

  return (
    <Panel bodyClassName="px-5 py-4">
      <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
        <Stat
          label="Left to download"
          value={left}
          tone={left === 0 ? 'good' : 'neutral'}
          title="Across every saved account: the videos each is set to take, minus the ones already taken. This falls as videos finish."
        />
        {totals.waiting > 0 && <Stat label="In the queue" value={totals.waiting} />}
        {totals.done > 0 && <Stat label="Downloaded" value={totals.done} tone="good" />}
        {totals.failed > 0 && (
          <Stat label="Failed" value={totals.failed} tone="bad" title="These did not download. Retry is below." />
        )}
        {combined.speed !== null && (
          <Stat
            label={combined.etaMs === null ? 'Speed' : formatEta(combined.etaMs)}
            value={formatSpeed(combined.speed)}
          />
        )}

        <div className="ml-auto flex gap-2">
          {totals.failed > 0 && (
            <Button icon="retry" onClick={() => void invoke('queue:retryAllFailed')}>
              Retry {totals.failed} failed
            </Button>
          )}
          {items.length > 0 && onOpenQueue && (
            <Button variant="ghost" icon="queue" onClick={onOpenQueue}>
              Open queue
            </Button>
          )}
          {queueState.running && !queueState.paused && (
            <Button icon="pause" onClick={() => void invoke('queue:pause')}>
              Pause
            </Button>
          )}
        </div>
      </div>

      {/**
       * The failures themselves, not just a number.
       *
       * A count tells the user something went wrong; the link and the reason
       * tell them which video and whether it is worth retrying. Capped at five
       * so a bad network night does not push the rest of the page off screen —
       * the Queue screen has the full list.
       */}
      {failures.length > 0 && (
        <ul className="mt-4 grid gap-1 border-t border-white/5 pt-3">
          {failures.slice(0, 5).map((item) => (
            <li key={item.id} className="flex items-center gap-3 text-xs">
              <Icon name="alert" size={13} className="shrink-0 text-danger-400" />
              <span className="min-w-0 flex-1 truncate font-mono text-ink-300" title={item.rawUrl}>
                {item.awemeId ?? item.rawUrl}
              </span>
              <span className="shrink-0 truncate text-danger-400/80" title={item.errorDetail ?? undefined}>
                {item.errorDetail ?? (item.errorCode ? describeError(item.errorCode).title : 'failed')}
              </span>
              <Button
                variant="ghost"
                size="sm"
                icon="retry"
                title="Retry this one"
                onClick={() => void invoke('queue:retryItem', { itemId: item.id })}
              />
            </li>
          ))}
          {failures.length > 5 && (
            <li className="text-xs text-ink-500">and {failures.length - 5} more — see the Queue screen</li>
          )}
        </ul>
      )}
    </Panel>
  );
}
