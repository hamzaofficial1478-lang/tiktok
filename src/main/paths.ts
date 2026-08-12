import { join } from 'node:path';

/**
 * Every filesystem location the app uses, resolved once and passed explicitly.
 *
 * This interface is why the db, config, logging and sidecar modules can be
 * unit tested in a plain Node process: none of them call `app.getPath()`, they
 * receive an AppPaths. The Electron-flavoured construction lives in
 * main/index.ts and nowhere else.
 */
export interface AppPaths {
  /** Per-user writable root (Electron's `userData`). */
  readonly userData: string;
  /** Rolling log files. */
  readonly logs: string;
  /** SQLite database file. */
  readonly database: string;
  /** AppConfig JSON file. */
  readonly configFile: string;
  /**
   * Root containing `bin/<platform>-<arch>/…` sidecars. In development this is
   * the repo's `resources/`; when packaged it is `process.resourcesPath`.
   */
  readonly resources: string;
  /**
   * Where downloads go until the user picks somewhere else.
   *
   * A blank output folder on first run means the very first download fails
   * with "no output folder has been chosen yet" — a bad way to meet a new
   * product. This gives it somewhere sensible to land immediately.
   */
  readonly defaultOutputDir: string;
}

export function buildPaths(userData: string, resources: string, videosDir?: string): AppPaths {
  return {
    userData,
    resources,
    defaultOutputDir: join(videosDir ?? userData, 'TikTok Downloads'),
    logs: join(userData, 'logs'),
    database: join(userData, 'library.db'),
    configFile: join(userData, 'config.json'),
  };
}
