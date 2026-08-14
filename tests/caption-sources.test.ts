import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTracks, pickTrack, subtitleLanguages } from '@main/captions/tiktok-tracks';
import { renderSidecar, sidecarPathFor } from '@main/metadata/sidecar';
import { generateSeo } from '@main/metadata/seo';
import type { VideoMetadata } from '@main/resolve/types';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'caps-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('asking TikTok for the right languages', () => {
  it('puts the spoken language first when no translation was asked for', () => {
    // Captioning a Spanish video in English because English sorted first is
    // not what "same language as the video" means.
    expect(subtitleLanguages('auto').split(',')[0]).toBe('orig');
  });

  it('puts the target first when one was chosen, keeping the original as a fallback', () => {
    const langs = subtitleLanguages('en').split(',');
    expect(langs[0]).toBe('en.*');
    expect(langs).toContain('orig');
  });
});

describe('finding the tracks a download wrote', () => {
  function track(name: string): void {
    writeFileSync(join(dir, name), '1\n00:00:01,000 --> 00:00:02,000\nhola\n');
  }

  it('matches the tracks belonging to this video and ignores others', () => {
    const media = join(dir, 'video.mp4.download');
    track('video.mp4.es-orig.srt');
    track('video.mp4.en.srt');
    track('someone-else.mp4.en.srt');
    track('video.mp4.download');

    const found = findTracks(media).map((t) => t.language).sort();
    expect(found).toEqual(['en', 'es-orig']);
  });

  it('returns nothing rather than throwing when the folder is gone', () => {
    expect(findTracks(join(dir, 'missing', 'video.mp4'))).toEqual([]);
  });
});

describe('choosing which track to use', () => {
  const es = { path: '/a.srt', language: 'es-orig', format: 'srt' as const };
  const en = { path: '/b.srt', language: 'en', format: 'srt' as const };
  const ptBr = { path: '/c.srt', language: 'pt-br', format: 'srt' as const };

  it('prefers the spoken language when no target was set', () => {
    expect(pickTrack([en, es], 'auto')?.track).toBe(es);
  });

  it('prefers the target language when one was set', () => {
    expect(pickTrack([es, en], 'en')?.track).toBe(en);
  });

  it('accepts a regional variant of the target', () => {
    const picked = pickTrack([ptBr], 'pt');
    expect(picked?.track).toBe(ptBr);
    expect(picked?.matchesTarget).toBe(true);
  });

  /**
   * The case that decides whether transcription runs. Burning Spanish onto a
   * video where English was asked for looks exactly like the setting being
   * ignored, so the mismatch is reported rather than swallowed.
   */
  it('reports when the only track is the wrong language', () => {
    const picked = pickTrack([es], 'en');
    expect(picked?.track).toBe(es);
    expect(picked?.matchesTarget).toBe(false);
  });

  it('has nothing to say about no tracks', () => {
    expect(pickTrack([], 'en')).toBeNull();
  });
});

describe('the sidecar file', () => {
  const metadata = {
    awemeId: '7123456789012345678',
    authorHandle: 'creator',
    authorName: 'Creator',
    caption: 'three guitar mistakes #guitar',
    durationMs: 30_000,
    coverUrl: null,
    musicTitle: null,
    uploadedAt: null,
    hashtags: ['guitar'],
    isPhotoPost: false,
    stats: { views: null, likes: null, comments: null, shares: null },
  } satisfies VideoMetadata;

  it('sits beside the video under the same name', () => {
    expect(sidecarPathFor('/out/001 - creator - 7123.mp4')).toBe('/out/001 - creator - 7123.txt');
    expect(sidecarPathFor('/out/noext')).toBe('/out/noext.txt');
  });

  it('states what it was written from, rather than implying it read the video', () => {
    const thin = renderSidecar(
      generateSeo({ cues: [], caption: null, hashtags: ['guitar'], authorHandle: 'creator', durationMs: 30_000 }),
      metadata,
    );
    expect(thin).toContain('there was little to work from');

    const rich = renderSidecar(
      generateSeo({
        cues: [
          { startMs: 0, endMs: 3_000, lines: ['The three guitar mistakes that wreck your timing every time'] },
          { startMs: 3_000, endMs: 6_000, lines: ['Start with a metronome before you play anything else at all'] },
        ],
        caption: metadata.caption,
        hashtags: metadata.hashtags,
        authorHandle: 'creator',
        durationMs: 30_000,
      }),
      metadata,
    );
    expect(rich).toContain('what is said in the video');
  });

  it('lists the checks a title failed, so the fix is obvious', () => {
    const weak = renderSidecar(
      generateSeo({ cues: [], caption: 'the thing', hashtags: [], authorHandle: 'creator', durationMs: 5_000 }),
      metadata,
    );
    expect(weak).toContain('SEO score:');
    expect(weak).toContain('Worth a look before posting:');
  });
});
