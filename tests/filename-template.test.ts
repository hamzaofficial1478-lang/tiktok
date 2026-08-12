import { describe, expect, it } from 'vitest';
import { renderTemplate } from '@shared/filename-template';

/**
 * Sequential output filenames.
 *
 * The requirement is that the output folder reads in the order the links were
 * pasted. That is not satisfied by a number alone — it needs a zero-padded one,
 * because file managers sort names as text, so 10 lands between 1 and 2.
 */

describe('sequential filenames', () => {
  const base = {
    awemeId: '7123456789012345678',
    extension: '.mp4',
    metadata: {
      awemeId: '7123456789012345678',
      authorHandle: 'creator',
      authorName: 'Creator',
      caption: 'a caption',
      durationMs: 12_000,
      coverUrl: null,
      musicTitle: null,
      uploadedAt: Date.UTC(2026, 0, 2),
      hashtags: [],
      isPhotoPost: false,
      stats: { views: null, likes: null, comments: null, shares: null },
    },
  };

  it('zero-pads so a folder sorts the way it was numbered', () => {
    const names = [1, 2, 10, 11].map((n) =>
      renderTemplate('{n:3} - {author}', { ...base, index: n, batchIndex: n }),
    );

    expect(names).toEqual(['001 - creator', '002 - creator', '010 - creator', '011 - creator']);
    // The property that matters: lexical order equals numeric order.
    expect([...names].sort()).toEqual(names);
  });

  it('without padding, lexical order breaks — which is why the default pads', () => {
    const names = [1, 2, 10].map((n) => renderTemplate('{n} - {author}', { ...base, index: n, batchIndex: n }));
    expect([...names].sort()).not.toEqual(names);
  });

  it('{n} counts within the paste and {index} across all of them', () => {
    const context = { ...base, index: 304, batchIndex: 4 };
    expect(renderTemplate('{n:3}', context)).toBe('004');
    expect(renderTemplate('{index:4}', context)).toBe('0304');
  });

  it('falls back to the global position for rows enqueued before batch ordinals existed', () => {
    expect(renderTemplate('{n:3}', { ...base, index: 42, batchIndex: null })).toBe('042');
  });
});
