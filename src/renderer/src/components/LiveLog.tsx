import { useEffect, useMemo, useRef, useState } from 'react';
import type { LogEntry } from '@shared/ipc/contract';
import { useAppStore } from '../store/app-store';

/**
 * A live tail of what the engine is doing, on the screen the user is already
 * watching.
 *
 * The full Logs screen still exists for diagnosis; this is the ambient version.
 * It defaults to warnings and errors only, because the value of a log on the
 * main screen is that something appearing in it *means something*. A scrolling
 * wall of info lines trains people to ignore it, which is worse than not having
 * it at all.
 */

const LEVEL_STYLE: Record<string, string> = {
  error: 'text-danger-400',
  fatal: 'text-danger-400',
  warn: 'text-warn-400',
  info: 'text-ink-300',
  debug: 'text-ink-500',
  trace: 'text-ink-500',
};

const PROBLEM_LEVELS = new Set(['warn', 'error', 'fatal']);

/**
 * The one field from a log entry's structured data worth showing inline.
 *
 * Preferred in order of how much it explains the entry. `stderr` first because
 * when a sidecar fails, its own words are the answer and everything else is
 * our paraphrase of them.
 */
function detailOf(entry: LogEntry): string {
  const data = entry.data;
  if (!data) return '';
  for (const key of ['stderr', 'detail', 'err', 'errorDetail', 'reason', 'path']) {
    const value = data[key];
    if (typeof value === 'string' && value.trim() !== '') {
      const line = value.split('\n')[0]?.trim() ?? '';
      return line.length > 160 ? `${line.slice(0, 160)}…` : line;
    }
  }
  return '';
}

function timeOf(entry: LogEntry): string {
  const date = new Date(entry.time);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(
    date.getSeconds(),
  ).padStart(2, '0')}`;
}

export function LiveLog(): React.JSX.Element {
  const logs = useAppStore((s) => s.logs);
  const [showAll, setShowAll] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);

  const visible = useMemo(() => {
    const filtered = showAll ? logs : logs.filter((entry) => PROBLEM_LEVELS.has(entry.level));
    return filtered.slice(-200);
  }, [logs, showAll]);

  const problems = useMemo(() => {
    let warnings = 0;
    let errors = 0;
    for (const entry of logs) {
      if (entry.level === 'warn') warnings++;
      else if (entry.level === 'error' || entry.level === 'fatal') errors++;
    }
    return { warnings, errors };
  }, [logs]);

  // Follow the tail, but stop fighting the user the moment they scroll up to
  // read something.
  useEffect(() => {
    if (!pinned) return;
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [visible, pinned]);

  return (
    <section className="elevation-card flex min-h-0 flex-col" aria-label="Activity">
      <header className="flex shrink-0 items-center gap-3 border-b border-white/5 px-4 py-2">
        <span className="text-sm font-medium text-ink-100">Activity</span>

        {problems.errors > 0 && (
          <span className="rounded bg-danger-400/20 px-1.5 py-0.5 text-[10px] font-medium text-danger-400">
            {problems.errors} error{problems.errors === 1 ? '' : 's'}
          </span>
        )}
        {problems.warnings > 0 && (
          <span className="rounded bg-warn-400/20 px-1.5 py-0.5 text-[10px] font-medium text-warn-400">
            {problems.warnings} warning{problems.warnings === 1 ? '' : 's'}
          </span>
        )}

        <label className="ml-auto flex items-center gap-1.5 text-xs text-ink-500">
          <input
            type="checkbox"
            checked={showAll}
            onChange={(event) => setShowAll(event.target.checked)}
            className="size-3.5 accent-accent-500"
          />
          Show everything
        </label>
      </header>

      <div
        ref={scrollRef}
        onScroll={(event) => {
          const el = event.currentTarget;
          setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
        }}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-2 font-mono text-xs"
        aria-live="polite"
      >
        {visible.length === 0 ? (
          <p className="py-3 text-ink-500">
            {showAll ? 'Nothing logged yet.' : 'No warnings or errors — everything is going fine.'}
          </p>
        ) : (
          visible.map((entry, index) => (
            <p key={`${entry.time}-${index}`} className="flex gap-2 py-0.5">
              <span className="shrink-0 text-ink-500">{timeOf(entry)}</span>
              <span className={`min-w-0 flex-1 break-words ${LEVEL_STYLE[entry.level] ?? 'text-ink-300'}`}>
                {entry.msg}
                {/* Structured fields carry the detail that makes a warning
                    actionable; showing only the message hides the reason. */}
                {detailOf(entry) && <span className="ml-2 text-ink-500">{detailOf(entry)}</span>}
              </span>
            </p>
          ))
        )}
      </div>
    </section>
  );
}
