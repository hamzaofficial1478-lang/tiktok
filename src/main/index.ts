import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, powerMonitor, powerSaveBlocker, shell } from 'electron';
import { buildPaths } from './paths';
import { createServices, type AppServices } from './services';
import { EventBus, IpcRegistry } from './ipc/registry';
import { registerAppEvents, registerAppHandlers } from './ipc/app.handlers';
import { registerLibraryHandlers, registerQueueEvents, registerQueueHandlers } from './ipc/queue.handlers';
import { registerSystemHandlers } from './ipc/system.handlers';

/**
 * The Electron shell — the only file in the main process that imports
 * `electron`. Everything it drives lives in services.ts and is testable
 * without a window.
 */

const isDev = !app.isPackaged;
let services: AppServices | null = null;
let eventBus: EventBus | null = null;
let powerBlockerId: number | null = null;

/**
 * Keeps the machine awake while there is work to do.
 *
 * 'prevent-app-suspension' is the right level, not 'prevent-display-sleep':
 * the screen is allowed to turn off exactly as the user expects, but the
 * system will not suspend underneath a running batch. It is released the
 * moment the queue goes idle, so an idle app never holds the machine awake.
 *
 * Worth being precise about the limit: this prevents *automatic* sleep. A lid
 * close or an explicit sleep command still suspends the machine — no
 * application can override that. The suspend/resume handling below covers
 * that case instead, by parking in-flight downloads and continuing on wake.
 */
function updatePowerBlocker(active: boolean, log?: AppServices['log']): void {
  if (active && powerBlockerId === null) {
    powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    log?.info('holding the system awake while the queue runs');
    return;
  }
  if (!active && powerBlockerId !== null) {
    if (powerSaveBlocker.isStarted(powerBlockerId)) powerSaveBlocker.stop(powerBlockerId);
    powerBlockerId = null;
    log?.info('queue idle; released the sleep blocker');
  }
}

function resolveResourcesRoot(): string {
  // Packaged: resources/bin/… sits beside the asar. Dev: the repo's resources/.
  return app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources');
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1_280,
    height: 840,
    minWidth: 940,
    minHeight: 620,
    show: false,
    backgroundColor: '#0a0a12',
    // Frameless chrome is what the section 10 "layered surfaces" direction
    // needs; a custom title bar arrives with the UI shell in phase 6.
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      /**
       * Chromium throttles timers and rendering in windows that are hidden,
       * minimised, or on a display that has gone to sleep. The queue runs in
       * the main process and is unaffected, but progress updates and the
       * completion toast would arrive in a stutter once the screen turned off.
       * Turning throttling off keeps the UI honest while the machine is idle.
       */
      backgroundThrottling: false,
    },
  });

  // Avoid the white flash before React paints against a near-black UI.
  window.once('ready-to-show', () => window.show());

  // The renderer must never navigate itself or open windows; any external link
  // goes to the system browser instead.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    const devServer = process.env['ELECTRON_RENDERER_URL'];
    if (devServer && url.startsWith(devServer)) return;
    event.preventDefault();
    void shell.openExternal(url);
  });

  const devServerUrl = process.env['ELECTRON_RENDERER_URL'];
  if (isDev && devServerUrl) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return window;
}

// A second instance would open a second SQLite writer against the same library.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [existing] = BrowserWindow.getAllWindows();
    if (existing) {
      if (existing.isMinimized()) existing.restore();
      existing.focus();
    }
  });

  void app.whenReady().then(async () => {
    const paths = buildPaths(app.getPath('userData'), resolveResourcesRoot());
    services = await createServices({ paths, isDev, appVersion: app.getVersion() });

    const registry = new IpcRegistry(ipcMain, services.logging.log.child({ scope: 'ipc' }));
    eventBus = new EventBus(services.logging.log.child({ scope: 'ipc' }));
    registerAppHandlers(registry, services, app.getVersion());
    registerQueueHandlers(registry, services);
    registerLibraryHandlers(registry, services);
    registerAppEvents(eventBus, services);
    registerQueueEvents(eventBus, services);

    const window = createWindow();
    eventBus.register(window.webContents);
    registerSystemHandlers(registry, services, () => BrowserWindow.getAllWindows()[0] ?? null);

    const engine = services.queue;
    const queueLog = services.log;

    // Hold the machine awake exactly while the queue has work, and release it
    // as soon as it does not.
    engine.subscribe((event) => {
      if (event.type === 'queue-state' || event.type === 'batch-complete' || event.type === 'items-added') {
        updatePowerBlocker(engine.isRunning && !engine.isPaused && engine.hasPendingWork(), queueLog);
      }
    });
    updatePowerBlocker(engine.isRunning && engine.hasPendingWork(), queueLog);

    /**
     * A forced sleep is the one case the blocker cannot prevent. In-flight
     * sockets do not survive it, so downloads are parked back into the queue
     * (keeping their .part files) rather than left hanging on dead
     * connections until a timeout eventually fires.
     */
    powerMonitor.on('suspend', () => {
      void engine.suspend();
    });
    powerMonitor.on('resume', () => {
      engine.resumeFromSuspend();
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        const next = createWindow();
        eventBus?.register(next.webContents);
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // Flush the database and log file before exit so a clean quit never needs
  // crash recovery on the next start.
  app.on('before-quit', () => {
    updatePowerBlocker(false);
    const pending = services;
    services = null;
    if (pending) void pending.shutdown();
  });
}
