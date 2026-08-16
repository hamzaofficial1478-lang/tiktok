import { AppError } from '@shared/errors';
import type { AppServices } from '../services';
import type { EventBus, IpcRegistry } from './registry';

/**
 * Phase-1 handlers. Each one is a thin adapter over a service — no business
 * logic lives at the IPC layer, so the same operations remain callable from a
 * CLI harness without an Electron window.
 */
export function registerAppHandlers(registry: IpcRegistry, services: AppServices, appVersion: string): void {
  registry.handle('app:getVersions', () => {
    const { sidecars } = services.getSidecarStatus();
    return {
      app: appVersion,
      electron: process.versions['electron'] ?? 'n/a',
      chrome: process.versions['chrome'] ?? 'n/a',
      node: process.versions.node,
      ffmpeg: sidecars.find((s) => s.name === 'ffmpeg')?.version ?? null,
      ytDlp: sidecars.find((s) => s.name === 'yt-dlp')?.version ?? null,
    };
  });

  registry.handle('app:getSidecarStatus', () => services.getSidecarStatus());

  registry.handle('app:whisperStatus', () => {
    const status = services.whisperInstaller.status();
    return { installed: status.binaryPath !== null && status.modelPath !== null, model: status.modelId };
  });

  registry.handle('app:installWhisper', async ({ model }) => {
    try {
      const status = await services.whisperInstaller.install(model ?? 'base.en');
      return {
        installed: status.binaryPath !== null && status.modelPath !== null,
        model: status.modelId,
        message: `Transcriber ready (${status.modelId ?? 'unknown model'}).`,
      };
    } catch (err) {
      // Reported rather than thrown: this is a long optional install, and the
      // reason it failed is more useful on screen than an error boundary.
      return { installed: false, model: null, message: err instanceof Error ? err.message : String(err) };
    }
  });

  registry.handle('config:get', () => services.config.get());

  registry.handle('config:update', (patch) => {
    try {
      return services.config.update(patch);
    } catch (err) {
      // ConfigStore throws on schema violations; surface it as a typed error
      // rather than letting a zod message reach the UI verbatim.
      throw new AppError('PERMISSION_DENIED', err instanceof Error ? err.message : String(err));
    }
  });

  registry.handle('log:tail', ({ limit }) => ({ entries: services.logging.tail(limit) }));
}

/** Wires service-side changes to renderer push events (section 4). */
export function registerAppEvents(bus: EventBus, services: AppServices): () => void {
  const unsubscribeLog = services.logging.subscribe((entry) => bus.emit('log:entry', entry));
  const unsubscribeConfig = services.config.subscribe((config) => bus.emit('config:changed', config));
  return () => {
    unsubscribeLog();
    unsubscribeConfig();
  };
}
