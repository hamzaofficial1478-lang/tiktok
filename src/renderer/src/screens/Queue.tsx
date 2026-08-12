import { useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { describeError } from '@shared/errors';
import type { QueueItemDto } from '@shared/ipc/contract';
import { selectOrderedItems, useAppStore } from '../store/app-store';
import { invoke } from '../lib/ipc';
import { Button, EmptyState, ErrorNote, Panel, ProgressRing, StatusChip, formatBytes } from '../components/primitives';

/**
 * Queue — the core screen (section 10).
 *
 * Virtualised, because the acceptance criterion is 300 rows staying at 60fps
 * while progress streams in. Rows are keyed by id and sorted by position, so an
 * update replaces one row rather than reshuffling the list.
 */

const ROW_HEIGHT = 64;

function speedLabel(item: QueueItemDto): string {
  if (item.status !== 'downloading' || !item.bytesTotal) return '';
  return `${formatBytes(item.bytesDone)} / ${formatBytes(item.bytesTotal)}`;
}

function Row({
  item,
  expanded,
  onToggle,
}: {
  item: QueueItemDto;
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
          <p className="truncate text-xs text-ink-500">{descriptor ? descriptor.title : speedLabel(item)}</p>
        </button>

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
  const items = useAppStore(selectOrderedItems);
  const queueState = useAppStore((s) => s.queueState);
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
    for (const item of items) {
      if (item.status === 'completed') done++;
      else if (item.status === 'failed') failed++;
      else if (item.status !== 'skipped' && item.status !== 'cancelled') remaining++;
    }
    return { done, failed, remaining };
  }, [items]);

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

      <div ref={parentRef} className="elevation-card min-h-0 flex-1 overflow-y-auto">
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
                  expanded={expandedId === item.id}
                  onToggle={() => setExpandedId(expandedId === item.id ? null : item.id)}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
