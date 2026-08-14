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
import { Sidebar, type NavItem } from './components/Sidebar';
import { Icon } from './components/icons';
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

const NAV: readonly { id: Screen; label: string; icon: NavItem<Screen>['icon'] }[] = [
  { id: 'add', label: 'Add links', icon: 'add' },
  { id: 'queue', label: 'Queue', icon: 'queue' },
  { id: 'library', label: 'Library', icon: 'library' },
  { id: 'history', label: 'History', icon: 'history' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
  { id: 'logs', label: 'Logs', icon: 'logs' },
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

  const navItems: NavItem<Screen>[] = NAV.map((item) => ({
    ...item,
    ...(item.id === 'queue' && queueCount > 0 ? { count: queueCount } : {}),
    ...(item.id === 'queue' && pendingDuplicates.length > 0 ? { alert: true } : {}),
  }));

  return (
    <div className="flex h-full">
      {!reducedMotion && (
        <Suspense fallback={null}>
          <BackgroundScene />
        </Suspense>
      )}

      <Sidebar
        items={navItems}
        current={screen}
        onSelect={setScreen}
        footer={
          /* The two states that change what the app does are stated where the
             navigation is, not buried in a header the eye has stopped reading. */
          <div className="grid gap-2">
            {queueState.running && (
              <span className="flex items-center gap-2 text-xs text-ink-500">
                <span
                  className={`size-2 rounded-full ${queueState.paused ? 'bg-warn-400' : 'bg-mint-400 animate-pulse'}`}
                  aria-hidden="true"
                />
                {queueState.paused ? 'Paused' : `${queueState.active} downloading`}
              </span>
            )}
            {proxyUrl.trim() !== '' && (
              <button
                onClick={() => setScreen('settings')}
                title={`All requests go through ${proxyUrl}`}
                className="flex items-center gap-2 rounded-md px-1 py-0.5 text-xs font-medium text-accent-300 hover:bg-white/5"
              >
                <span className="size-2 rounded-full bg-accent-400" aria-hidden="true" />
                Proxy on
              </button>
            )}
          </div>
        }
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {pendingDuplicates.length > 0 && (
          /* A question that was put off is a stopped queue item, so the way
             back to it is a banner rather than a chip in the corner. */
          <button
            onClick={() => setDuplicatePromptDismissed(false)}
            className="flex shrink-0 items-center gap-2 border-b border-warn-400/20 bg-warn-400/10 px-6 py-2
              text-left text-xs font-medium text-warn-400 hover:bg-warn-400/15"
          >
            <Icon name="alert" size={14} />
            {pendingDuplicates.length} question{pendingDuplicates.length === 1 ? '' : 's'} waiting — these downloads
            are on hold until you answer
          </button>
        )}

        <main className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
          <ErrorBoundary screenKey={screen}>
            {screen === 'add' && <AddLinks onQueued={() => setScreen('queue')} />}
            {screen === 'queue' && <Queue onAddLinks={() => setScreen('add')} />}
            {screen === 'library' && <Library />}
            {screen === 'history' && <History />}
            {screen === 'settings' && <Settings />}
            {screen === 'logs' && <Logs />}
          </ErrorBoundary>
        </main>

        <ResourceBar />
      </div>

      <DuplicateModal />
      <Toasts />
    </div>
  );
}
