import { useEffect, useMemo, useState } from 'react';
import type { InvokeResponse } from '@shared/ipc/contract';
import { invoke } from '../lib/ipc';
import { useAppStore } from '../store/app-store';
import { Button, EmptyState, Panel, formatBytes } from '../components/primitives';

/**
 * How much was downloaded, per day.
 *
 * The bars are scaled against the busiest day in the window rather than a fixed
 * maximum, so the shape of the last two weeks is readable whether the user does
 * five videos a day or five hundred. Days with no downloads are drawn as empty
 * rather than skipped — a gap is information, and collapsing it would make an
 * idle week look like a busy one.
 */

type DayStat = InvokeResponse<'library:dailyStats'>['days'][number];

const RANGES = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
] as const;

const EMPTY_DAY = { downloads: 0, watermarkFree: 0, reEncoded: 0, bytes: 0 };

/** Local YYYY-MM-DD, matching what SQLite's 'localtime' produced. */
function localDay(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function History(): React.JSX.Element {
  const [days, setDays] = useState(0);
  const [stats, setStats] = useState<DayStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState<number>(30);
  const pushToast = useAppStore((s) => s.pushToast);
  // A completed download changes these numbers, so the view refreshes with it.
  const completedCount = useAppStore(
    (s) => [...s.queueItems.values()].filter((i) => i.status === 'completed').length,
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    invoke('library:dailyStats', { days: range })
      .then((result) => {
        if (cancelled) return;
        setStats(result.days);
        setDays(result.days.length);
      })
      .catch((err: unknown) => {
        if (!cancelled) pushToast({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [range, completedCount, pushToast]);

  /** Every day in the window, including the empty ones, newest first. */
  const series = useMemo(() => {
    const byDay = new Map(stats.map((stat) => [stat.day, stat]));
    const today = new Date();

    return Array.from({ length: range }, (_, offset) => {
      const date = new Date(today);
      date.setDate(today.getDate() - offset);
      const key = localDay(date);
      return { day: key, date, ...(byDay.get(key) ?? EMPTY_DAY) };
    });
  }, [stats, range]);

  const totals = useMemo(
    () =>
      stats.reduce(
        (acc, stat) => ({
          downloads: acc.downloads + stat.downloads,
          watermarkFree: acc.watermarkFree + stat.watermarkFree,
          bytes: acc.bytes + stat.bytes,
        }),
        { downloads: 0, watermarkFree: 0, bytes: 0 },
      ),
    [stats],
  );

  const busiest = Math.max(1, ...series.map((d) => d.downloads));
  const activeDays = series.filter((d) => d.downloads > 0).length;

  if (loading && stats.length === 0) {
    return <div className="p-8 text-ink-500">Loading history…</div>;
  }

  if (totals.downloads === 0) {
    return (
      <EmptyState
        title="Nothing downloaded yet"
        hint="Once videos start completing, this shows how many you saved each day."
      />
    );
  }

  return (
    <div className="mx-auto grid max-w-4xl gap-5 pb-10">
      <Panel title={`Last ${range} days`}>
        <div className="flex flex-wrap items-baseline gap-x-8 gap-y-3">
          <div>
            <p className="text-3xl font-semibold text-ink-100">{totals.downloads}</p>
            <p className="text-xs text-ink-500">videos downloaded</p>
          </div>
          <div>
            <p className="text-3xl font-semibold text-mint-300">{totals.watermarkFree}</p>
            <p className="text-xs text-ink-500">watermark-free</p>
          </div>
          <div>
            <p className="text-3xl font-semibold text-ink-100">{formatBytes(totals.bytes)}</p>
            <p className="text-xs text-ink-500">saved to disk</p>
          </div>
          <div>
            <p className="text-3xl font-semibold text-ink-100">
              {activeDays > 0 ? Math.round(totals.downloads / activeDays) : 0}
            </p>
            <p className="text-xs text-ink-500">average on an active day</p>
          </div>

          <div className="ml-auto flex gap-1">
            {RANGES.map((option) => (
              <Button
                key={option.days}
                variant={range === option.days ? 'primary' : 'ghost'}
                onClick={() => setRange(option.days)}
              >
                {option.label}
              </Button>
            ))}
          </div>
        </div>
      </Panel>

      <Panel title={`Per day · ${days} with activity`}>
        <ol className="grid gap-1">
          {series.map((day) => {
            const width = (day.downloads / busiest) * 100;
            return (
              <li key={day.day} className="flex items-center gap-3 text-xs">
                <span className="w-24 shrink-0 font-mono text-ink-500">
                  {day.date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
                </span>

                <div className="h-5 min-w-0 flex-1 overflow-hidden rounded bg-white/4">
                  {day.downloads > 0 && (
                    <div
                      className="flex h-full items-center rounded bg-accent-500/40"
                      style={{ width: `${Math.max(width, 2)}%` }}
                      title={`${day.watermarkFree} of ${day.downloads} watermark-free`}
                    >
                      {/* The clean portion, drawn inside the day's total. */}
                      <div
                        className="h-full rounded-l bg-mint-500/60"
                        style={{
                          width: day.downloads > 0 ? `${(day.watermarkFree / day.downloads) * 100}%` : '0%',
                        }}
                      />
                    </div>
                  )}
                </div>

                <span className="w-10 shrink-0 text-right font-mono text-ink-300">{day.downloads || ''}</span>
                <span className="w-16 shrink-0 text-right font-mono text-ink-500">
                  {day.bytes > 0 ? formatBytes(day.bytes) : ''}
                </span>
              </li>
            );
          })}
        </ol>

        <p className="mt-4 flex items-center gap-4 border-t border-white/5 pt-3 text-xs text-ink-500">
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm bg-mint-500/60" aria-hidden="true" /> watermark-free
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm bg-accent-500/40" aria-hidden="true" /> still watermarked
          </span>
        </p>
      </Panel>
    </div>
  );
}
