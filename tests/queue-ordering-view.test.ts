import { describe, expect, it } from 'vitest';
import { orderedItems } from '@renderer/store/app-store';
import type { QueueItemDto } from '@shared/ipc/contract';

/**
 * The renderer's projection of the queue.
 *
 * Two separate guarantees are under test. The first is ordering: rows render in
 * `position` order, never insertion or id order, so what the user sees matches
 * what the engine will actually do (section 8).
 *
 * The second is the reason this is a plain function rather than a zustand
 * selector. It builds a new array on every call, and zustand v5 compares
 * snapshots by reference — handing this straight to `useAppStore()` made React
 * see a changed snapshot on every render and blew the whole window away with a
 * render loop, not merely a stale list. Callers subscribe to the Map (stable
 * between store writes) and call this inside `useMemo`.
 */

function item(id: number, position: number): QueueItemDto {
  return {
    id,
    position,
    batchId: 'b1',
    rawUrl: `https://www.tiktok.com/@a/video/${id}`,
    canonicalUrl: null,
    awemeId: null,
    status: 'queued',
    progress: 0,
    bytesDone: null,
    bytesTotal: null,
    attemptCount: 0,
    errorCode: null,
    errorDetail: null,
    duplicateAction: null,
    createdAt: 0,
    startedAt: null,
    finishedAt: null,
    sourceStrategy: null,
    watermarkRemoved: null,
  };
}

describe('orderedItems', () => {
  it('sorts by position regardless of insertion or id order', () => {
    // Insertion order and id order both disagree with position order here, so
    // only a real sort on position produces the right answer.
    const map = new Map([
      [30, item(30, 2)],
      [10, item(10, 5)],
      [20, item(20, 1)],
    ]);

    expect(orderedItems(map).map((i) => i.position)).toEqual([1, 2, 5]);
    expect(orderedItems(map).map((i) => i.id)).toEqual([20, 30, 10]);
  });

  it('returns a fresh array each call, which is why it is not a selector', () => {
    const map = new Map([[1, item(1, 1)]]);

    // Documents the exact property that made this unsafe as a zustand
    // selector: identical contents, different reference every time.
    expect(orderedItems(map)).not.toBe(orderedItems(map));
    expect(orderedItems(map)).toEqual(orderedItems(map));
  });

  it('handles an empty queue', () => {
    expect(orderedItems(new Map())).toEqual([]);
  });
});
