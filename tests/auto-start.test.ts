import { describe, expect, it } from 'vitest';
import {
  applyStartOnLogin,
  AUTOSTART_FLAG,
  loginItemTarget,
  startedByLogin,
  type LoginItemHost,
} from '@main/system/auto-start';

/**
 * Starting with the machine.
 *
 * The queue already resumes exactly where a power cut left it — but only once
 * something starts the app, and until now that something was a person
 * remembering to.
 */

/** Records what was registered, and answers reads from it, like the real one. */
function fakeHost(overrides: { refuse?: boolean; throws?: string } = {}): LoginItemHost & {
  readonly calls: { openAtLogin: boolean; path?: string; args?: string[]; name?: string }[];
} {
  const calls: { openAtLogin: boolean; path?: string; args?: string[]; name?: string }[] = [];
  let registered = false;

  return {
    calls,
    setLoginItemSettings(settings): void {
      if (overrides.throws) throw new Error(overrides.throws);
      calls.push(settings);
      // A machine under policy accepts the call and does nothing.
      if (!overrides.refuse) registered = settings.openAtLogin;
    },
    getLoginItemSettings(): { openAtLogin: boolean } {
      return { openAtLogin: registered };
    },
  };
}

const packaged = { isPackaged: true, execPath: 'C:/Apps/TikTok/TikTok.exe', appPath: 'C:/Apps/TikTok/resources/app' };
const fromSource = {
  isPackaged: false,
  execPath: 'C:/Users/me/tiktok/node_modules/electron/dist/electron.exe',
  appPath: 'C:/Users/me/tiktok',
};

describe('what gets registered', () => {
  it('runs the app itself when packaged', () => {
    expect(loginItemTarget(packaged)).toEqual({ path: packaged.execPath, args: [AUTOSTART_FLAG] });
  });

  it('tells Electron which app to run when running from source', () => {
    // Without the project path, Electron starts and shows its own default
    // window every morning — a failure that looks like the app being broken
    // rather than like a missing argument.
    expect(loginItemTarget(fromSource)).toEqual({
      path: fromSource.execPath,
      args: [fromSource.appPath, AUTOSTART_FLAG],
    });
  });

  it('marks the launch so the app knows to come up out of the way', () => {
    expect(startedByLogin(['electron.exe', 'C:/app', AUTOSTART_FLAG])).toBe(true);
    expect(startedByLogin(['electron.exe', 'C:/app'])).toBe(false);
  });
});

describe('turning it on and off', () => {
  it('registers, and names the entry so it is recognisable in Task Manager', () => {
    const host = fakeHost();
    expect(applyStartOnLogin(true, host, packaged, 'win32')).toEqual({ applied: true });
    expect(host.calls[0]).toMatchObject({ openAtLogin: true, name: 'TikTok Downloader' });
  });

  it('removes it again', () => {
    const host = fakeHost();
    applyStartOnLogin(true, host, packaged, 'win32');
    expect(applyStartOnLogin(false, host, packaged, 'win32')).toEqual({ applied: true });
    expect(host.calls[1]?.openAtLogin).toBe(false);
  });

  it('reports a refusal instead of claiming success', () => {
    // Group policy and some security software accept the call and do nothing.
    // A switch that says "on" while nothing was registered is a bug the user
    // discovers weeks later, when a morning goes by and the queue has not moved.
    const result = applyStartOnLogin(true, fakeHost({ refuse: true }), packaged, 'win32');
    expect(result.applied).toBe(false);
    expect(result.reason).toMatch(/policy/i);
  });

  it('reports a thrown error rather than letting it escape', () => {
    const result = applyStartOnLogin(true, fakeHost({ throws: 'access denied' }), packaged, 'win32');
    expect(result).toEqual({ applied: false, reason: 'access denied' });
  });

  it('says plainly that Linux is not supported rather than pretending', () => {
    const host = fakeHost();
    const result = applyStartOnLogin(true, host, packaged, 'linux');

    expect(result.applied).toBe(false);
    expect(result.reason).toMatch(/not supported/i);
    // And it does not write a .desktop file whose behaviour depends on which
    // desktop environment happens to be installed.
    expect(host.calls).toHaveLength(0);
  });

  it('works on macOS', () => {
    expect(applyStartOnLogin(true, fakeHost(), packaged, 'darwin').applied).toBe(true);
  });
});
