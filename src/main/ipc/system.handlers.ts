import { resolve, sep } from 'node:path';
import { dialog, session, shell, type BrowserWindow } from 'electron';
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

  /**
   * Both of these hand a path to the operating system, and `shell.openPath` in
   * particular will *launch* what it is given — on Windows an .exe or .bat runs
   * rather than opening. An arbitrary path arriving over IPC is therefore an
   * execution primitive, so it is checked against what this app actually
   * produced instead of being trusted because the renderer is our own code.
   */
  const assertOurFile = (candidate: string): string => {
    const resolved = resolve(candidate);

    // Either the app downloaded it, or it sits under the folder the app was
    // told to download into. Nothing else is openable.
    if (services.repos.downloads.existsByFilePath(resolved)) return resolved;

    const outputDir = services.config.get().outputDir;
    if (outputDir !== '') {
      const root = resolve(outputDir);
      if (resolved === root || resolved.startsWith(root + sep)) return resolved;
    }

    services.log.warn({ path: resolved }, 'refused to open a path outside the download folder');
    throw new AppError('PERMISSION_DENIED', 'that file is not one this app downloaded');
  };

  registry.handle('system:showInFolder', ({ path }) => {
    shell.showItemInFolder(assertOurFile(path));
    return { ok: true as const };
  });

  registry.handle('system:openPath', async ({ path }) => {
    const safe = assertOurFile(path);
    const error = await shell.openPath(safe);
    if (error) throw new AppError('PERMISSION_DENIED', `could not open ${safe}: ${error}`);
    return { ok: true as const };
  });

  /**
   * "Test proxy" — answers the only question that matters about a proxy
   * setting: does TikTok actually come back through it?
   *
   * A syntactic check on the URL is close to worthless here; a typo'd port and
   * a dead SOCKS server both parse perfectly and both fail silently later, as a
   * pile of network errors on individual videos. So this makes a real request
   * to TikTok through a throwaway session configured with exactly this proxy,
   * and reports what came back.
   *
   * The session is partitioned and short-lived so testing a proxy never
   * disturbs the one the app is really using, and a rejected proxy leaves no
   * trace in the app's own networking.
   */
  registry.handle('system:testProxy', async ({ proxyUrl }) => {
    const trimmed = proxyUrl.trim();
    if (trimmed === '') {
      return { ok: false, message: 'No proxy is set, so nothing was tested.', latencyMs: null };
    }

    const partition = `proxy-test-${Date.now()}`;
    const testSession = session.fromPartition(partition, { cache: false });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    const startedAt = Date.now();

    try {
      // proxyRules takes host:port style rules; the scheme is honoured for
      // socks5:// and http(s)://, which is exactly what the config allows.
      await testSession.setProxy({ proxyRules: trimmed });

      // Session.fetch, not net.fetch: only the session-scoped call routes
      // through the proxy configured above.
      const response = await testSession.fetch('https://www.tiktok.com/', {
        method: 'HEAD',
        signal: controller.signal,
        // A redirect still proves the proxy carried the request there.
        redirect: 'manual',
      });

      const latencyMs = Date.now() - startedAt;

      if (response.status >= 500) {
        return {
          ok: false,
          message: `The proxy connected but TikTok replied ${response.status}. The proxy may be blocked.`,
          latencyMs,
        };
      }
      if (response.status === 403) {
        return {
          ok: false,
          message: 'The proxy works, but TikTok refused it (403). Try a proxy in a different country.',
          latencyMs,
        };
      }

      return {
        ok: true,
        message: `Reached TikTok through the proxy in ${latencyMs} ms (HTTP ${response.status}).`,
        latencyMs,
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const aborted = controller.signal.aborted;
      services.log.warn({ err: detail }, 'proxy test failed');
      return {
        ok: false,
        message: aborted
          ? 'Timed out after 12s. The proxy is unreachable, or too slow to be usable.'
          : `Could not connect through the proxy: ${detail}`,
        latencyMs: null,
      };
    } finally {
      clearTimeout(timeout);
      // Leaving a configured session around would keep the proxy alive for any
      // later request that happened to pick this partition.
      try {
        await testSession.closeAllConnections();
        await testSession.clearStorageData();
      } catch {
        // Best effort; the partition is discarded either way.
      }
    }
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
