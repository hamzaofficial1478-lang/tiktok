import { dialog, shell, type BrowserWindow } from 'electron';
import { AppError } from '@shared/errors';
import type { AppServices } from '../services';
import type { IpcRegistry } from './registry';

/**
 * Handlers that need Electron itself — folder pickers, revealing files, and
 * the extractor update of section 2.
 *
 * These are the only handlers that import electron, which is why they live
 * apart from the queue and library ones: everything else stays testable
 * without a window.
 */
export function registerSystemHandlers(
  registry: IpcRegistry,
  services: AppServices,
  getWindow: () => BrowserWindow | null,
): void {
  registry.handle('system:chooseFolder', async () => {
    const window = getWindow();
    const result = await (window
      ? dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] })
      : dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] }));

    return { path: result.canceled ? null : (result.filePaths[0] ?? null) };
  });

  registry.handle('system:showInFolder', ({ path }) => {
    shell.showItemInFolder(path);
    return { ok: true as const };
  });

  registry.handle('system:openPath', async ({ path }) => {
    const error = await shell.openPath(path);
    if (error) throw new AppError('PERMISSION_DENIED', `could not open ${path}: ${error}`);
    return { ok: true as const };
  });

  /**
   * "Update extractor" — section 2 requires this to be one click, because a
   * stale extractor is the single most likely cause of a support ticket.
   *
   * Runs the same fetch script the build uses, then re-probes so the Settings
   * screen reflects the new version without a restart.
   */
  registry.handle('app:updateExtractor', async () => {
    const before = services.getSidecarStatus().sidecars.find((s) => s.name === 'yt-dlp')?.version ?? null;

    const { spawn } = await import('node:child_process');
    const scriptPath = new URL('../../scripts/fetch-sidecars.mjs', import.meta.url).pathname;

    const exitCode = await new Promise<number>((resolve) => {
      const child = spawn(process.execPath, [scriptPath, '--only=yt-dlp'], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        windowsHide: true,
      });
      child.on('error', () => resolve(-1));
      child.on('close', (code) => resolve(code ?? -1));
    });

    if (exitCode !== 0) {
      throw new AppError(
        'EXTRACTOR_FAILED',
        'the extractor could not be updated. Check the network connection and the Logs screen.',
      );
    }

    const refreshed = await services.refreshSidecars();
    const after = refreshed.sidecars.find((s) => s.name === 'yt-dlp')?.version ?? null;

    return {
      version: after,
      updated: after !== before,
      message: after === before ? 'The extractor is already up to date.' : `Updated the extractor to ${after ?? '?'}.`,
    };
  });
}
