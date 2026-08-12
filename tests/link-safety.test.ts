import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIMITS,
  hostSkeleton,
  isLookalikeHost,
  scanText,
  screenLine,
  suspiciousCount,
  type RejectedLine,
} from '@shared/link-safety';

/**
 * Screening for bulk-imported links.
 *
 * The cases below are the actual attack shapes, written out literally, because
 * a spoofed host that reads as TikTok is the one failure here with a real
 * consequence: the user believes they queued a TikTok video and did not.
 */

function reasonOf(line: string): string {
  const result = screenLine(line, 1);
  return 'parsed' in result ? 'accepted' : result.reason;
}

describe('lookalike host detection', () => {
  it('accepts the genuine article and its subdomains', () => {
    expect(isLookalikeHost('tiktok.com')).toBe(false);
    expect(isLookalikeHost('www.tiktok.com')).toBe(false);
    expect(isLookalikeHost('vm.tiktok.com')).toBe(false);
    expect(isLookalikeHost('m.tiktok.com')).toBe(false);
  });

  it.each([
    ['tiktok.com.evil.net', 'suffix attack'],
    ['eviltiktok.com', 'prefix attack'],
    ['tikt0k.com', 'zero for o'],
    ['t1ktok.com', 'one for i'],
    ['tik-tok.com', 'hyphen split'],
    ['tik.tok.com.co', 'dot split'],
    ['tiktok-com.net', 'hyphenated TLD'],
    ['ti\u043Atok.com', 'Cyrillic ka'],
    ['tikt\u043Ek.com', 'Cyrillic o'],
  ])('flags %s (%s)', (host) => {
    expect(isLookalikeHost(host)).toBe(true);
  });

  it('flags punycode hostnames as homograph attempts', () => {
    expect(isLookalikeHost('xn--tiktk-8we.com')).toBe(true);
  });

  it('does not flag ordinary unrelated hosts', () => {
    expect(isLookalikeHost('youtube.com')).toBe(false);
    expect(isLookalikeHost('example.org')).toBe(false);
  });

  it('folds homoglyphs and separators to a comparable skeleton', () => {
    expect(hostSkeleton('tikt0k.com')).toBe('tiktokcom');
    expect(hostSkeleton('tik-tok.com')).toBe('tiktokcom');
    expect(hostSkeleton('TIKTOK.COM')).toBe('tiktokcom');
  });
});

describe('screenLine', () => {
  it('accepts a normal video link', () => {
    expect(reasonOf('https://www.tiktok.com/@creator/video/7123456789012345678')).toBe('accepted');
  });

  it('accepts a short link for later resolution', () => {
    expect(reasonOf('https://vm.tiktok.com/ZMabcdef/')).toBe('accepted');
  });

  it('reports a disguised host as deception, not as a typo', () => {
    // The whole point: this must not come back as the same bland
    // "not a TikTok URL" that a YouTube link produces.
    expect(reasonOf('https://tiktok.com.evil.net/@a/video/7123456789012345678')).toBe('lookalike_host');
    expect(reasonOf('https://youtube.com/watch?v=abc')).toBe('not_tiktok');
  });

  it('rejects credentials embedded in the URL', () => {
    expect(reasonOf('https://evil.example.com:pass@tiktok.com/@a/video/7123456789012345678')).toBe(
      'embedded_credentials',
    );
  });

  it('rejects non-web schemes', () => {
    expect(reasonOf('javascript:alert(1)')).toBe('unsafe_scheme');
    expect(reasonOf('file:///C:/Windows/System32/config')).toBe('unsafe_scheme');
    expect(reasonOf('data:text/html,<script>x</script>')).toBe('unsafe_scheme');
  });

  it('rejects invisible characters used to disguise an address', () => {
    // U+202E reverses how the rest of the line renders.
    expect(reasonOf('https://tiktok.com/\u202E@a/video/7123456789012345678')).toBe('hidden_characters');
    expect(reasonOf('https://tiktok\u200B.com/@a/video/7123456789012345678')).toBe('hidden_characters');
  });

  it('rejects an absurdly long line without trying to parse it', () => {
    expect(reasonOf(`https://tiktok.com/${'a'.repeat(DEFAULT_LIMITS.maxLineLength)}`)).toBe('oversized_line');
  });

  it('tells a TikTok page apart from a TikTok video', () => {
    expect(reasonOf('https://www.tiktok.com/@creator')).toBe('no_video_id');
    expect(reasonOf('https://www.tiktok.com/tag/funny')).toBe('no_video_id');
  });

  it('reports prose as not a link', () => {
    expect(reasonOf('check out this video I found')).toBe('not_a_link');
  });
});

describe('scanText', () => {
  it('counts what it found, kept and rejected', () => {
    const report = scanText(
      [
        'https://www.tiktok.com/@a/video/7123456789012345678',
        'https://www.tiktok.com/@b/video/7223456789012345678',
        'https://www.tiktok.com/@a/video/7123456789012345678', // duplicate
        'https://tiktok.com.evil.net/@c/video/7323456789012345678',
        'https://youtube.com/watch?v=abc',
        'just some text',
      ].join('\n'),
    );

    expect(report.totalLines).toBe(6);
    expect(report.accepted).toHaveLength(2);
    expect(report.counts.duplicate).toBe(1);
    expect(report.counts.lookalike_host).toBe(1);
    expect(report.counts.not_tiktok).toBe(1);
    expect(report.counts.not_a_link).toBe(1);
    expect(suspiciousCount(report)).toBe(1);
  });

  it('deduplicates the same video reached by different URL forms', () => {
    const report = scanText(
      [
        'https://www.tiktok.com/@a/video/7123456789012345678',
        'https://m.tiktok.com/v/7123456789012345678.html',
        'tiktok.com/@a/video/7123456789012345678?is_from_webapp=1',
      ].join('\n'),
    );

    // One video, three spellings — the ID is the key, never the URL string.
    expect(report.accepted).toHaveLength(1);
    expect(report.counts.duplicate).toBe(2);
  });

  it('refuses a binary file outright rather than parsing noise', () => {
    const report = scanText('https://www.tiktok.com/@a/video/7123456789012345678\n\u0000\u0001binary');
    expect(report.fatal).toMatch(/not a text file/i);
    expect(report.accepted).toEqual([]);
  });

  it('refuses a file over the size limit', () => {
    const report = scanText('x'.repeat(DEFAULT_LIMITS.maxBytes + 1));
    expect(report.fatal).toMatch(/over the/i);
  });

  it('caps the number of lines and says so', () => {
    const text = Array.from(
      { length: DEFAULT_LIMITS.maxLines + 10 },
      (_, i) => `https://www.tiktok.com/@a/video/${7_000_000_000_000_000_000n + BigInt(i)}`,
    ).join('\n');

    const report = scanText(text);
    expect(report.truncated).toBe(true);
    expect(report.totalLines).toBe(DEFAULT_LIMITS.maxLines);
  });

  it('handles CSV commas and blank lines', () => {
    const report = scanText(
      'https://www.tiktok.com/@a/video/7123456789012345678,https://www.tiktok.com/@b/video/7223456789012345678\n\n\n',
    );
    expect(report.accepted).toHaveLength(2);
  });

  it('keeps the line number so the user can find the bad row', () => {
    const report = scanText(
      ['https://www.tiktok.com/@a/video/7123456789012345678', 'https://tiktok.com.evil.net/x'].join('\n'),
    );
    const bad = report.rejected[0] as RejectedLine;
    expect(bad.lineNumber).toBe(2);
  });

  it('is empty and calm for empty input', () => {
    const report = scanText('');
    expect(report.totalLines).toBe(0);
    expect(report.accepted).toEqual([]);
    expect(report.fatal).toBeNull();
  });
});
