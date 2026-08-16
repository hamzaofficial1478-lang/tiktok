import { afterEach, describe, expect, it, vi } from 'vitest';
import { awemeIdFor, createHarness, type Harness } from './helpers/queue-fixtures';

/**
 * Photo slideshows — asked about once, and remembered.
 *
 * These used to fail with "no video streams were offered", which reads like a
 * broken app rather than a post that is a set of pictures. Two things have to
 * be true for the fix to be worth anything: the question must not stop the
 * batch, and the answer must stick.
 */

let harness: Harness;

afterEach(async () => {
  await harness?.engine.stop();
  harness?.close();
});

const photoUrl = (index: number): string => `https://www.tiktok.com/@user/photo/${awemeIdFor(index)}`;
const videoUrl = (index: number): string => `https://www.tiktok.com/@user${index}/video/${awemeIdFor(index)}`;

describe('the slideshow question', () => {
  it('parks the slideshow and keeps downloading everything else', async () => {
    harness = createHarness();
    harness.engine.addLinks([videoUrl(1), photoUrl(9), videoUrl(2)]);
    harness.engine.start();
    await harness.engine.whenIdle();

    // The whole point: a question in the middle of a batch is not a stop.
    expect(harness.pipeline.processed).toEqual([awemeIdFor(1), awemeIdFor(2)]);
    expect(harness.engine.getPendingPhotoPosts()).toHaveLength(1);
    expect(harness.engine.getPendingPhotoPosts()[0]?.awemeId).toBe(awemeIdFor(9));
  });

  it('writes a declined slideshow to the ledger so it is never raised again', async () => {
    harness = createHarness();
    harness.engine.addLinks([photoUrl(9)]);
    harness.engine.start();
    await harness.engine.whenIdle();

    const [pending] = harness.engine.getPendingPhotoPosts();
    expect(pending).toBeDefined();
    harness.engine.resolvePhotoPost(pending!.itemId, 'skip');

    expect(harness.engine.getSnapshot()[0]?.status).toBe('skipped');
    expect(harness.ledger.find(awemeIdFor(9))?.status).toBe('declined');
    // Settled, so an account listing passes over it rather than offering it.
    expect(harness.ledger.isSettled(awemeIdFor(9))).toBe(true);
  });

  it('downloads the images when the user says yes', async () => {
    harness = createHarness();
    harness.engine.addLinks([photoUrl(9)]);
    harness.engine.start();
    await harness.engine.whenIdle();

    const [pending] = harness.engine.getPendingPhotoPosts();
    harness.engine.resolvePhotoPost(pending!.itemId, 'download');

    await vi.waitFor(() => expect(harness.engine.getSnapshot()[0]?.status).toBe('completed'));
    expect(harness.pipeline.processed).toEqual([awemeIdFor(9)]);
    // A taken slideshow is downloaded, not declined.
    expect(harness.ledger.find(awemeIdFor(9))?.status).toBe('downloaded');
  });

  it('does not ask twice about the same post once it has been answered', async () => {
    harness = createHarness();
    harness.engine.addLinks([photoUrl(9)]);
    harness.engine.start();
    await harness.engine.whenIdle();

    const [pending] = harness.engine.getPendingPhotoPosts();
    harness.engine.resolvePhotoPost(pending!.itemId, 'download');
    await vi.waitFor(() => expect(harness.engine.getSnapshot()[0]?.status).toBe('completed'));

    // Requeued deliberately: the decision is remembered for the item, so the
    // second pass downloads rather than parking again.
    expect(harness.engine.getPendingPhotoPosts()).toHaveLength(0);
  });

  it('applies one answer to every slideshow in the batch', async () => {
    harness = createHarness();
    harness.engine.addLinks([photoUrl(7), photoUrl(8), photoUrl(9)], 'batch-a');
    harness.engine.start();
    await harness.engine.whenIdle();

    expect(harness.engine.getPendingPhotoPosts()).toHaveLength(3);

    const [first] = harness.engine.getPendingPhotoPosts();
    harness.engine.resolvePhotoPost(first!.itemId, 'skip', true);

    expect(harness.engine.getPendingPhotoPosts()).toHaveLength(0);
    for (const index of [7, 8, 9]) {
      expect(harness.ledger.find(awemeIdFor(index))?.status).toBe('declined');
    }
  });

  it('takes them all without asking when the setting says download', async () => {
    harness = createHarness({ config: { photoSlideshows: 'download' } });
    harness.engine.addLinks([photoUrl(9)]);
    harness.engine.start();
    await harness.engine.whenIdle();

    expect(harness.engine.getPendingPhotoPosts()).toHaveLength(0);
    expect(harness.engine.getSnapshot()[0]?.status).toBe('completed');
  });

  it('refuses a question about an item that never asked one', () => {
    harness = createHarness();
    // The user-facing message is the taxonomy's; the specific cause is on the
    // error's detail, which is what reaches the log.
    expect(() => harness.engine.resolvePhotoPost(999, 'skip')).toThrow(
      expect.objectContaining({ code: 'INTERNAL_ERROR', detail: expect.stringMatching(/no pending photo decision/i) }),
    );
  });
});
