import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import { EventBus, IpcRegistry } from '@main/ipc/registry';
import { INVOKE_CHANNELS, EVENT_CHANNELS, invokeContract, eventContract } from '@shared/ipc/contract';
import type { IpcResult } from '@shared/ipc/envelope';
import { unwrap } from '@shared/ipc/envelope';
import { AppError } from '@shared/errors';

const silent = pino({ level: 'silent' });

/**
 * Minimal ipcMain stand-in. The registry only needs `handle`, which keeps this
 * suite Electron-free — the boundary logic is what is under test, not Electron.
 */
function fakeIpcMain(): { ipcMain: IpcMain; call: (channel: string, payload?: unknown) => Promise<IpcResult<unknown>> } {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, payload: unknown) => unknown>();
  const ipcMain = {
    handle(channel: string, listener: (event: IpcMainInvokeEvent, payload: unknown) => unknown) {
      handlers.set(channel, listener);
    },
  } as unknown as IpcMain;

  return {
    ipcMain,
    async call(channel, payload) {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`no handler for ${channel}`);
      return (await handler({} as IpcMainInvokeEvent, payload)) as IpcResult<unknown>;
    },
  };
}

describe('IPC contract', () => {
  it('declares a request and response schema for every invoke channel', () => {
    expect(INVOKE_CHANNELS.length).toBeGreaterThan(0);
    for (const channel of INVOKE_CHANNELS) {
      expect(invokeContract[channel].request).toBeDefined();
      expect(invokeContract[channel].response).toBeDefined();
    }
    for (const channel of EVENT_CHANNELS) expect(eventContract[channel]).toBeDefined();
  });

  /**
   * The preload's allow-list comes from channels.ts while the schemas live in
   * contract.ts. `satisfies` catches drift at compile time; this catches it in
   * CI too, because a mismatch means the preload would silently refuse to
   * forward a channel that main is happily listening on.
   */
  it('keeps the preload allow-list and the schema map in exact agreement', () => {
    expect([...INVOKE_CHANNELS].sort()).toEqual(Object.keys(invokeContract).sort());
    expect([...EVENT_CHANNELS].sort()).toEqual(Object.keys(eventContract).sort());
  });
});

describe('IpcRegistry', () => {
  it('passes a valid payload through to the handler', async () => {
    const { ipcMain, call } = fakeIpcMain();
    const registry = new IpcRegistry(ipcMain, silent);
    registry.handle('log:tail', ({ limit }) => ({ entries: Array.from({ length: limit }, () => tailEntry()) }));

    const result = await call('log:tail', { limit: 2 });
    expect(result.ok).toBe(true);
    expect(unwrap(result as IpcResult<{ entries: unknown[] }>).entries).toHaveLength(2);
  });

  it('rejects a malformed payload before the handler runs', async () => {
    const { ipcMain, call } = fakeIpcMain();
    const registry = new IpcRegistry(ipcMain, silent);
    const handler = vi.fn(() => ({ entries: [] }));
    registry.handle('log:tail', handler);

    // limit must be an integer 1..5000
    for (const bad of [{ limit: 0 }, { limit: 99_999 }, { limit: 'ten' }, {}, undefined, null]) {
      const result = await call('log:tail', bad);
      expect(result.ok, `expected rejection for ${JSON.stringify(bad)}`).toBe(false);
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('converts a thrown AppError into a typed result, never a stack trace', async () => {
    const { ipcMain, call } = fakeIpcMain();
    const registry = new IpcRegistry(ipcMain, silent);
    registry.handle('config:get', () => {
      throw new AppError('DISK_FULL', 'only 12MB free on /out');
    });

    const result = await call('config:get', undefined);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('DISK_FULL');
    expect(result.error.message).toMatch(/not enough free space/i);
    expect(result.error.detail).toBe('only 12MB free on /out');
    expect(JSON.stringify(result)).not.toMatch(/\bat \S+:\d+:\d+/); // no stack frames
  });

  it('converts an unexpected throw into a typed result too', async () => {
    const { ipcMain, call } = fakeIpcMain();
    const registry = new IpcRegistry(ipcMain, silent);
    registry.handle('config:get', () => {
      throw new TypeError('cannot read properties of undefined');
    });

    const result = await call('config:get', undefined);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('INTERNAL_ERROR');
    expect(result.error.detail).toContain('TypeError');
  });

  it('refuses to register the same channel twice', () => {
    const { ipcMain } = fakeIpcMain();
    const registry = new IpcRegistry(ipcMain, silent);
    registry.handle('config:get', () => ({}) as never);
    expect(() => registry.handle('config:get', () => ({}) as never)).toThrow(/already registered/i);
  });
});

describe('EventBus', () => {
  function fakeContents(): { contents: WebContents; sent: [string, unknown][] } {
    const sent: [string, unknown][] = [];
    const contents = {
      send: (channel: string, payload: unknown) => sent.push([channel, payload]),
      isDestroyed: () => false,
      once: () => {},
    } as unknown as WebContents;
    return { contents, sent };
  }

  it('emits validated payloads to every registered window', () => {
    const bus = new EventBus(silent);
    const a = fakeContents();
    const b = fakeContents();
    bus.register(a.contents);
    bus.register(b.contents);

    bus.emit('log:entry', tailEntry());

    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(1);
    expect(a.sent[0]?.[0]).toBe('log:entry');
  });

  it('drops a malformed payload rather than corrupting renderer state', () => {
    const bus = new EventBus(silent);
    const { contents, sent } = fakeContents();
    bus.register(contents);

    bus.emit('log:entry', { level: 'nonsense' } as never);

    expect(sent).toHaveLength(0);
  });
});

function tailEntry() {
  return { time: Date.now(), level: 'info' as const, scope: 'test', msg: 'hello' };
}
