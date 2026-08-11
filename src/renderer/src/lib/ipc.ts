import type {
  InvokeChannel,
  InvokeRequest,
  InvokeResponse,
  EventChannel,
  EventPayload,
} from '@shared/ipc/contract';
import { unwrap, type IpcResult } from '@shared/ipc/envelope';
import { describeError, type ErrorCode } from '@shared/errors';

/**
 * The renderer's only route to privileged work. Everything the UI does that
 * touches disk, network or a child process goes through here.
 */
interface ExposedApi {
  invoke<C extends InvokeChannel>(channel: C, payload?: InvokeRequest<C>): Promise<IpcResult<InvokeResponse<C>>>;
  on<C extends EventChannel>(channel: C, listener: (payload: EventPayload<C>) => void): () => void;
  platform: string;
}

declare global {
  interface Window {
    api: ExposedApi;
  }
}

export class IpcError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'IpcError';
  }

  /** Drives the row's action button — retry, update extractor, choose folder… */
  get descriptor() {
    return describeError(this.code);
  }
}

export async function invoke<C extends InvokeChannel>(
  channel: C,
  payload?: InvokeRequest<C>,
): Promise<InvokeResponse<C>> {
  const result = await window.api.invoke(channel, payload);
  if (!result.ok) throw new IpcError(result.error.code, result.error.message, result.error.detail);
  return unwrap(result);
}

export function subscribe<C extends EventChannel>(channel: C, listener: (payload: EventPayload<C>) => void): () => void {
  return window.api.on(channel, listener);
}

export const platform = (): string => window.api.platform;
