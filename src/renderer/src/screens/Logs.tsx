import { useMemo, useState } from 'react';
import { LOG_LEVELS, type LogLevel } from '@shared/types';
import { useAppStore } from '../store/app-store';
import { Button, EmptyState, Panel } from '../components/primitives';

/**
 * Logs — section 10: "This is what makes support tickets solvable — do not
 * skip it." Level filter, search, and export.
 */
const LEVEL_COLOR: Record<LogLevel, string> = {
  trace: 'text-ink-500',
  debug: 'text-ink-500',
  info: 'text-accent-400',
  warn: 'text-warn-400',
  error: 'text-danger-400',
  fatal: 'text-danger-400',
};

const LEVEL_RANK: Record<LogLevel, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5 };

export function Logs(): React.JSX.Element {
  const logs = useAppStore((s) => s.logs);
  const pushToast = useAppStore((s) => s.pushToast);
  const [minLevel, setMinLevel] = useState<LogLevel>('info');
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const needle = search.toLowerCase();
    return logs.filter(
      (entry) =>
        LEVEL_RANK[entry.level] >= LEVEL_RANK[minLevel] &&
        (needle === '' ||
          entry.msg.toLowerCase().includes(needle) ||
          entry.scope.toLowerCase().includes(needle) ||
          JSON.stringify(entry.data ?? {}).toLowerCase().includes(needle)),
    );
  }, [logs, minLevel, search]);

  function exportLogs(): void {
    // A redacted diagnostic bundle (section 12). Sensitive fields were already
    // censored on the way into the log, so what is shown is what is exported.
    const text = filtered
      .map((entry) => `${new Date(entry.time).toISOString()} ${entry.level.toUpperCase()} [${entry.scope}] ${entry.msg} ${entry.data ? JSON.stringify(entry.data) : ''}`)
      .join('\n');

    void navigator.clipboard.writeText(text);
    pushToast({ kind: 'success', message: `${filtered.length} log lines copied to the clipboard` });
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <Panel className="shrink-0">
        <div className="flex flex-wrap items-center gap-3">
          <select
            value={minLevel}
            onChange={(event) => setMinLevel(event.target.value as LogLevel)}
            aria-label="Minimum log level"
            className="rounded-lg border border-white/8 bg-base-900/60 px-3 py-2 text-sm text-ink-100 focus:outline-none"
          >
            {LOG_LEVELS.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>

          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search logs…"
            aria-label="Search logs"
            className="flex-1 rounded-lg border border-white/8 bg-base-900/60 px-3 py-2 text-sm text-ink-100
              placeholder:text-ink-500/60 focus:border-accent-500/50 focus:outline-none"
          />

          <span className="text-sm text-ink-500">{filtered.length} lines</span>
          <Button onClick={exportLogs} disabled={filtered.length === 0}>
            Export
          </Button>
        </div>
      </Panel>

      <div className="elevation-card min-h-0 flex-1 overflow-auto p-4">
        {filtered.length === 0 ? (
          <EmptyState title="Nothing logged yet" hint="Activity appears here as the app runs." />
        ) : (
          <div className="font-mono text-xs leading-relaxed">
            {filtered.map((entry, index) => (
              <div key={`${entry.time}-${index}`} className="flex gap-3 py-0.5 hover:bg-white/3">
                <span className="shrink-0 text-ink-500">{new Date(entry.time).toLocaleTimeString()}</span>
                <span className={`w-12 shrink-0 uppercase ${LEVEL_COLOR[entry.level]}`}>{entry.level}</span>
                <span className="w-24 shrink-0 truncate text-ink-500">{entry.scope}</span>
                <span className="min-w-0 flex-1 break-words text-ink-300">
                  {entry.msg}
                  {entry.data && Object.keys(entry.data).length > 0 && (
                    <span className="ml-2 text-ink-500">{JSON.stringify(entry.data)}</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
