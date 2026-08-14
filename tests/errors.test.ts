import { describe, expect, it } from 'vitest';
import {
  AppError,
  ERROR_CODES,
  ERROR_REGISTRY,
  SPEC_ERROR_CODES,
  describeError,
  isAutoRetryable,
  toAppError,
} from '@shared/errors';

describe('error taxonomy (section 11)', () => {
  it('describes every code, with no placeholder text', () => {
    for (const code of ERROR_CODES) {
      const descriptor = describeError(code);
      expect(descriptor.code).toBe(code);
      expect(descriptor.title.length).toBeGreaterThan(0);
      // "says what happened and what the user can do about it"
      expect(descriptor.message.length).toBeGreaterThan(20);
      expect(descriptor.message).not.toMatch(/something went wrong/i);
    }
  });

  it('has no registry entry without a code and vice versa', () => {
    expect(Object.keys(ERROR_REGISTRY).sort()).toEqual([...ERROR_CODES].sort());
  });

  it('covers all 17 codes the brief enumerates, plus the two this app added', () => {
    expect(SPEC_ERROR_CODES).toHaveLength(17);
    expect(ERROR_CODES).toEqual([...SPEC_ERROR_CODES, 'INTERNAL_ERROR', 'CDN_FORBIDDEN']);
    // An internal fault must not masquerade as a user-facing download failure.
    expect(describeError('INTERNAL_ERROR').message).not.toMatch(/link|url|video|download/i);
    expect(describeError('INTERNAL_ERROR').action).toBe('open-logs');
  });

  it('never auto-retries terminal failures — they must not burn the rate budget', () => {
    for (const code of ['VIDEO_DELETED', 'VIDEO_PRIVATE', 'REGION_BLOCKED', 'UNSUPPORTED_MEDIA', 'AGE_RESTRICTED', 'INVALID_URL', 'NOT_A_TIKTOK_URL'] as const) {
      expect(isAutoRetryable(code), code).toBe(false);
      expect(describeError(code).userRetryable, code).toBe(false);
    }
  });

  it('auto-retries exactly the transient failures section 8 lists', () => {
    const autoRetryable = ERROR_CODES.filter(isAutoRetryable).sort();
    expect(autoRetryable).toEqual(
      // CDN_FORBIDDEN retries on purpose: TikTok signs its media URLs and
      // checks a session, and both go stale, so a refusal a fresh link would
      // have fixed used to be terminal and never retried once.
      ['CDN_FORBIDDEN', 'DOWNLOAD_INCOMPLETE', 'NETWORK_ERROR', 'RATE_LIMITED', 'RESOLVE_FAILED', 'VERIFY_FAILED'].sort(),
    );
  });

  it('gives a stale extractor its own actionable state, not a generic network error', () => {
    const descriptor = describeError('EXTRACTOR_FAILED');
    expect(descriptor.action).toBe('update-extractor');
    expect(descriptor.userRetryable).toBe(true);
    // section 2: it must not present as a network problem
    expect(descriptor.message).not.toMatch(/network|connection/i);
  });

  it('offers an action for anything the user can retry, and none for terminal item failures', () => {
    for (const code of ERROR_CODES) {
      if (describeError(code).userRetryable) expect(describeError(code).action, code).not.toBe('none');
    }
    // A terminal *item* failure gets no action button, because none would help.
    // INTERNAL_ERROR is excluded: it is not an item failure, and "open logs"
    // is genuinely the right next step for it.
    for (const code of SPEC_ERROR_CODES) {
      if (!describeError(code).userRetryable) expect(describeError(code).action, code).toBe('none');
    }
    // Anything auto-retryable must also be manually retryable.
    for (const code of ERROR_CODES.filter(isAutoRetryable)) expect(describeError(code).userRetryable, code).toBe(true);
  });
});

describe('AppError', () => {
  it('carries a code and serialises without a stack', () => {
    const error = new AppError('DISK_FULL', '12MB free');
    expect(error.code).toBe('DISK_FULL');
    expect(error.message).toBe(ERROR_REGISTRY.DISK_FULL.message);
    expect(error.toJSON()).toEqual({ code: 'DISK_FULL', message: ERROR_REGISTRY.DISK_FULL.message, detail: '12MB free' });
    expect(Object.keys(error.toJSON())).not.toContain('stack');
  });

  it('omits detail entirely when there is none', () => {
    expect(new AppError('CANCELLED').toJSON()).toEqual({
      code: 'CANCELLED',
      message: ERROR_REGISTRY.CANCELLED.message,
    });
  });

  it('passes an existing AppError through unchanged', () => {
    const original = new AppError('RATE_LIMITED', 'slow down');
    expect(toAppError(original)).toBe(original);
  });

  it('wraps arbitrary throwables, preserving the original text as detail', () => {
    const fromError = toAppError(new RangeError('index out of range'), 'FFMPEG_FAILED');
    expect(fromError.code).toBe('FFMPEG_FAILED');
    expect(fromError.detail).toBe('RangeError: index out of range');
    expect(fromError.cause).toBeInstanceOf(RangeError);

    expect(toAppError('plain string', 'NETWORK_ERROR').detail).toBe('plain string');
    expect(toAppError({ weird: true }, 'NETWORK_ERROR').detail).toBe('{"weird":true}');
  });
});
