import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { buildPaths } from './paths';
import { createServices, type AppServices } from './services';
import { EventBus, IpcRegistry } from './ipc/registry';
import { registerAppEvents, registerAppHandlers } from './ipc/app.handlers';

/**
 * The Electron shell — the only file in the main process that imports
 * `electron`. Everything it drives lives in services.ts and is testable
 * without a window.
 */

const isDev = !app.isPackaged;
let services: AppServices | null = null;
let eventBus: EventBus | null = null;

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
    registerAppEvents(eventBus, services);

    const window = createWindow();
    eventBus.register(window.webContents);

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
    const pending = services;
    services = null;
    if (pending) void pending.shutdown();
  });
}
