import { describe, expect, it } from 'vitest';
import { generateDeviceId, isValidDeviceId } from '@main/resolve/device-id';

/**
 * The device identity that switches yt-dlp's mobile-app route on.
 *
 * Without a valid one the app route is never taken — `_KNOWN_APP_INFO` is
 * empty, `_extract_aweme_app` is skipped, and every "alternative" route falls
 * back to the same web scrape as the default. So the shape of this value is
 * the difference between having fallbacks and only appearing to.
 */
describe('the device identity', () => {
  it('generates a value TikTok would accept as an install ID', () => {
    for (let i = 0; i < 200; i++) {
      expect(isValidDeviceId(generateDeviceId())).toBe(true);
    }
  });

  it('does not hand every install the same identity', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateDeviceId()));
    // A shared constant would be a fingerprint every user of this app carries.
    expect(seen.size).toBeGreaterThan(190);
  });

  it('rejects anything that is not one', () => {
    // An empty config field is the "not generated yet" state, not a value.
    expect(isValidDeviceId('')).toBe(false);
    expect(isValidDeviceId('12345')).toBe(false);
    expect(isValidDeviceId('72500000000000000000')).toBe(false);
    expect(isValidDeviceId('1000000000000000000')).toBe(false);
    expect(isValidDeviceId('7300000000000000abc')).toBe(false);
  });
});
