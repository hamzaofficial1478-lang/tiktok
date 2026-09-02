import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import pino from 'pino';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { IpcRegistry } from '@main/ipc/registry';
import { registerLibraryHandlers } from '@main/ipc/queue.handlers';
import { runMigrations } from '@main/db/migrator';
import { MIGRATIONS } from '@main/db/migrations';
import { VideosRepository } from '@main/db/repositories/videos';
import { DownloadsRepository } from '@main/db/repositories/downloads';
import { LinkLedgerRepository } from '@main/db/repositories/link-ledger';
import { unwrap } from '@shared/ipc/envelope';
import type { IpcResult } from '@shared/ipc/envelope';
import type { AppServices } from '@main/services';

const silent = pino({ level: 'silent' });

const AWEME = '7311111111111111111';

let db: Database.Database;
let downloads: DownloadsRepository;
let ledger: LinkLedgerRepository;
let call: (channel: string, payload?: unknown) => Promise<IpcResult<unknown>>;

/**
 * The Library's own two buttons, over real repositories.
 *
 * Worth the wiring: the whole defect is a handler quietly doing a second thing
 * beyond what its name and its button say, and the only way to catch that
 * coming back is to press the button.
 */
beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, MIGRATIONS);

  const videos = new VideosRepository(db);
  downloads = new DownloadsRepository(db);
  ledger = new LinkLedgerRepository(db);

  const video = videos.upsert(
    {
      awemeId: AWEME,
      canonicalUrl: `https://www.tiktok.com/@alpha/video/${AWEME}`,
      authorHandle: 'alpha',
      authorName: 'Alpha',
      caption: null,
      durationMs: 12_000,
      coverUrl: null,
      musicTitle: null,
      uploadedAt: null,
    },
    1_700_000_000_000,
  );
  downloads.insert({
    videoId: video.id,
    filePath: '/out/alpha/001 - alpha - ' + AWEME + '.mp4',
    fileSize: 1_000,
    sha256: null,
    phash: null,
    sourceStrategy: 'clean_source',
    watermarkRemoved: true,
    outroTrimmedMs: null,
    completedAt: 1_700_000_000_000,
  });
  ledger.record({ awemeId: AWEME, handle: 'alpha', status: 'downloaded', filePath: '/out/alpha/x.mp4' });

  const handlers = new Map<string, (event: IpcMainInvokeEvent, payload: unknown) => unknown>();
  const ipcMain = {
    handle(channel: string, listener: (event: IpcMainInvokeEvent, payload: unknown) => unknown) {
      handlers.set(channel, listener);
    },
  } as unknown as IpcMain;

  registerLibraryHandlers(new IpcRegistry(ipcMain, silent), {
    log: silent,
    repos: { videos, downloads, linkLedger: ledger },
  } as unknown as AppServices);

  call = async (channel, payload) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return (await handler({} as IpcMainInvokeEvent, payload)) as IpcResult<unknown>;
  };
});

/**
 * Tidying the Library is not a request to download fifty videos again.
 *
 * Both of these used to erase the app's memory of having taken the video, on
 * the reasoning that a history row removed without its ledger entry leaves a
 * link that can never be claimed again. The consequences were the wrong way
 * round: the screen promises "clearing the list forgets the records; it never
 * deletes a video", the toast promises "your video files were not touched", and
 * what actually happened was that the next creator run started again from the
 * top of every account and re-downloaded everything into the folders that
 * already held it.
 */
describe('clearing the Library', () => {
  it('empties the list', async () => {
    expect(unwrap(await call('library:clearRecords'))).toEqual({ removed: 1 });
    expect(downloads.listLibrary({}).total).toBe(0);
  });

  it('does not forget that the video was downloaded', async () => {
    await call('library:clearRecords');

    // The one assertion that matters. This is what a creator run reads to
    // decide whether an account still owes anything.
    expect(ledger.isSettled(AWEME)).toBe(true);
    expect(ledger.countForHandle('alpha', 'downloaded')).toBe(1);
  });

  it('does not forget when a single row is removed either', async () => {
    const [entry] = downloads.listLibrary({}).entries;
    await call('library:deleteRecord', { downloadId: entry?.download_id });

    expect(downloads.listLibrary({}).total).toBe(0);
    expect(ledger.isSettled(AWEME)).toBe(true);
  });
});
