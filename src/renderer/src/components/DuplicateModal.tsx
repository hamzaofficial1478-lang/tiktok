import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { DuplicateAction } from '@shared/types';
import { useAppStore } from '../store/app-store';
import { invoke } from '../lib/ipc';
import { Button } from './primitives';
import { modalVariants, transition, usePrefersReducedMotion } from '../lib/motion-prefs';

/**
 * Dedup layer 3's question — spec section 7.
 *
 * The critical property is what this component does NOT do: it does not block
 * the queue. By the time it appears, the engine has already parked that one
 * item in `awaiting_user` and moved on to the next. Several questions can be
 * outstanding at once, and dismissing this leaves them in the header badge
 * rather than losing them.
 */
export function DuplicateModal(): React.JSX.Element | null {
  const pending = useAppStore((s) => s.pendingDuplicates);
  const pushToast = useAppStore((s) => s.pushToast);
  const [applyToBatch, setApplyToBatch] = useState(false);
  const dismissed = useAppStore((s) => s.duplicatePromptDismissed);
  const setDismissed = useAppStore((s) => s.setDuplicatePromptDismissed);
  const reduced = usePrefersReducedMotion();

  const current = pending[0];
  if (!current || dismissed) return null;

  async function answer(action: DuplicateAction): Promise<void> {
    if (!current) return;
    try {
      await invoke('queue:resolveDuplicate', { itemId: current.itemId, action, applyToBatch });
      // The choice is scoped to this batch and is deliberately not remembered
      // beyond it, so the checkbox resets with the modal.
      setApplyToBatch(false);
    } catch (err) {
      pushToast({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  const variants = modalVariants(reduced);

  return (
    <AnimatePresence>
      <motion.div
        key="backdrop"
        initial={{ opacity: reduced ? 1 : 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: reduced ? 0 : 0.15 }}
        className="fixed inset-0 z-50 grid place-items-center bg-base-950/70 p-6 backdrop-blur-sm"
      >
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-labelledby="duplicate-title"
          initial={variants.initial}
          animate={variants.animate}
          exit={variants.exit}
          transition={transition(reduced)}
          className="w-full max-w-lg rounded-[--radius-overlay] border border-white/8 bg-base-850
            p-6 shadow-[var(--shadow-overlay)]"
        >
        <h2 id="duplicate-title" className="text-lg font-semibold text-ink-100">
          Already downloaded
        </h2>
        <p className="mt-2 text-sm text-ink-300">
          &ldquo;{current.caption ?? `@${current.authorHandle ?? current.awemeId}`}&rdquo;
        </p>
        <dl className="mt-4 grid grid-cols-[5rem_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-ink-500">Downloaded</dt>
          <dd className="text-ink-300">{new Date(current.downloadedAt).toLocaleString()}</dd>
          <dt className="text-ink-500">Location</dt>
          <dd className="break-all font-mono text-ink-300">{current.existingFilePath}</dd>
        </dl>

        <div className="mt-5 flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => void answer('skip')}>
            Skip
          </Button>
          <Button variant="primary" onClick={() => void answer('redownload')}>
            Download again
          </Button>
          <Button variant="secondary" onClick={() => void answer('replace')}>
            Replace existing
          </Button>
          <Button
            variant="ghost"
            onClick={() => void invoke('system:showInFolder', { path: current.existingFilePath })}
          >
            Open folder
          </Button>
        </div>

        <label className="mt-5 flex items-center gap-2 text-sm text-ink-300">
          <input
            type="checkbox"
            checked={applyToBatch}
            onChange={(event) => setApplyToBatch(event.target.checked)}
            className="size-4 accent-accent-500"
          />
          Apply this choice to all remaining duplicates in this batch
        </label>

        <div className="mt-5 flex items-center justify-between border-t border-white/5 pt-4">
          <span className="text-xs text-ink-500">
            {pending.length > 1 ? `${pending.length - 1} more waiting` : 'The queue keeps downloading meanwhile'}
          </span>
          <Button
            variant="ghost"
            onClick={() => setDismissed(true)}
            title="The questions stay in the header until you answer them"
          >
            Later
          </Button>
        </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
