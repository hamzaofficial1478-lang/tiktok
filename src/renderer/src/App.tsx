import { useEffect } from 'react';
import { useAppStore } from './store/app-store';

/**
 * Phase-1 renderer: a system-status panel, not the product UI.
 *
 * It exists to prove the boundary end to end — four IPC round trips, a live
 * push subscription, and the ffmpeg capability report — against real services.
 * The five screens in section 10 replace this in phase 6; the token classes
 * used here are the ones those screens will build on.
 */

function StatusDot({ ok }: { ok: boolean | null }): React.JSX.Element {
  const color = ok === null ? 'bg-ink-500' : ok ? 'bg-mint-400' : 'bg-danger-400';
  return <span className={`inline-block size-2 rounded-full ${color}`} aria-hidden="true" />;
}

function Panel({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="elevation-card p-5">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-ink-500">{title}</h2>
      {children}
    </section>
  );
}

export default function App(): React.JSX.Element {
  const { ready, versions, sidecars, capabilities, config, logs, error, bootstrap } = useAppStore();

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  if (!ready) {
    return (
      <div className="grid h-full place-items-center text-ink-500" role="status" aria-live="polite">
        Starting…
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-base-900 p-8">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">TikTok Downloader</h1>
        <p className="mt-1 text-sm text-ink-500">
          Phase 1 · scaffold, IPC boundary, database, sidecars, logging
        </p>
      </header>

      {error && (
        <div
          className="mb-6 rounded-xl border border-danger-400/40 bg-danger-400/10 p-4 text-sm text-danger-400"
          role="alert"
        >
          {error}
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title="Versions">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            {versions &&
              Object.entries(versions).map(([key, value]) => (
                <div key={key} className="contents">
                  <dt className="text-ink-500 capitalize">{key}</dt>
                  <dd className="font-mono text-ink-300">{value ?? 'not installed'}</dd>
                </div>
              ))}
          </dl>
        </Panel>

        <Panel title="Sidecars">
          <ul className="space-y-2 text-sm">
            {sidecars.map((sidecar) => (
              <li key={sidecar.name} className="flex items-baseline gap-2">
                <StatusDot ok={sidecar.present ? sidecar.checksumValid !== false : false} />
                <span className="font-mono text-ink-300">{sidecar.name}</span>
                <span className="text-ink-500">{sidecar.error ?? sidecar.version ?? 'ok'}</span>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="ffmpeg capabilities">
          {capabilities?.probed ? (
            <div className="space-y-3 text-sm">
              <p className="flex items-center gap-2">
                <StatusDot ok={capabilities.isGplBuild === false} />
                <span className="text-ink-300">
                  {capabilities.isGplBuild === null
                    ? 'build licence unknown'
                    : capabilities.isGplBuild
                      ? 'GPL build — must not ship commercially'
                      : 'LGPL build'}
                </span>
              </p>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(capabilities.filters).map(([name, present]) => (
                  <span
                    key={name}
                    className={`rounded-md px-2 py-0.5 font-mono text-xs ${
                      present ? 'bg-mint-500/15 text-mint-300' : 'bg-base-700 text-ink-500 line-through'
                    }`}
                  >
                    {name}
                  </span>
                ))}
              </div>
              {capabilities.missingRequired.length > 0 && (
                <p className="text-warn-400">Missing: {capabilities.missingRequired.join(', ')}</p>
              )}
            </div>
          ) : (
            <p className="text-sm text-ink-500">ffmpeg not available — capabilities not probed.</p>
          )}
        </Panel>

        <Panel title="Settings">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            {config &&
              Object.entries(config).map(([key, value]) => (
                <div key={key} className="contents">
                  <dt className="text-ink-500">{key}</dt>
                  <dd className="truncate font-mono text-ink-300">{String(value === '' ? '—' : value)}</dd>
                </div>
              ))}
          </dl>
        </Panel>
      </div>

      <div className="mt-5">
        <Panel title={`Logs (${logs.length})`}>
          <div className="max-h-72 overflow-y-auto font-mono text-xs leading-relaxed" aria-live="polite">
            {logs.map((entry, index) => (
              <div key={`${entry.time}-${index}`} className="flex gap-3">
                <span className="shrink-0 text-ink-500">{new Date(entry.time).toLocaleTimeString()}</span>
                <span
                  className={`w-12 shrink-0 uppercase ${
                    entry.level === 'error' || entry.level === 'fatal'
                      ? 'text-danger-400'
                      : entry.level === 'warn'
                        ? 'text-warn-400'
                        : 'text-accent-400'
                  }`}
                >
                  {entry.level}
                </span>
                <span className="shrink-0 text-ink-500">{entry.scope}</span>
                <span className="text-ink-300">{entry.msg}</span>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}
