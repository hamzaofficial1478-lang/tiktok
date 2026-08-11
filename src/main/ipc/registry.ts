import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import type { Logger } from 'pino';
import {
  invokeContract,
  eventContract,
  type InvokeChannel,
  type InvokeRequest,
  type InvokeResponse,
  type EventChannel,
  type EventPayload,
} from '@shared/ipc/contract';
import type { IpcResult } from '@shared/ipc/envelope';
import { toAppError } from '@shared/errors';

/**
 * The privileged boundary (spec section 4).
 *
 * Everything a renderer can trigger passes through here, and three things
 * happen to it on the way:
 *
 *  1. The request payload is parsed against the channel's zod schema. A
 *     malformed payload is rejected before the handler runs, so handlers never
 *     defensively re-check their own arguments.
 *  2. Any throw is converted to a typed AppError. A raw stack trace cannot
 *     reach the renderer (section 11).
 *  3. Failures are logged with the channel name, which is what makes a support
 *     log readable.
 *
 * Only channels declared in the contract are registered; registering an
 * unknown one is a compile error, and calling one is a no-op the preload
 * bridge refuses to forward.
 */
export type InvokeHandler<C extends InvokeChannel> = (
  payload: InvokeRequest<C>,
  event: IpcMainInvokeEvent,
) => Promise<InvokeResponse<C>> | InvokeResponse<C>;

export class IpcRegistry {
  private readonly registered = new Set<InvokeChannel>();

  constructor(
    private readonly ipcMain: IpcMain,
    private readonly log: Logger,
  ) {}

  handle<C extends InvokeChannel>(channel: C, handler: InvokeHandler<C>): void {
    if (this.registered.has(channel)) throw new Error(`IPC channel already registered: ${channel}`);
    this.registered.add(channel);

    this.ipcMain.handle(channel, async (event, rawPayload: unknown): Promise<IpcResult<InvokeResponse<C>>> => {
      const parsed = invokeContract[channel].request.safeParse(rawPayload);
      if (!parsed.success) {
        const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
        this.log.warn({ channel, detail }, 'rejected IPC call with invalid payload');
        return {
          ok: false,
          error: { code: 'INTERNAL_ERROR', message: `Invalid request for ${channel}.`, detail },
        };
      }

      try {
        const data = await handler(parsed.data as InvokeRequest<C>, event);
        return { ok: true, data };
      } catch (err) {
        const appError = toAppError(err, 'INTERNAL_ERROR');
        this.log.error({ channel, code: appError.code, detail: appError.detail }, 'IPC handler failed');
        return { ok: false, error: appError.toJSON() };
      }
    });
  }

  get registeredChannels(): InvokeChannel[] {
    return [...this.registered];
  }
}

/**
 * Main -> renderer push events (section 4: "never as polling").
 *
 * Payloads are validated on the way out too. It costs microseconds and it
 * means a bug in main cannot put a malformed object into renderer state, where
 * it would surface as an unrelated React crash much later.
 */
export class EventBus {
  private readonly targets = new Set<WebContents>();

  constructor(private readonly log: Logger) {}

  register(contents: WebContents): void {
    this.targets.add(contents);
    contents.once('destroyed', () => this.targets.delete(contents));
  }

  emit<C extends EventChannel>(channel: C, payload: EventPayload<C>): void {
    const parsed = eventContract[channel].safeParse(payload);
    if (!parsed.success) {
      this.log.error({ channel, issues: parsed.error.issues.length }, 'refused to emit malformed IPC event');
      return;
    }
    for (const contents of this.targets) {
      if (contents.isDestroyed()) {
        this.targets.delete(contents);
        continue;
      }
      contents.send(channel, parsed.data);
    }
  }
}
