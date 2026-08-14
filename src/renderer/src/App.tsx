import { Suspense, lazy, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useAppStore } from './store/app-store';
import { invoke } from './lib/ipc';
import { AddLinks } from './screens/AddLinks';
import { Queue } from './screens/Queue';
import { ResourceBar } from './components/ResourceBar';
import { Library } from './screens/Library';
import { History } from './screens/History';
import { Settings } from './screens/Settings';
import { Logs } from './screens/Logs';
import { DuplicateModal } from './components/DuplicateModal';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Button } from './components/primitives';
import { transition, usePrefersReducedMotion } from './lib/motion-prefs';

/**
 * three.js is ~2MB and the scene is pure atmosphere, so it is split into its
 * own chunk and only fetched when it is actually going to be shown. A user
 * with reduce-effects on never downloads or parses it at all.
 */
const BackgroundScene = lazy(() =>
  import('./scene/BackgroundScene').then((module) => ({ default: module.BackgroundScene })),
);

type Screen = 'add' | 'queue' | 'library' | 'history' | 'settings' | 'logs';

const NAV: readonly { id: Screen; label: string }[] = [
  { id: 'add', label: 'Add links' },
  { id: 'queue', label: 'Queue' },
  { id: 'library', label: 'Library' },
  { id: 'history', label: 'History' },
  { id: 'settings', label: 'Settings' },
  { id: 'logs', label: 'Logs' },
];

function Toasts(): React.JSX.Element {
  const toasts = useAppStore((s) => s.toasts);
  const dismiss = useAppStore((s) => s.dismissToast);
  const reduced = usePrefersReducedMotion();

  return (
    <div className="pointer-events-none fixed bottom-6 right-6 z-40 flex flex-col gap-2" aria-live="polite">
      <AnimatePresence initial={false}>
      {toasts.map((toast) => (
        <motion.div
          key={toast.id}
          layout={!reduced}
          initial={reduced ? false : { opacity: 0, x: 24, scale: 0.96 }}
          animate={{ opacity: 1, x: 0, scale: 1 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, x: 24, scale: 0.96 }}
          transition={transition(reduced)}
          className={`pointer-events-auto flex items-center gap-3 rounded-xl border px-4 py-3 text-sm shadow-[var(--shadow-card)]
            ${
              toast.kind === 'error'
                ? 'border-danger-400/30 bg-danger-400/12 text-danger-400'
                : toast.kind === 'warning'
                  ? 'border-warn-400/30 bg-warn-400/12 text-warn-400'
                  : toast.kind === 'success'
                    ? 'border-mint-500/30 bg-mint-500/12 text-mint-300'
                    : 'border-white/8 bg-base-800 text-ink-300'
            }`}
        >
          <span>{toast.message}</span>
          {toast.action && (
            <button onClick={toast.action.run} className="font-medium underline underline-offset-2">
              {toast.action.label}
            </button>
          )}
          <button onClick={() => dismiss(toast.id)} aria-label="Dismiss" className="text-ink-500 hover:text-ink-100">
            ✕
          </button>
        </motion.div>
      ))}
      </AnimatePresence>
    </div>
  );
}

export default function App(): React.JSX.Element {
  const { ready, bootError, queueState, pendingDuplicates, bootstrap } = useAppStore();
  const queueCount = useAppStore((s) => s.queueItems.size);
  const proxyUrl = useAppStore((s) => s.config?.proxyUrl ?? '');
  const [screen, setScreen] = useState<Screen>('add');
  const reducedMotion = usePrefersReducedMotion();
  const setDuplicatePromptDismissed = useAppStore((s) => s.setDuplicatePromptDismissed);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  /** Keyboard shortcuts (section 10). */
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      const target = event.target as HTMLElement | null;
      const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA';

      if (event.key === ' ' && !typing) {
        event.preventDefault();
        // A queue that was never started should start, not be "paused".
        if (!queueState.running) void invoke('queue:start');
        else void invoke(queueState.paused ? 'queue:resume' : 'queue:pause');
      }
      if (event.key === 'f' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        setScreen('library');
      }
    }

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [queueState.paused, queueState.running]);

  if (!ready) {
    return (
      <div className="grid h-full place-items-center text-ink-500" role="status" aria-live="polite">
        Starting…
      </div>
    );
  }

  if (bootError) {
    return (
      <div className="grid h-full place-items-center p-8">
        <div className="max-w-md rounded-xl border border-danger-400/30 bg-danger-400/10 p-6 text-center">
          <p className="font-medium text-danger-400">The app could not start</p>
          <p className="mt-2 text-sm text-ink-300">{bootError}</p>
          <div className="mt-4 flex justify-center">
            <Button onClick={() => window.location.reload()}>Try again</Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {!reducedMotion && (
        <Suspense fallback={null}>
          <BackgroundScene />
        </Suspense>
      )}
      <header className="flex shrink-0 items-center gap-1 border-b border-white/5 px-4 py-2">
        <span className="mr-4 text-sm font-semibold tracking-tight text-ink-100">TikTok Downloader</span>

        <nav className="flex gap-1" aria-label="Screens">
          {NAV.map((item) => (
            <button
              key={item.id}
              onClick={() => setScreen(item.id)}
              aria-current={screen === item.id ? 'page' : undefined}
              className={`relative rounded-lg px-3 py-1.5 text-sm transition-colors ${
                screen === item.id ? 'bg-white/8 text-ink-100' : 'text-ink-500 hover:bg-white/4 hover:text-ink-300'
              }`}
            >
              {item.label}
              {item.id === 'queue' && queueCount > 0 && (
                <span className="ml-2 rounded bg-base-700 px-1.5 py-0.5 text-[10px] text-ink-300">{queueCount}</span>
              )}
            </button>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          {/* Routing through a proxy changes what TikTok serves and how fast,
              so it is never left invisible. */}
          {proxyUrl.trim() !== '' && (
            <button
              onClick={() => setScreen('settings')}
              title={`All requests go through ${proxyUrl}`}
              className="rounded-md bg-accent-500/15 px-2 py-1 text-xs font-medium text-accent-300 hover:bg-accent-500/25"
            >
              proxy on
            </button>
          )}
          {pendingDuplicates.length > 0 && (
            // The way back to a question dismissed with "Later".
            <button
              onClick={() => setDuplicatePromptDismissed(false)}
              className="rounded-md bg-warn-400/20 px-2 py-1 text-xs font-medium text-warn-400 hover:bg-warn-400/30"
            >
              {pendingDuplicates.length} question{pendingDuplicates.length === 1 ? '' : 's'}
            </button>
          )}
          {queueState.running && (
            <span className="flex items-center gap-2 text-xs text-ink-500">
              <span
                className={`size-2 rounded-full ${queueState.paused ? 'bg-warn-400' : 'bg-mint-400'}`}
                aria-hidden="true"
              />
              {queueState.paused ? 'Paused' : `${queueState.active} active`}
            </span>
          )}
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto p-6">
        <ErrorBoundary screenKey={screen}>
          {screen === 'add' && <AddLinks onQueued={() => setScreen('queue')} />}
          {screen === 'queue' && <Queue />}
          {screen === 'library' && <Library />}
          {screen === 'history' && <History />}
          {screen === 'settings' && <Settings />}
          {screen === 'logs' && <Logs />}
        </ErrorBoundary>
      </main>

      <ResourceBar />

      <DuplicateModal />
      <Toasts />
    </div>
  );
}
