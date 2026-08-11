import { create } from 'zustand';
import type { AppConfig } from '@shared/config-schema';
import type { LogEntry, MediaCapabilities, SidecarStatus, Versions } from '@shared/ipc/contract';
import { invoke, subscribe } from '../lib/ipc';

/**
 * Renderer state.
 *
 * Spec section 3: "the renderer holds a synced read model, never the source of
 * truth." Nothing here computes anything the main process owns — it mirrors
 * what main pushes and forwards user intent back over IPC. When the queue
 * arrives in phase 3, it follows the same rule: rows are a projection of
 * SQLite, not a second copy the UI mutates.
 */
interface AppState {
  ready: boolean;
  versions: Versions | null;
  sidecars: SidecarStatus[];
  capabilities: MediaCapabilities | null;
  config: AppConfig | null;
  logs: LogEntry[];
  error: string | null;

  bootstrap(): Promise<void>;
  updateConfig(patch: Partial<AppConfig>): Promise<void>;
}

/** Matches the main-side ring buffer so the Logs screen cannot grow unbounded. */
const MAX_LOG_ENTRIES = 2_000;

export const useAppStore = create<AppState>((set, get) => ({
  ready: false,
  versions: null,
  sidecars: [],
  capabilities: null,
  config: null,
  logs: [],
  error: null,

  async bootstrap(): Promise<void> {
    try {
      const [versions, sidecarStatus, config, logTail] = await Promise.all([
        invoke('app:getVersions'),
        invoke('app:getSidecarStatus'),
        invoke('config:get'),
        invoke('log:tail', { limit: 200 }),
      ]);

      set({
        ready: true,
        versions,
        sidecars: sidecarStatus.sidecars,
        capabilities: sidecarStatus.capabilities,
        config,
        logs: logTail.entries,
        error: null,
      });

      subscribe('log:entry', (entry) => {
        const next = [...get().logs, entry];
        set({ logs: next.length > MAX_LOG_ENTRIES ? next.slice(next.length - MAX_LOG_ENTRIES) : next });
      });
      subscribe('config:changed', (config) => set({ config }));
      subscribe('sidecars:changed', ({ sidecars, capabilities }) => set({ sidecars, capabilities }));
    } catch (err) {
      set({ ready: true, error: err instanceof Error ? err.message : String(err) });
    }
  },

  async updateConfig(patch: Partial<AppConfig>): Promise<void> {
    const config = await invoke('config:update', patch);
    set({ config });
  },
}));
