import { useEffect, useRef, useState } from 'react';
import { invoke } from '../lib/ipc';
import { formatBytes } from './primitives';

/**
 * What the app is costing the machine, along the bottom of every screen.
 *
 * A downloader that runs for an hour with ffmpeg passes behind it is the kind
 * of program people watch, and Task Manager cannot answer the question: an
 * Electron app is a browser process, a renderer, a GPU process and a utility
 * process per sidecar, so no single row there is "this app".
 *
 * Polled rather than pushed. Chromium measures CPU since the previous call, so
 * a fixed interval is what makes the number a live reading instead of a
 * session-long average — and polling stops with the component, so a hidden
 * window costs nothing.
 */

const POLL_MS = 2_000;

/**
 * Never rounds a real reading down to a flat zero.
 *
 * A busy app using 3% of one core on a sixteen-core machine is 0.19% of the
 * machine, and `toFixed(0)` printed that as "0%" — so the meter said idle
 * while work was happening. "<1%" is small and honest; "0%" was neither.
 */
function percent(value: number): string {
  if (value <= 0) return '0%';
  if (value < 1) return '<1%';
  return `${value.toFixed(value < 10 ? 1 : 0)}%`;
}

interface Sample {
  readonly cpuPercent: number;
  readonly systemCpuPercent: number | null;
  readonly memoryBytes: number;
  readonly systemMemoryUsedBytes: number | null;
  readonly systemMemoryBytes: number | null;
  readonly processCount: number;
  readonly gpu: { readonly name: string; readonly accelerated: boolean; readonly memoryBytes: number } | null;
}

/** A meter that stays legible at a glance: the bar carries the value, not a colour code. */
function Meter({ label, value, detail }: { label: string; value: number; detail: string }): React.JSX.Element {
  const clamped = Math.min(100, Math.max(0, value));
  return (
    <div className="flex items-center gap-2" title={`${label}: ${detail}`}>
      <span className="text-[11px] font-medium uppercase tracking-wide text-ink-500">{label}</span>
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-white/8" role="presentation">
        <div
          className={`h-full rounded-full transition-[width] duration-500 ${
            clamped > 85 ? 'bg-warn-400' : 'bg-accent-400'
          }`}
          style={{ width: `${clamped}%` }}
        />
      </div>
      <span className="tabular-nums text-xs text-ink-300">{detail}</span>
    </div>
  );
}

export function ResourceBar(): React.JSX.Element | null {
  const [sample, setSample] = useState<Sample | null>(null);
  const [failed, setFailed] = useState(false);
  // Held in a ref so a slow sample never lands after unmount and sets state.
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;

    const poll = async (): Promise<void> => {
      try {
        const next = await invoke('system:getResources');
        if (alive.current) setSample(next);
      } catch {
        // One failure is not worth a message: this is an ambient readout, and
        // a toast about a status bar would be worse than the missing numbers.
        if (alive.current) setFailed(true);
      }
    };

    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, []);

  if (failed && sample === null) return null;

  const memoryShare =
    sample && sample.systemMemoryBytes ? (sample.memoryBytes / sample.systemMemoryBytes) * 100 : 0;

  return (
    <footer
      className="flex shrink-0 items-center gap-5 border-t border-white/6 bg-base-950/60 px-6 py-2"
      aria-label="Resource usage"
    >
      {sample === null ? (
        <span className="text-xs text-ink-500">Measuring…</span>
      ) : (
        <>
          {/**
           * Two figures, because they answer different questions during a
           * download. The app's own share stays small and steady — the work is
           * in yt-dlp and ffmpeg, which are child processes Chromium does not
           * report — so showing only that left the meter reading 0% while the
           * machine was busy. `percent` also never rounds a real value down to
           * a flat zero, which made a working app look idle.
           */}
          <Meter
            label="App CPU"
            value={sample.cpuPercent}
            detail={percent(sample.cpuPercent)}
          />
          {sample.systemCpuPercent !== null && (
            <Meter
              label="System"
              value={sample.systemCpuPercent}
              detail={percent(sample.systemCpuPercent)}
            />
          )}
          <Meter
            label="RAM"
            value={memoryShare}
            detail={
              sample.systemMemoryBytes
                ? `${formatBytes(sample.memoryBytes)} app · ${formatBytes(
                    sample.systemMemoryUsedBytes ?? 0,
                  )} of ${formatBytes(sample.systemMemoryBytes)} used`
                : formatBytes(sample.memoryBytes)
            }
          />

          {/**
           * A name and a state, never a percentage. Electron exposes no GPU
           * utilisation measurement, and a figure derived from the GPU
           * process's CPU time would look authoritative and mean nothing.
           */}
          {sample.gpu && (
            <div className="flex items-center gap-2" title={sample.gpu.name}>
              <span className="text-[11px] font-medium uppercase tracking-wide text-ink-500">GPU</span>
              <span
                className={`size-1.5 rounded-full ${sample.gpu.accelerated ? 'bg-mint-400' : 'bg-ink-500'}`}
                aria-hidden="true"
              />
              <span className="max-w-52 truncate text-xs text-ink-300">
                {sample.gpu.accelerated ? sample.gpu.name : `${sample.gpu.name} (software rendering)`}
              </span>
            </div>
          )}

          <span className="ml-auto text-xs text-ink-500">
            {sample.processCount} process{sample.processCount === 1 ? '' : 'es'}
          </span>
        </>
      )}
    </footer>
  );
}
