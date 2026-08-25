import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { describeError } from '@shared/errors';
import type { QueueItemDto } from '@shared/ipc/contract';
import { orderedItems, useAppStore, type LiveProgress } from '../store/app-store';
import { invoke } from '../lib/ipc';
import {
  Button,
  EmptyState,
  ErrorNote,
  Panel,
  ProgressRing,
  Stat,
  StatusChip,
  WatermarkBadge,
  formatBytes,
  formatEta,
  formatSpeed,
} from '../components/primitives';
import { LiveLog } from '../components/LiveLog';

/**
 * Queue — the core screen (section 10).
 *
 * Virtualised, because the acceptance criterion is 300 rows staying at 60fps
 * while progress streams in. Rows are keyed by id and sorted by position, so an
 * update replaces one row rather than reshuffling the list.
 */

const ROW_HEIGHT = 64;

/** Plain-language version of `source_strategy` for the expanded row. */
const STRATEGY_DETAIL: Record<string, string> = {
  clean_source: 'Removed — TikTok served a watermark-free stream, so the file is untouched',
  removelogo: 'Removed — the watermark was filtered out and the video re-encoded',
  blur: 'Obscured — the watermark area was blurred and the video re-encoded',
  raw: 'Still present — no clean stream was offered and removal was not attempted',
};

/**
 * The line under an item's title while it is working.
 *
 * Bytes come from the persisted row so they survive a refresh; rate and ETA
 * come from the volatile progress event, so they are simply absent rather than
 * stale when nothing is moving.
 */
function activityLabel(item: QueueItemDto, live: LiveProgress | undefined): string {
  if (item.status === 'processing') return 'Removing watermark…';
  if (item.status === 'resolving') return 'Looking up the video…';
  if (item.status !== 'downloading') return '';

  const parts: string[] = [];
  if (item.bytesTotal) parts.push(`${formatBytes(item.bytesDone)} / ${formatBytes(item.bytesTotal)}`);
  else if (item.bytesDone) parts.push(formatBytes(item.bytesDone));
  if (live?.speed) parts.push(formatSpeed(live.speed));
  if (live?.etaMs) parts.push(formatEta(live.etaMs));
  return parts.join(' · ');
}

/**
 * Seconds left until a moment, ticking down; null when there is no moment.
 *
 * One interval per waiting row, and only while one is waiting — a backoff is
 * at most thirty seconds and there are rarely several at once, so this costs
 * nothing next to a screen that already streams download progress. It stops on
 * its own the instant the retry is due, so nothing keeps ticking behind a row
 * that has moved on.
 */
function useCountdown(at: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (at === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [at]);

  if (at === null) return null;
  const seconds = Math.ceil((at - now) / 1_000);
  return seconds > 0 ? seconds : null;
}

function Row({
  item,
  live,
  expanded,
  onToggle,
}: {
  item: QueueItemDto;
  live: LiveProgress | undefined;
  expanded: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const isActive = item.status === 'downloading' || item.status === 'processing' || item.status === 'resolving';
  const descriptor = item.errorCode ? describeError(item.errorCode) : null;
  const retryIn = useCountdown(item.nextAttemptAt);

  return (
    <div className="border-b border-white/4 px-4">
      <div className="flex h-16 items-center gap-3">
        <span className="w-10 shrink-0 text-right font-mono text-xs text-ink-500">{item.position}</span>

        {isActive ? <ProgressRing value={item.progress} /> : <span className="size-7 shrink-0" />}

        <button
          onClick={onToggle}
          className="min-w-0 flex-1 text-left"
          aria-expanded={expanded}
          aria-label={`Details for item ${item.position}`}
        >
          <p className="truncate text-sm text-ink-100">
            {item.awemeId ? `@${item.canonicalUrl?.match(/@([\w.-]*)\//)?.[1] || '…'}` : 'Resolving…'}
            <span className="ml-2 font-mono text-xs text-ink-500">{item.awemeId ?? item.rawUrl}</span>
          </p>
          {/* When something failed, the specific reason beats the taxonomy
              heading: "Unable to extract webpage video data" tells the user
              what to do, "Extractor out of date" only asserts a guess. */}
          <p
            className={`truncate text-xs ${descriptor ? 'text-danger-400/80' : 'text-ink-500'}`}
            title={item.errorDetail ?? undefined}
          >
            {descriptor ? (item.errorDetail ?? descriptor.title) : activityLabel(item, live)}
            {/**
             * The wait, said out loud.
             *
             * A failed row and a failed row about to try again looked
             * identical, so a link that dropped its connection sat there
             * reading "The connection dropped or timed out" with nothing
             * moving for up to thirty seconds. The reasonable conclusion is
             * that the app is stuck on it, and the reasonable response is to
             * cancel it — which is the one thing that guarantees it will not
             * download.
             */}
            {retryIn !== null && (
              <span className="ml-2 text-ink-400" aria-live="polite">
                · trying again in {retryIn}s
              </span>
            )}
          </p>
        </button>

        <WatermarkBadge sourceStrategy={item.sourceStrategy} watermarkRemoved={item.watermarkRemoved} />

        <StatusChip status={item.status} />

        {/* Drawn icons rather than ✕ ↻ 🗑. Those are text: they render in
            whichever font the system substitutes, at whatever weight it
            chooses, and the emoji bin arrives in full colour next to a
            monochrome interface. */}
        <div className="flex shrink-0 items-center gap-0.5">
          {isActive && (
            <Button
              variant="ghost"
              size="sm"
              icon="pause"
              title="Cancel"
              onClick={() => void invoke('queue:cancelItem', { itemId: item.id })}
            />
          )}
          {descriptor?.userRetryable && (
            <Button
              variant="ghost"
              size="sm"
              icon="retry"
              title="Retry"
              onClick={() => void invoke('queue:retryItem', { itemId: item.id })}
            />
          )}
          <Button
            variant="ghost"
            size="sm"
            icon="trash"
            title="Remove"
            onClick={() => void invoke('queue:removeItem', { itemId: item.id })}
          />
        </div>
      </div>

      {expanded && (
        <div className="space-y-3 pb-4 pl-14 pr-2 text-xs">
          <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-1">
            <dt className="text-ink-500">Source</dt>
            <dd className="break-all font-mono text-ink-300">{item.rawUrl}</dd>
            {item.canonicalUrl && (
              <>
                <dt className="text-ink-500">Canonical</dt>
                <dd className="break-all font-mono text-ink-300">{item.canonicalUrl}</dd>
              </>
            )}
            <dt className="text-ink-500">Attempts</dt>
            <dd className="text-ink-300">{item.attemptCount}</dd>
            {item.sourceStrategy && (
              <>
                <dt className="text-ink-500">Watermark</dt>
                <dd className="text-ink-300">{STRATEGY_DETAIL[item.sourceStrategy] ?? item.sourceStrategy}</dd>
              </>
            )}
          </dl>

          {item.errorCode && (
            <ErrorNote
              code={item.errorCode}
              detail={item.errorDetail}
              onRetry={() => void invoke('queue:retryItem', { itemId: item.id })}
            />
          )}

          <Button
            variant="ghost"
            onClick={() => {
              // "Copy diagnostic" (section 10) — everything support would ask for.
              void navigator.clipboard.writeText(
                JSON.stringify({ ...item, appVersion: useAppStore.getState().versions?.app }, null, 2),
              );
              useAppStore.getState().pushToast({ kind: 'info', message: 'Diagnostic copied to clipboard' });
            }}
          >
            Copy diagnostic
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * @param embedded Rendered inside the Add links page rather than as its own
 *   screen. The queue is where the work actually shows up, and making people
 *   navigate away from the box they just pasted into to find out whether
 *   anything happened is a step with no decision in it. Embedded, it drops the
 *   log panel (the page has its own) and takes a bounded height instead of
 *   filling the viewport, so the rest of the page still scrolls normally.
 */
export function Queue({
  onAddLinks,
  embedded = false,
}: {
  onAddLinks?: () => void;
  embedded?: boolean;
}): React.JSX.Element {
  // Subscribe to the Map, sort in a memo. Sorting inside the selector would
  // hand zustand a new array every render — see orderedItems' note.
  const queueItems = useAppStore((s) => s.queueItems);
  const items = useMemo(() => orderedItems(queueItems), [queueItems]);
  const queueState = useAppStore((s) => s.queueState);
  const liveProgress = useAppStore((s) => s.liveProgress);
  const pending = useAppStore((s) => s.pendingDuplicates);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    // Expanded rows are taller; the estimator keeps scrolling smooth either way.
    estimateSize: (index) => (items[index]?.id === expandedId ? ROW_HEIGHT + 160 : ROW_HEIGHT),
    overscan: 8,
  });

  const totals = useMemo(() => {
    let done = 0;
    let failed = 0;
    let remaining = 0;
    let watermarkRemoved = 0;
    let stillWatermarked = 0;
    // What the Clear button will actually remove, so it can say so.
    let finished = 0;
    for (const item of items) {
      if (item.status === 'completed') {
        done++;
        finished++;
        if (item.watermarkRemoved) watermarkRemoved++;
        else if (item.sourceStrategy === 'raw') stillWatermarked++;
      } else if (item.status === 'failed') failed++;
      else if (item.status === 'skipped' || item.status === 'cancelled') finished++;
      else remaining++;
    }
    return { done, failed, remaining, finished, watermarkRemoved, stillWatermarked };
  }, [items]);

  /**
   * Combined throughput across everything in flight.
   *
   * Summed rather than averaged: with concurrency above 1 the number the user
   * cares about is what the connection is doing overall, not per item.
   */
  const combined = useMemo(() => {
    let speed = 0;
    let etaMs = 0;
    for (const progress of liveProgress.values()) {
      if (progress.speed) speed += progress.speed;
      // The batch is not done until its slowest member is.
      if (progress.etaMs) etaMs = Math.max(etaMs, progress.etaMs);
    }
    return { speed: speed || null, etaMs: etaMs || null };
  }, [liveProgress]);

  // Embedded, an empty queue is simply absent: the page above it is already
  // the "add some links" call to action, and repeating it would be noise.
  if (items.length === 0 && embedded) return <></>;

  if (items.length === 0) {
    return (
      <EmptyState
        icon="queue"
        title="The queue is empty"
        hint="Add some TikTok links and they will download here, in the exact order you pasted them."
        // An empty screen with nothing to press is a dead end.
        action={
          onAddLinks && (
            <Button variant="primary" icon="add" onClick={onAddLinks}>
              Add links
            </Button>
          )
        }
      />
    );
  }

  return (
    <div className={embedded ? 'flex flex-col gap-4' : 'flex h-full flex-col gap-4'}>
      <Panel className="shrink-0" bodyClassName="px-5 py-4">
        <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
          {/* Fixed shape per figure, so the eye finds "failed" in the same
              place every time instead of re-reading a row of sentences. */}
          <Stat label="Done" value={`${totals.done}/${items.length}`} />
          {totals.watermarkRemoved > 0 && (
            <Stat
              label="Watermark-free"
              value={totals.watermarkRemoved}
              tone="good"
              title="Watermark removed, or never present in the source"
            />
          )}
          {totals.stillWatermarked > 0 && (
            <Stat
              label="Watermarked"
              value={totals.stillWatermarked}
              tone="warn"
              title="No clean stream was offered and removal was not attempted"
            />
          )}
          {totals.failed > 0 && <Stat label="Failed" value={totals.failed} tone="bad" />}
          {combined.speed !== null && (
            <Stat
              label={combined.etaMs === null ? 'Speed' : formatEta(combined.etaMs)}
              value={formatSpeed(combined.speed)}
            />
          )}
          {pending.length > 0 && (
            <Stat label="Questions" value={pending.length} tone="warn" title="Downloads on hold until answered" />
          )}

          <div className="ml-auto flex gap-2">
            {queueState.paused || !queueState.running ? (
              <Button
                variant="primary"
                icon="play"
                onClick={() => void invoke(queueState.running ? 'queue:resume' : 'queue:start')}
              >
                {queueState.running ? 'Resume' : 'Start'}
              </Button>
            ) : (
              <Button icon="pause" onClick={() => void invoke('queue:pause')}>
                Pause
              </Button>
            )}
            {totals.failed > 0 && (
              <Button icon="retry" onClick={() => void invoke('queue:retryAllFailed')}>
                Retry failed
              </Button>
            )}
            {/**
             * Labelled, counted, and disabled when there is nothing to do.
             *
             * This was an icon with no label that cleared only completed
             * items, so on a queue of failures it did nothing and said
             * nothing — indistinguishable from a broken button. Now it names
             * the number it will remove, and when that number is zero it says
             * why it is greyed out instead of just sitting there.
             */}
            <Button
              icon="trash"
              disabled={totals.finished === 0}
              title={
                totals.finished === 0
                  ? 'Nothing to clear yet — finished downloads are removed by this button, failures are kept'
                  : 'Removes finished, skipped and cancelled rows. Failures are kept so you can retry them.'
              }
              onClick={() => void invoke('queue:removeCompleted')}
            >
              Clear {totals.finished} done
            </Button>
            <Button
              variant="ghost"
              icon="trash"
              title="Empties the queue completely, failures included. Files already downloaded are not touched."
              onClick={() => {
                if (window.confirm(`Remove all ${items.length} rows from the queue? Downloaded files are not deleted.`)) {
                  void invoke('queue:clear');
                }
              }}
            >
              Clear all
            </Button>
          </div>
        </div>
      </Panel>

      <div
        ref={parentRef}
        className={`elevation-card min-h-0 overflow-y-auto ${embedded ? 'max-h-[28rem]' : 'flex-[3]'}`}
      >
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const item = items[virtualRow.index];
            if (!item) return null;
            return (
              <div
                key={item.id}
                ref={virtualizer.measureElement}
                data-index={virtualRow.index}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  // Only transform is animated, per the section 10 perf rule.
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                <Row
                  item={item}
                  live={liveProgress.get(item.id)}
                  expanded={expandedId === item.id}
                  onToggle={() => setExpandedId(expandedId === item.id ? null : item.id)}
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* Kept to a third of the height: the queue is the subject, this is
          context. It only fills up when something actually goes wrong. */}
      {!embedded && (
        <div className="min-h-32 flex-1">
          <LiveLog />
        </div>
      )}
    </div>
  );
}
