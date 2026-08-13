import { useMemo, useRef, useState } from 'react';
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
          </p>
        </button>

        <WatermarkBadge sourceStrategy={item.sourceStrategy} watermarkRemoved={item.watermarkRemoved} />

        <StatusChip status={item.status} />

        <div className="flex shrink-0 gap-1">
          {isActive && (
            <Button variant="ghost" onClick={() => void invoke('queue:cancelItem', { itemId: item.id })} title="Cancel">
              ✕
            </Button>
          )}
          {descriptor?.userRetryable && (
            <Button variant="ghost" onClick={() => void invoke('queue:retryItem', { itemId: item.id })} title="Retry">
              ↻
            </Button>
          )}
          <Button variant="ghost" onClick={() => void invoke('queue:removeItem', { itemId: item.id })} title="Remove">
            🗑
          </Button>
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

export function Queue(): React.JSX.Element {
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
    for (const item of items) {
      if (item.status === 'completed') {
        done++;
        if (item.watermarkRemoved) watermarkRemoved++;
        else if (item.sourceStrategy === 'raw') stillWatermarked++;
      } else if (item.status === 'failed') failed++;
      else if (item.status !== 'skipped' && item.status !== 'cancelled') remaining++;
    }
    return { done, failed, remaining, watermarkRemoved, stillWatermarked };
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

  if (items.length === 0) {
    return (
      <EmptyState
        title="The queue is empty"
        hint="Add some TikTok links and they will download here, in the exact order you pasted them."
      />
    );
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <Panel className="shrink-0">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-semibold text-ink-100">{totals.done}</span>
            <span className="text-sm text-ink-500">of {items.length} done</span>
          </div>
          {/* The headline number for this app: how many actually came out clean. */}
          {totals.watermarkRemoved > 0 && (
            <span className="text-sm text-mint-300" title="Watermark removed, or never present in the source">
              {totals.watermarkRemoved} watermark-free
            </span>
          )}
          {totals.stillWatermarked > 0 && (
            <span className="text-sm text-warn-400" title="No clean stream was offered and removal was not attempted">
              {totals.stillWatermarked} still watermarked
            </span>
          )}
          {combined.speed !== null && (
            <span className="text-sm text-ink-300">
              {formatSpeed(combined.speed)}
              {combined.etaMs !== null && <span className="text-ink-500"> · {formatEta(combined.etaMs)}</span>}
            </span>
          )}
          {totals.failed > 0 && <span className="text-sm text-danger-400">{totals.failed} failed</span>}
          {pending.length > 0 && (
            <span className="rounded-md bg-warn-400/20 px-2 py-0.5 text-xs font-medium text-warn-400">
              {pending.length} question{pending.length === 1 ? '' : 's'} waiting
            </span>
          )}

          <div className="ml-auto flex gap-2">
            {queueState.paused || !queueState.running ? (
              <Button
                variant="primary"
                onClick={() => void invoke(queueState.running ? 'queue:resume' : 'queue:start')}
              >
                {queueState.running ? 'Resume' : 'Start'}
              </Button>
            ) : (
              <Button onClick={() => void invoke('queue:pause')}>Pause</Button>
            )}
            {totals.failed > 0 && (
              <Button onClick={() => void invoke('queue:retryAllFailed')}>Retry failed</Button>
            )}
            <Button variant="ghost" onClick={() => void invoke('queue:removeCompleted')}>
              Clear completed
            </Button>
          </div>
        </div>
      </Panel>

      <div ref={parentRef} className="elevation-card min-h-0 flex-[3] overflow-y-auto">
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
      <div className="min-h-32 flex-1">
        <LiveLog />
      </div>
    </div>
  );
}
