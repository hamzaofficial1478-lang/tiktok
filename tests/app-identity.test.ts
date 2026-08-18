import { describe, expect, it } from 'vitest';
import { appInfoArg, appInfoPool, generateInstallId, isValidDeviceId } from '@main/resolve/device-id';
import { appApiFailure, ytDlpStrategies } from '@main/resolve/yt-dlp-extractor';

/**
 * The identity the app route presents to TikTok.
 *
 * Every expectation here is read off yt_dlp/extractor/tiktok.py at the version
 * this app ships (2026.07.04), not guessed. The three lines that decide it:
 *
 *     _APP_INFO_DEFAULTS = {'iid': None, 'app_name': 'musical_ly',
 *                           'app_version': '35.1.3',
 *                           'manifest_app_version': '2023501030', 'aid': '0'}
 *
 *     def _KNOWN_APP_INFO(self):
 *         default = [''] if self._KNOWN_DEVICE_ID else []
 *         return self._configuration_arg('app_info', default, ie_key=TikTokIE)
 *
 *     'iid': self._APP_INFO.get('iid'),      # inside filter_dict()
 *
 * Supplying only `device_id` therefore produced a pool of one empty entry, an
 * app-API request with no install id at all (filter_dict drops the None), and
 * an `aid` of '0' under the name `musical_ly` — an app that does not exist.
 */

const DEVICE_ID = '7300000000000000000';
const INSTALL_ID = '7300000000000000001';

function extractorArgsOf(args: readonly string[]): string {
  const at = args.indexOf('--extractor-args');
  return at === -1 ? '' : (args[at + 1] ?? '');
}

describe('the install id', () => {
  it('looks like the ids TikTok issues, not like a number a script invented', () => {
    for (let i = 0; i < 40; i++) {
      expect(isValidDeviceId(generateInstallId())).toBe(true);
    }
  });

  it('is not the same value as a device id', () => {
    // Two ids that were visibly related would describe a phone that does not
    // exist just as clearly as a missing one does.
    expect(generateInstallId()).not.toBe(generateInstallId());
  });
});

describe('the app_info string', () => {
  it('puts the fields in the order yt-dlp zips them into', () => {
    // yt-dlp splits on '/' and zips positionally against _APP_INFO_DEFAULTS,
    // so a field in the wrong place is accepted and silently wrong.
    expect(
      appInfoArg({
        installId: INSTALL_ID,
        appName: 'musical_ly',
        appVersion: '35.1.3',
        manifestVersion: '2023501030',
        aid: '1233',
      }),
    ).toBe(`${INSTALL_ID}/musical_ly/35.1.3/2023501030/1233`);
  });

  it('gives every entry an install id, which is the whole point', () => {
    for (const entry of appInfoPool(INSTALL_ID)) {
      expect(entry.split('/')[0]).toBe(INSTALL_ID);
    }
  });

  it('pairs each app name with its own id rather than the universal zero', () => {
    const byName = new Map(
      appInfoPool(INSTALL_ID).map((entry) => {
        const parts = entry.split('/');
        return [parts[1], parts[4]];
      }),
    );

    // From the source's own comment: aweme = 1128, trill = 1180,
    // musical_ly = 1233, universal = 0. The default pairs musical_ly with 0.
    expect(byName.get('musical_ly')).toBe('1233');
    expect(byName.get('trill')).toBe('1180');
    expect([...byName.values()]).not.toContain('0');
  });

  it('offers more than one identity, so a failed call has somewhere to go', () => {
    // _call_api pops the next entry out of _APP_INFO_POOL when a response
    // cannot be parsed. A pool of one is not a retry.
    expect(appInfoPool(INSTALL_ID).length).toBeGreaterThan(1);
    expect(new Set(appInfoPool(INSTALL_ID)).size).toBe(appInfoPool(INSTALL_ID).length);
  });

  it('contains no character that would break the extractor-args grammar', () => {
    // `;` separates keys and `,` separates values, so either inside a value
    // would silently truncate the argument.
    for (const entry of appInfoPool(INSTALL_ID)) {
      expect(entry).not.toContain(';');
      expect(entry).not.toContain(',');
      expect(entry).not.toContain(':');
    }
  });
});

describe('the routes', () => {
  it('leads with the app API and keeps the web page as the fallback', () => {
    // The web page is the route that fails with "Unable to extract universal
    // data for rehydration"; leading with it made every video pay TikTok's
    // bot-detection lottery before anything else was tried.
    expect(ytDlpStrategies(DEVICE_ID, INSTALL_ID).map((s) => s.label)).toEqual([
      'mobile app api',
      'mobile app api (alt region)',
      'web',
    ]);
  });

  it('sends device, install and hostname together on the app routes', () => {
    for (const strategy of ytDlpStrategies(DEVICE_ID, INSTALL_ID)) {
      if (strategy.label === 'web') continue;
      const value = extractorArgsOf(strategy.args);

      expect(value).toContain(`device_id=${DEVICE_ID}`);
      expect(value).toContain(`app_info=`);
      expect(value).toContain(INSTALL_ID);
      expect(value).toContain('api_hostname=');
      // One `tiktok:` group with `;` between keys — the grammar yt-dlp parses.
      expect(value).toMatch(/^tiktok:[^:]+$/);
    }
  });

  it('passes the pool as a comma-separated list, which is how yt-dlp reads it', () => {
    const value = extractorArgsOf(ytDlpStrategies(DEVICE_ID, INSTALL_ID)[0]!.args);
    const appInfo = /app_info=([^;]+)/.exec(value)?.[1] ?? '';
    expect(appInfo.split(',')).toEqual(appInfoPool(INSTALL_ID));
  });

  it('still sends an install id when none has been minted yet', () => {
    // Reusing the device id is not ideal, but it is strictly better than the
    // field being dropped from the request entirely.
    const value = extractorArgsOf(ytDlpStrategies(DEVICE_ID)[0]!.args);
    expect(value).toContain(`app_info=${DEVICE_ID}/`);
  });

  it('leaves the web route carrying no identity at all', () => {
    // With neither device_id nor app_info, _KNOWN_APP_INFO is empty and the
    // app branch is skipped entirely — which is what makes this route a
    // genuinely different one rather than a third copy of the first two.
    const web = ytDlpStrategies(DEVICE_ID, INSTALL_ID).find((s) => s.label === 'web');
    expect(web?.args).toEqual([]);
  });

  it('uses different hostnames for the two app routes', () => {
    const [first, second] = ytDlpStrategies(DEVICE_ID, INSTALL_ID);
    expect(extractorArgsOf(first!.args)).not.toBe(extractorArgsOf(second!.args));
  });
});

describe('the app-API failure yt-dlp hides in a warning', () => {
  it('is pulled out of the stderr the web-page error would otherwise own', () => {
    // Exactly the shape _real_extract produces: a warning for the app route,
    // then an ERROR from the page it fell back to.
    const stderr = [
      'WARNING: [TikTok] 7629812183127346446: Unable to extract aweme detail info; trying with webpage',
      'ERROR: [TikTok] 7629812183127346446: Unable to extract universal data for rehydration; please report this issue',
    ].join('\n');

    expect(appApiFailure(stderr)).toBe('[TikTok] 7629812183127346446: Unable to extract aweme detail info');
  });

  it('reports nothing when the app route was never tried', () => {
    // Which is a different situation from it being tried and refused, and the
    // two were previously indistinguishable.
    expect(appApiFailure('ERROR: [TikTok] Unable to extract universal data for rehydration')).toBeNull();
  });

  it('handles the older wording too', () => {
    expect(appApiFailure('WARNING: [TikTok] No working app info is available; falling back to webpage')).toBe(
      '[TikTok] No working app info is available',
    );
  });
});
