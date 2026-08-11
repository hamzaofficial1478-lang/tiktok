import { contextBridge, ipcRenderer } from 'electron';
// Value import from channels.ts only — importing the contract would pull zod
// into a sandboxed preload, which cannot require from node_modules. The type
// imports below are erased at build time and cost nothing.
import { INVOKE_CHANNELS, EVENT_CHANNELS, type InvokeChannel, type EventChannel } from '@shared/ipc/channels';
import type { InvokeRequest, InvokeResponse, EventPayload } from '@shared/ipc/contract';
import type { IpcResult } from '@shared/ipc/envelope';

/**
 * The only bridge between renderer and main.
 *
 * Two deliberate restrictions, both of which are what make section 13's later
 * licensing/hardening work tractable rather than a rewrite:
 *
 *  - Channel names are checked against the contract's allow-list at call time.
 *    Even if renderer code is tampered with, it cannot reach an arbitrary
 *    ipcRenderer channel — there is no generic `send` exposed.
 *  - No Node primitive is exposed. The renderer gets two functions and a
 *    platform string; it cannot read the filesystem, spawn a process, or make
 *    a network request (section 4).
 */
const invokeAllowed = new Set<string>(INVOKE_CHANNELS);
const eventAllowed = new Set<string>(EVENT_CHANNELS);

const api = {
  invoke<C extends InvokeChannel>(channel: C, payload?: InvokeRequest<C>): Promise<IpcResult<InvokeResponse<C>>> {
    if (!invokeAllowed.has(channel)) {
      return Promise.resolve({
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: 'Unsupported operation.', detail: `unknown channel: ${channel}` },
      });
    }
    return ipcRenderer.invoke(channel, payload) as Promise<IpcResult<InvokeResponse<C>>>;
  },

  on<C extends EventChannel>(channel: C, listener: (payload: EventPayload<C>) => void): () => void {
    if (!eventAllowed.has(channel)) return () => {};
    const wrapped = (_event: unknown, payload: EventPayload<C>): void => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },

  platform: process.platform,
};

export type RendererApi = typeof api;

contextBridge.exposeInMainWorld('api', api);
