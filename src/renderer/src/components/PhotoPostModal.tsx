import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { PhotoAction } from '@shared/types';
import { useAppStore } from '../store/app-store';
import { invoke } from '../lib/ipc';
import { Button } from './primitives';
import { modalVariants, transition, usePrefersReducedMotion } from '../lib/motion-prefs';

/**
 * "This link is a photo slideshow — do you want it?"
 *
 * TikTok posts slideshows through the same URL shape as videos, so one turns up
 * in the middle of a batch with nothing to distinguish it until the download
 * fails. It used to fail with "no video streams were offered", which reads like
 * a broken app rather than a post that is a set of pictures.
 *
 * Neither answer is right for everyone, so it asks — and, crucially, asks only
 * once. Skipping writes the post to the link ledger as declined, which is a
 * permanent record keyed on TikTok's own id: the same slideshow is never raised
 * again, including when its account is listed on a future run.
 *
 * Non-blocking for the same reason the duplicate question is: the engine parked
 * this one item and moved on, so the rest of the batch is downloading while
 * this sits here.
 */
export function PhotoPostModal(): React.JSX.Element | null {
  const pending = useAppStore((s) => s.pendingPhotoPosts);
  const pushToast = useAppStore((s) => s.pushToast);
  const dismissed = useAppStore((s) => s.photoPromptDismissed);
  const setDismissed = useAppStore((s) => s.setPhotoPromptDismissed);
  const [applyToBatch, setApplyToBatch] = useState(false);
  const reduced = usePrefersReducedMotion();

  const current = pending[0];
  if (!current || dismissed) return null;

  async function answer(action: PhotoAction): Promise<void> {
    if (!current) return;
    try {
      await invoke('queue:resolvePhotoPost', { itemId: current.itemId, action, applyToBatch });
      setApplyToBatch(false);
    } catch (err) {
      pushToast({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  const variants = modalVariants(reduced);

  return (
    <AnimatePresence>
      <motion.div
        key="photo-backdrop"
        initial={{ opacity: reduced ? 1 : 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: reduced ? 0 : 0.15 }}
        className="fixed inset-0 z-50 grid place-items-center bg-base-950/70 p-6 backdrop-blur-sm"
      >
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-labelledby="photo-title"
          initial={variants.initial}
          animate={variants.animate}
          exit={variants.exit}
          transition={transition(reduced)}
          className="w-full max-w-lg rounded-[--radius-overlay] border border-white/8 bg-base-850
            p-6 shadow-[var(--shadow-overlay)]"
        >
          <h2 id="photo-title" className="text-lg font-semibold text-ink-100">
            This link is a photo slideshow
          </h2>
          <p className="mt-2 text-sm text-ink-300">
            &ldquo;{current.caption ?? `@${current.authorHandle ?? current.awemeId}`}&rdquo;
          </p>
          <p className="mt-3 text-sm text-ink-500">
            There is no video in this post
            {current.imageCount ? ` — it is ${current.imageCount} image${current.imageCount === 1 ? '' : 's'}` : ''}.
            Downloading it saves the pictures into a folder of their own, beside your videos.
          </p>

          <div className="mt-5 flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => void answer('download')}>
              Download the images
            </Button>
            <Button variant="secondary" onClick={() => void answer('skip')}>
              Skip this post
            </Button>
          </div>

          {/* Stated plainly, because it is the part people will want to be
              sure of: this question does not come back. */}
          <p className="mt-3 text-xs text-ink-500">
            Either way, this post is remembered — it will not be offered again, even if the account it belongs to is
            listed on a later run.
          </p>

          <label className="mt-5 flex items-center gap-2 text-sm text-ink-300">
            <input
              type="checkbox"
              checked={applyToBatch}
              onChange={(event) => setApplyToBatch(event.target.checked)}
              className="size-4 accent-accent-500"
            />
            Do the same for every other slideshow in this batch
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
