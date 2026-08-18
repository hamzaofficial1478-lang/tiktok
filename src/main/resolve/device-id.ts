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

/**
 * The install identity, which is the other half and was missing entirely.
 *
 * Reading `_build_api_query` in yt_dlp/extractor/tiktok.py settles what a
 * request to TikTok's app API actually carries:
 *
 *     'iid': self._APP_INFO.get('iid'),
 *     'device_id': self._DEVICE_ID,
 *     'openudid': ''.join(random.choices('0123456789abcdef', k=16)),
 *
 * — all three wrapped in `filter_dict`, which drops anything falsy. Supplying
 * only `device_id` leaves `iid` as None, so `filter_dict` removes it and the
 * request goes out with a device that has no install behind it. A real phone
 * never does that.
 *
 * The install id has to arrive through `app_info` rather than an argument of
 * its own, because that is the only channel yt-dlp offers for it:
 *
 *     _APP_INFO_DEFAULTS = { 'iid': None, 'app_name': …, 'app_version': …,
 *                            'manifest_app_version': …, 'aid': '0' }
 *
 * and `app_info` is parsed by zipping those keys against a `/`-separated
 * string. Hence the shape built by `appInfoArg` below.
 */
export function generateInstallId(): string {
  // Same range as the device id: both are Snowflake-style ids issued by the
  // same service, and one that looked different would stand out from it.
  return generateDeviceId();
}

/**
 * One `app_info` entry: `iid/app_name/app_version/manifest_app_version/aid`.
 *
 * The field order is `_APP_INFO_DEFAULTS`' own, because yt-dlp splits on `/`
 * and zips positionally against those keys — a field in the wrong place is
 * silently accepted and quietly wrong.
 *
 * `aid` matters more than it looks. Its default is `'0'`, commented in the
 * source as "universal", while the app names carry their own ids — musical_ly
 * is 1233, trill is 1180. Sending `app_name=musical_ly` with `aid=0` describes
 * an app that does not exist, and it is the combination the default produces.
 */
export function appInfoArg(input: {
  readonly installId: string;
  readonly appName: 'musical_ly' | 'trill';
  readonly appVersion: string;
  readonly manifestVersion: string;
  readonly aid: string;
}): string {
  return [input.installId, input.appName, input.appVersion, input.manifestVersion, input.aid].join('/');
}

/**
 * The identities the app route may present, in order.
 *
 * More than one on purpose. `_call_api` pops the next entry out of
 * `_APP_INFO_POOL` when a request comes back unparseable, so a pool of two is
 * the difference between one attempt and a genuine retry with a different
 * identity — and with no `app_info` supplied at all, `_KNOWN_APP_INFO` is
 * `['']`, a pool of exactly one empty entry, which is where the single
 * iid-less attempt came from.
 *
 * musical_ly is TikTok everywhere except a handful of Asian markets; trill is
 * those markets. Offering both means a video that one app build will not serve
 * gets asked for by the other.
 */
export function appInfoPool(installId: string): readonly string[] {
  return [
    appInfoArg({
      installId,
      appName: 'musical_ly',
      appVersion: '35.1.3',
      manifestVersion: '2023501030',
      aid: '1233',
    }),
    appInfoArg({
      installId,
      appName: 'trill',
      appVersion: '34.1.2',
      manifestVersion: '2023401020',
      aid: '1180',
    }),
  ];
}
