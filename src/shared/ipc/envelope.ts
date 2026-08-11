import type { SerializedError } from './contract';

/**
 * Every IPC response is one of these. Errors cross the boundary as data, never
 * as a rejected promise carrying a stack trace, because Electron serialises a
 * thrown error into an opaque "Error invoking remote method" string that
 * section 11 explicitly forbids showing a user.
 */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: SerializedError };

export function isOk<T>(result: IpcResult<T>): result is { ok: true; data: T } {
  return result.ok;
}

/** Unwraps a result, throwing the typed error. Used by the renderer's client. */
export function unwrap<T>(result: IpcResult<T>): T {
  if (result.ok) return result.data;
  const err = new Error(result.error.message) as Error & { code: string; detail?: string };
  err.code = result.error.code;
  if (result.error.detail !== undefined) err.detail = result.error.detail;
  throw err;
}
