/**
 * Starting with the machine.
 *
 * The point is not convenience. A queue of two hundred videos interrupted by a
 * power cut resumes exactly where it stopped — but only once something starts
 * the app, and until now that something was a person remembering to. Starting
 * at login is what turns "it survives a crash" into "you do not have to notice
 * there was one".
 *
 * ## Why it does not point at the launcher script
 *
 * `Run TikTok Downloader.bat` pulls the newest code and rebuilds before
 * starting, which is right when a person double-clicks it and wrong at boot:
 * it adds twenty seconds and a console window to every startup, and — the part
 * that matters — a failed pull or a broken build means the app does not come
 * up at all. The whole reason to start at login is that an unattended machine
 * gets back to work on its own, so the boot path is the one that cannot depend
 * on the network.
 *
 * The extractor still updates itself on launch, which is the update that
 * decides whether downloads work. Code updates stay with the launcher, where a
 * person is watching.
 */

export interface LoginItemTarget {
  /** The executable Windows should run at login. */
  readonly path: string;
  readonly args: readonly string[];
}

/**
 * The flag that tells a launched app it was started by the system rather than
 * by a person, so it can come up out of the way.
 */
export const AUTOSTART_FLAG = '--autostart';

export interface LoginItemInput {
  readonly isPackaged: boolean;
  /** `process.execPath` — the app itself when packaged, Electron when not. */
  readonly execPath: string;
  /** `app.getAppPath()`; only needed for an unpackaged run. */
  readonly appPath: string;
}

/**
 * What to register, which differs entirely between an installed app and a
 * checkout being run from source.
 *
 * Packaged, `execPath` *is* the app and needs no argument beyond the flag.
 * Unpackaged, `execPath` is Electron itself, which will show its default
 * welcome window unless it is told which app to run — so the project directory
 * has to travel with it. Getting this wrong does not fail loudly; it silently
 * registers something that opens the wrong window every morning.
 */
export function loginItemTarget(input: LoginItemInput): LoginItemTarget {
  return input.isPackaged
    ? { path: input.execPath, args: [AUTOSTART_FLAG] }
    : { path: input.execPath, args: [input.appPath, AUTOSTART_FLAG] };
}

/** True when this process was started by the system at login. */
export function startedByLogin(argv: readonly string[] = process.argv): boolean {
  return argv.includes(AUTOSTART_FLAG);
}

/**
 * The subset of Electron's `app` this needs, so the logic above can be tested
 * without an Electron process.
 */
export interface LoginItemHost {
  getLoginItemSettings(options?: { path?: string; args?: string[] }): { openAtLogin: boolean };
  setLoginItemSettings(settings: {
    openAtLogin: boolean;
    path?: string;
    args?: string[];
    name?: string;
  }): void;
}

export interface ApplyResult {
  readonly applied: boolean;
  /** Present when the platform cannot do this, or the call was refused. */
  readonly reason?: string;
}

/**
 * Registers or removes the login item.
 *
 * Linux is excluded rather than attempted: Electron's implementation there
 * writes a .desktop file whose behaviour depends on the desktop environment,
 * and reporting "done" for something that may quietly not happen is worse than
 * saying it is unsupported.
 */
export function applyStartOnLogin(
  enabled: boolean,
  host: LoginItemHost,
  input: LoginItemInput,
  platform: NodeJS.Platform = process.platform,
): ApplyResult {
  if (platform !== 'win32' && platform !== 'darwin') {
    return { applied: false, reason: `starting at login is not supported on ${platform}` };
  }

  const target = loginItemTarget(input);

  try {
    host.setLoginItemSettings({
      openAtLogin: enabled,
      path: target.path,
      args: [...target.args],
      // Named so the entry is recognisable in Task Manager's Startup tab
      // rather than appearing as a bare "electron".
      name: 'TikTok Downloader',
    });
  } catch (err) {
    return { applied: false, reason: err instanceof Error ? err.message : String(err) };
  }

  /**
   * Read it back rather than trusting the write.
   *
   * Group policy, a locked-down profile and some security software all silently
   * refuse this. Confirming means the Settings toggle reflects what the system
   * actually did — a switch that says "on" while nothing was registered is a
   * bug the user only discovers weeks later, when a morning goes by and the
   * queue has not moved.
   */
  const actual = host.getLoginItemSettings({ path: target.path, args: [...target.args] }).openAtLogin;
  return actual === enabled
    ? { applied: true }
    : { applied: false, reason: 'the system did not accept the change; it may be blocked by policy' };
}
