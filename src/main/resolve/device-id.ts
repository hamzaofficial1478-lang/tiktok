import { randomInt } from 'node:crypto';

/**
 * The device identity the mobile-app route presents to TikTok.
 *
 * yt-dlp's TikTok extractor only takes its app-API path when it has been given
 * a device identity — see `_KNOWN_APP_INFO` in yt_dlp/extractor/tiktok.py,
 * which is empty unless `device_id` or `app_info` is supplied, and gates
 * `_extract_aweme_app` on it. Without one, `api_hostname` sets the hostname of
 * an endpoint that is never contacted.
 *
 * The range matches the one yt-dlp itself generates from, so the value looks
 * like the Android install IDs TikTok issues rather than a number a script
 * invented.
 */
const MIN_DEVICE_ID = 7_250_000_000_000_000_000n;
const MAX_DEVICE_ID = 7_325_099_899_999_994_577n;

/**
 * Generated once per installation and then kept.
 *
 * yt-dlp makes a fresh one every run, which is right for a command-line tool
 * that may never be run twice from the same machine. For an app that a person
 * downloads hundreds of videos with, a new device appearing for every request
 * is the pattern of a bot farm; one device that persists is the pattern of a
 * phone. `randomInt` is used rather than `Math.random` so the value cannot be
 * predicted from another install's.
 */
export function generateDeviceId(): string {
  const span = MAX_DEVICE_ID - MIN_DEVICE_ID;
  // randomInt is limited to 2^48, so the range is filled in two draws.
  const high = BigInt(randomInt(0, Number(span / 1_000_000n) + 1)) * 1_000_000n;
  const low = BigInt(randomInt(0, 1_000_000));
  return String(MIN_DEVICE_ID + ((high + low) % (span + 1n)));
}

/** Rejects anything that would not survive as a TikTok device ID. */
export function isValidDeviceId(value: string): boolean {
  if (!/^\d{19}$/.test(value)) return false;
  const parsed = BigInt(value);
  return parsed >= MIN_DEVICE_ID && parsed <= MAX_DEVICE_ID;
}
