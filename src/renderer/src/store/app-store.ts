import { create } from 'zustand';
import type { AppConfig } from '@shared/config-schema';
import type {
  BatchSummaryDto,
  LogEntry,
  MediaCapabilities,
  PendingDuplicateDto,
  QueueItemDto,
  QueueStateDto,
  SidecarStatus,
  Versions,
} from '@shared/ipc/contract';
import { invoke, subscribe } from '../lib/ipc';

/**
 * Renderer state.
 *
 * Spec section 3: "the renderer holds a synced read model, never the source of
 * truth." Nothing here computes what main owns — it mirrors what main pushes
 * and forwards user intent back over IPC. Queue rows in particular are a
 * projection of SQLite, never a second copy the UI mutates.
 */

const MAX_LOG_ENTRIES = 2_000;

export interface Toast {
  readonly id: number;
  readonly kind: 'info' | 'success' | 'warning' | 'error';
  readonly message: string;
  readonly action?: { readonly label: string; readonly run: () => void };
}

interface AppState {
  ready: boolean;
  bootError: string | null;

  versions: Versions | null;
  sidecars: SidecarStatus[];
  capabilities: MediaCapabilities | null;
  config: AppConfig | null;
  logs: LogEntry[];

  /** Keyed by id so a progress event is an O(1) replace, not a list scan. */
  queueItems: Map<number, QueueItemDto>;
  queueState: QueueStateDto;
  pendingDuplicates: PendingDuplicateDto[];
  lastBatch: BatchSummaryDto | null;
  toasts: Toast[];
  /** True while the user has chosen 'Later' on the duplicate question. */
  duplicatePromptDismissed: boolean;

  bootstrap(): Promise<void>;
  setDuplicatePromptDismissed(dismissed: boolean): void;
  updateConfig(patch: Partial<AppConfig>): Promise<void>;
  pushToast(toast: Omit<Toast, 'id'>): void;
  dismissToast(id: number): void;
  refreshQueue(): Promise<void>;
}

let toastId = 0;

/**
 * React StrictMode deliberately invokes effects twice in development. Without
 * this guard the second run subscribes to every IPC channel a second time, and
 * every log line, toast and batch summary arrives duplicated — visible only
 * when running `npm run dev`, which is exactly when it is most confusing.
 */
let bootstrapped = false;

export const useAppStore = create<AppState>((set, get) => ({
  ready: false,
  bootError: null,

  versions: null,
  sidecars: [],
  capabilities: null,
  config: null,
  logs: [],

  queueItems: new Map(),
  queueState: { running: false, paused: false, active: 0 },
  pendingDuplicates: [],
  lastBatch: null,
  toasts: [],
  duplicatePromptDismissed: false,

  async bootstrap(): Promise<void> {
    if (bootstrapped) return;
    bootstrapped = true;
    try {
      const [versions, sidecarStatus, config, logTail, queue, duplicates] = await Promise.all([
        invoke('app:getVersions'),
        invoke('app:getSidecarStatus'),
        invoke('config:get'),
        invoke('log:tail', { limit: 300 }),
        invoke('queue:getSnapshot'),
        invoke('queue:getPendingDuplicates'),
      ]);

      set({
        ready: true,
        versions,
        sidecars: sidecarStatus.sidecars,
        capabilities: sidecarStatus.capabilities,
        config,
        logs: logTail.entries,
        queueItems: new Map(queue.items.map((item) => [item.id, item])),
        queueState: queue.state,
        pendingDuplicates: duplicates.pending,
        bootError: null,
      });

      subscribe('log:entry', (entry) => {
        const next = [...get().logs, entry];
        set({ logs: next.length > MAX_LOG_ENTRIES ? next.slice(next.length - MAX_LOG_ENTRIES) : next });
      });
      subscribe('config:changed', (config) => set({ config }));
      subscribe('sidecars:changed', ({ sidecars, capabilities }) => set({ sidecars, capabilities }));

      subscribe('queue:itemUpdated', (item) => {
        const items = new Map(get().queueItems);
        items.set(item.id, item);
        set({ queueItems: items });
      });
      subscribe('queue:itemsAdded', ({ items: added }) => {
        const items = new Map(get().queueItems);
        for (const item of added) items.set(item.id, item);
        set({ queueItems: items });
      });
      subscribe('queue:itemRemoved', ({ itemId }) => {
        const items = new Map(get().queueItems);
        items.delete(itemId);
        set({ queueItems: items });
      });
      subscribe('queue:state', (queueState) => set({ queueState }));

      subscribe('queue:duplicatePending', (pending) => {
        set({ pendingDuplicates: [...get().pendingDuplicates, pending] });
      });
      subscribe('queue:duplicateResolved', ({ itemId }) => {
        set({ pendingDuplicates: get().pendingDuplicates.filter((p) => p.itemId !== itemId) });
      });

      subscribe('queue:batchComplete', (summary) => {
        set({ lastBatch: summary });
        // Section 10's completion summary, with the retry affordance inline.
        get().pushToast({
          kind: summary.failed > 0 ? 'warning' : 'success',
          message: `${summary.completed} downloaded · ${summary.skipped} skipped · ${summary.failed} failed`,
          ...(summary.failed > 0
            ? {
                action: {
                  label: 'Retry failed',
                  run: () => {
                    void invoke('queue:retryAllFailed');
                  },
                },
              }
            : {}),
        });
      });
    } catch (err) {
      // Allow a retry: a failed bootstrap left nothing subscribed.
      bootstrapped = false;
      set({ ready: true, bootError: err instanceof Error ? err.message : String(err) });
    }
  },

  setDuplicatePromptDismissed(dismissed: boolean): void {
    set({ duplicatePromptDismissed: dismissed });
  },

  async updateConfig(patch: Partial<AppConfig>): Promise<void> {
    const config = await invoke('config:update', patch);
    set({ config });
  },

  pushToast(toast): void {
    const id = ++toastId;
    set({ toasts: [...get().toasts, { ...toast, id }] });
    // Errors stay until dismissed; everything else clears itself.
    if (toast.kind !== 'error') {
      setTimeout(() => get().dismissToast(id), 6_000);
    }
  },

  dismissToast(id: number): void {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },

  async refreshQueue(): Promise<void> {
    const queue = await invoke('queue:getSnapshot');
    set({
      queueItems: new Map(queue.items.map((item) => [item.id, item])),
      queueState: queue.state,
    });
  },
}));

/** Queue rows in processing order. Sorting by position is a hard guarantee. */
export function selectOrderedItems(state: AppState): QueueItemDto[] {
  return [...state.queueItems.values()].sort((a, b) => a.position - b.position);
}
