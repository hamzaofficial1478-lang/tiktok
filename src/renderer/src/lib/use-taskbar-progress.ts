import { useEffect, useMemo, useRef } from 'react';
import { useAppStore } from '../store/app-store';
import { invoke } from './ipc';
import { drawBadge } from './taskbar';

/**
 * Keeps the taskbar button telling the truth about the queue.
 *
 * The point is working elsewhere. A batch runs for minutes or hours, and the
 * app is not the window you are looking at while it does — so the count that
 * matters most is the one visible without switching to it. The taskbar button
 * carries both halves: a progress bar for how far through, and a badge with
 * how many are left.
 *
 * Sent only when something actually changes. The queue emits progress several
 * times a second per item, and redrawing a 32×32 badge and crossing IPC on
 * every tick would be a lot of work to show the same number again.
 */
export function useTaskbarProgress(): void {
  const queueItems = useAppStore((state) => state.queueItems);
  const lastSent = useRef<string>('');

  const counts = useMemo(() => {
    let done = 0;
    let failed = 0;
    let remaining = 0;

    for (const item of queueItems.values()) {
      if (item.status === 'completed') done++;
      else if (item.status === 'failed') failed++;
      else if (item.status !== 'skipped' && item.status !== 'cancelled') remaining++;
    }
    return { done, failed, remaining };
  }, [queueItems]);

  useEffect(() => {
    const { done, failed, remaining } = counts;
    const total = done + failed + remaining;

    /**
     * The bar tracks everything that has been dealt with, failures included.
     *
     * A bar that stopped at 90% because one link failed would look like a stall
     * rather than a finished run with a problem in it — which is what the red
     * tint and the badge are for.
     */
    const fraction = total > 0 && remaining > 0 ? (done + failed) / total : null;

    // Nothing outstanding and nothing failed: clear it rather than leave a
    // full bar sitting on the button after the run is over.
    const key = `${remaining}|${fraction === null ? 'x' : fraction.toFixed(3)}|${failed > 0}`;
    if (key === lastSent.current) return;
    lastSent.current = key;

    void invoke('system:setTaskbarProgress', {
      remaining,
      fraction,
      hasFailures: failed > 0,
      badge: drawBadge(remaining, failed > 0),
    }).catch(() => undefined);
  }, [counts]);
}
