import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { subdirFor } from '@main/download/pipeline';
import { resolveOutputDirectory } from '@main/download/filename';
import { DEFAULT_CONFIG, type AppConfig } from '@shared/config-schema';
import type { PipelineInput } from '@main/queue/types';

/**
 * A folder per account, for pasted links as well as whole accounts.
 *
 * Queueing an account already filed its videos together; pasting links from
 * three creators dropped them all in one folder. Same job, two shapes on disk,
 * for no reason other than where the link came from.
 */

function input(overrides: {
  outputSubdir?: string | null;
  authorHandle?: string | null;
  normalizedHandle?: string | null;
}): PipelineInput {
  return {
    item: { output_subdir: overrides.outputSubdir ?? null } as PipelineInput['item'],
    normalized: { authorHandle: overrides.normalizedHandle ?? null } as PipelineInput['normalized'],
    resolved: {
      metadata: { authorHandle: overrides.authorHandle ?? null },
    } as PipelineInput['resolved'],
    duplicateAction: null,
    signal: new AbortController().signal,
    onProgress: () => undefined,
  };
}

const config = (patch: Partial<AppConfig> = {}): AppConfig => ({ ...DEFAULT_CONFIG, ...patch });

describe('choosing the folder a download lands in', () => {
  it('uses the account that posted it', () => {
    expect(subdirFor(input({ authorHandle: 'studioatlab' }), config())).toBe('studioatlab');
  });

  it('files three creators into three folders from one paste', () => {
    const handles = ['studioatlab', 'eras.studio', 'mariomaker.store'];
    const folders = handles.map((handle) => subdirFor(input({ authorHandle: handle }), config()));
    expect(folders).toEqual(handles);
    expect(new Set(folders).size).toBe(3);
  });

  it('keeps the folder a whole-account run already chose', () => {
    // A repost stays filed under the account it was queued from: "these came
    // from @creator's profile" is a stronger claim than what the video says
    // about itself.
    expect(subdirFor(input({ outputSubdir: 'creator', authorHandle: 'someone.else' }), config())).toBe('creator');
  });

  it('falls back to the handle in the URL when the extractor named nobody', () => {
    expect(subdirFor(input({ normalizedHandle: 'fromurl' }), config())).toBe('fromurl');
  });

  it('files at the top level rather than inventing an "unknown" folder', () => {
    expect(subdirFor(input({}), config())).toBeNull();
  });

  it('can be turned off', () => {
    expect(subdirFor(input({ authorHandle: 'studioatlab' }), config({ groupByCreator: false }))).toBeNull();
    // Turning it off must not undo a folder the account run asked for.
    expect(subdirFor(input({ outputSubdir: 'creator' }), config({ groupByCreator: false }))).toBe('creator');
  });
});

describe('the handle is remote input, so it goes through the path guard', () => {
  it('cannot escape the output folder', () => {
    const root = mkdtempSync(join(tmpdir(), 'outdir-'));
    try {
      // A TikTok handle cannot contain these, but the value arrives from a
      // network response and is treated as though it could.
      const hostile = subdirFor(input({ authorHandle: '../../Windows/System32' }), config());
      const resolved = resolveOutputDirectory(root, hostile);

      expect(resolved.startsWith(root + sep) || resolved === root).toBe(true);
      expect(resolved).not.toContain('System32' + sep);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('strips separators out of a handle rather than nesting on them', () => {
    const root = mkdtempSync(join(tmpdir(), 'outdir-'));
    try {
      const resolved = resolveOutputDirectory(root, subdirFor(input({ authorHandle: 'a/b\\c' }), config()));
      expect(resolved.startsWith(root + sep)).toBe(true);
      // One level down, not three.
      expect(resolved.slice(root.length + 1).includes(sep)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
