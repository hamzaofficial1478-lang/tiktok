import { describe, expect, it } from 'vitest';
import { renderTemplate } from '@shared/filename-template';
import { DEFAULT_CONFIG } from '@shared/config-schema';
import type { VideoMetadata } from '@main/resolve/types';

/**
 * Filenames that number the whole library, not each paste.
 *
 * Five videos added in two goes came out 001, 002, 003, 001, 002 — the same
 * numbers twice, in a folder meant to read in the order things were added.
 *
 * `{n}` is the ordinal *within a paste*, so it restarts every time: for a new
 * paste, and for every account a creator run visits. `{index}` is allocated
 * from a counter kept in the database and never restarts, which is why it is
 * the default now.
 */

const metadata = { authorHandle: 'creator', caption: 'x', uploadedAt: null, durationMs: null } as VideoMetadata;

function name(template: string, index: number, batchIndex: number): string {
  return renderTemplate(template, { metadata, awemeId: `id${index}`, index, batchIndex, extension: '.mp4' });
}

describe('the numbers in a filename', () => {
  it('reproduces the repeat that {n} caused across two pastes', () => {
    // Paste one: three links. Paste two: two more. `index` keeps climbing
    // because it comes from a persistent counter; `batchIndex` restarts.
    const withN = [
      name('{n:3} - {id}', 1, 1),
      name('{n:3} - {id}', 2, 2),
      name('{n:3} - {id}', 3, 3),
      name('{n:3} - {id}', 4, 1),
      name('{n:3} - {id}', 5, 2),
    ];

    expect(withN.map((f) => f.slice(0, 3))).toEqual(['001', '002', '003', '001', '002']);
  });

  it('numbers continuously with the template that ships now', () => {
    const withIndex = [1, 2, 3, 4, 5].map((i) => name(DEFAULT_CONFIG.filenameTemplate, i, i > 3 ? i - 3 : i));
    expect(withIndex.map((f) => f.slice(0, 3))).toEqual(['001', '002', '003', '004', '005']);
  });

  it('pads so the folder sorts the way it reads', () => {
    // Without padding Explorer sorts 1, 10, 11, 2 — which is the same problem
    // in a different disguise.
    const names = [1, 2, 10, 11].map((i) => name('{index:3} - {id}', i, i));
    expect([...names].sort()).toEqual(names);
  });

  it('keeps climbing past the padding width rather than wrapping', () => {
    expect(name('{index:3} - {id}', 1234, 1)).toMatch(/^1234 /);
  });
});
