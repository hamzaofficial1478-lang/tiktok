import { useEffect, useMemo, useState } from 'react';
import { describeError } from '@shared/errors';
import type { LibraryEntryDto } from '@shared/ipc/contract';
import { orderedItems, useAppStore } from '../store/app-store';
import { invoke } from '../lib/ipc';
import { Button, EmptyState, PageHeader, Panel, Stat, formatBytes } from '../components/primitives';
import { Icon } from '../components/icons';
import { LiveLog } from '../components/LiveLog';

/**
 * Activity — what the app has actually done, in plain language.
 *
 * Kept separate from Logs on purpose, because they answer different questions.
 * Logs is for diagnosis: every line, every level, searchable and exportable,
 * and it is where a support conversation starts. Activity is for the person
 * who just wants to know whether their videos arrived — so it is built from
 * the record of finished downloads and the live queue, not from log lines,
 * and it names files and accounts rather than scopes and codes.
 *
 * The live feed is still here at the foot of the page. It is the one part of
 * Logs worth having in front of someone who is not diagnosing anything,
 * because a warning appearing while you watch is how you find out that
 * something needs attention.
 */

function timeAgo(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** The file's own name, which is what the user will look for in the folder. */
function fileNameOf(entry: LibraryEntryDto): string {
  return entry.filePath.split(/[\\/]/).pop() ?? entry.filePath;
}

export function Activity({ onOpenLibrary }: { onOpenLibrary?: () => void }): React.JSX.Element {
  const [recent, setRecent] = useState<LibraryEntryDto[]>([]);
  const [days, setDays] = useState<{ day: string; downloads: number; bytes: number }[]>([]);
  const queueItems = useAppStore((s) => s.queueItems);
  const logs = useAppStore((s) => s.logs);

  const items = useMemo(() => orderedItems(queueItems), [queueItems]);
  const completedCount = useMemo(() => items.filter((i) => i.status === 'completed').length, [items]);

  /**
   * Re-read when a download finishes, not on a timer.
   *
   * `completedCount` changes exactly once per finished video, which is the only
   * thing that adds a row to this list.
   */
  useEffect(() => {
    void invoke('library:list', { limit: 12 })
      .then((result) => setRecent(result.entries))
      .catch(() => undefined);
    void invoke('library:dailyStats', { days: 7 })
      .then((result) => setDays(result.days))
      .catch(() => undefined);
  }, [completedCount]);

  const failures = useMemo(() => items.filter((item) => item.status === 'failed'), [items]);

  const problems = useMemo(() => {
    let warnings = 0;
    let errors = 0;
    for (const entry of logs) {
      if (entry.level === 'warn') warnings++;
      else if (entry.level === 'error' || entry.level === 'fatal') errors++;
    }
    return { warnings, errors };
  }, [logs]);

  const week = useMemo(() => {
    let downloads = 0;
    let bytes = 0;
    for (const day of days) {
      downloads += day.downloads;
      bytes += day.bytes;
    }
    return { downloads, bytes };
  }, [days]);

  const now = Date.now();

  return (
    <div className="flex h-full flex-col gap-5">
      <div className="shrink-0">
        <PageHeader
          title="Activity"
          description="What the app has done recently — what finished, what did not, and what it is telling you about."
          {...(onOpenLibrary
            ? {
                actions: (
                  <Button variant="secondary" icon="library" onClick={onOpenLibrary}>
                    Open library
                  </Button>
                ),
              }
            : {})}
        />

        <Panel bodyClassName="px-5 py-4">
          <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
            <Stat label="Downloaded this week" value={week.downloads} tone={week.downloads > 0 ? 'good' : 'neutral'} />
            {week.bytes > 0 && <Stat label="Written" value={formatBytes(week.bytes)} />}
            <Stat label="Today" value={days[days.length - 1]?.downloads ?? 0} />
            {failures.length > 0 && <Stat label="Failed, still in the queue" value={failures.length} tone="bad" />}
            {problems.errors > 0 && <Stat label="Errors" value={problems.errors} tone="bad" />}
            {problems.warnings > 0 && <Stat label="Warnings" value={problems.warnings} tone="warn" />}
          </div>
        </Panel>
      </div>

      {failures.length > 0 && (
        <Panel
          className="shrink-0"
          title={`${failures.length} did not download`}
          description="Each of these can be tried again. A link that failed because of a slow moment usually works on a second attempt."
          actions={
            <Button icon="retry" onClick={() => void invoke('queue:retryAllFailed')}>
              Retry all
            </Button>
          }
        >
          <ul className="grid gap-1">
            {failures.slice(0, 8).map((item) => (
              <li key={item.id} className="flex items-center gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-white/3">
                <Icon name="alert" size={14} className="shrink-0 text-danger-400" />
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-300" title={item.rawUrl}>
                  {item.awemeId ?? item.rawUrl}
                </span>
                <span className="shrink-0 text-xs text-danger-400/80" title={item.errorDetail ?? undefined}>
                  {item.errorDetail ?? (item.errorCode ? describeError(item.errorCode).title : 'failed')}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  icon="retry"
                  title="Try this one again"
                  onClick={() => void invoke('queue:retryItem', { itemId: item.id })}
                />
              </li>
            ))}
            {failures.length > 8 && (
              <li className="px-2 text-xs text-ink-500">and {failures.length - 8} more in the queue</li>
            )}
          </ul>
        </Panel>
      )}

      <Panel className="shrink-0" title="Recently finished">
        {recent.length === 0 ? (
          <EmptyState title="Nothing downloaded yet" hint="Finished videos are listed here as they arrive." />
        ) : (
          <ul className="grid gap-1">
            {recent.map((entry) => (
              <li key={entry.downloadId} className="flex items-center gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-white/3">
                <Icon name="check" size={14} className="shrink-0 text-mint-400" />
                <span className="min-w-0 flex-1 truncate text-ink-100" title={entry.filePath}>
                  {fileNameOf(entry)}
                </span>
                {entry.authorHandle && (
                  <span className="shrink-0 text-xs text-ink-500">@{entry.authorHandle}</span>
                )}
                {entry.fileSize !== null && (
                  <span className="shrink-0 text-xs text-ink-500">{formatBytes(entry.fileSize)}</span>
                )}
                <span className="w-24 shrink-0 text-right text-xs text-ink-500">
                  {timeAgo(entry.completedAt, now)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* The live feed, full height here rather than squeezed under the queue. */}
      <div className="min-h-48 flex-1">
        <LiveLog />
      </div>
    </div>
  );
}
