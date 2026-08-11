/**
 * Recorded-shape yt-dlp payloads.
 *
 * Field names and format_id conventions mirror yt-dlp's TikTok extractor
 * (play_addr / download_addr / play / download / audio, has_watermark driving
 * format_note and preference). TikTok is unreachable from CI, so these stand in
 * for live responses — and because the watermark decision is made purely from
 * these fields, testing against them tests the real logic, not a mock of it.
 */

export const AWEME_ID = '7123456789012345678';

/** The common case: a clean play_addr alongside the watermarked download_addr. */
export const CLEAN_AND_WATERMARKED = {
  id: AWEME_ID,
  title: 'a caption with #tags and #more',
  description: 'a caption with #tags and #more',
  uploader: 'charlie',
  uploader_id: 'charlie',
  creator: 'Charlie Example',
  duration: 12.4,
  thumbnail: 'https://p16.tiktokcdn.com/cover.jpeg',
  track: 'original sound - charlie',
  artist: 'charlie',
  timestamp: 1_700_000_000,
  upload_date: '20231114',
  view_count: 120_000,
  like_count: 9_400,
  comment_count: 210,
  repost_count: 55,
  formats: [
    {
      format_id: 'download_addr',
      format_note: 'Download video, watermarked',
      url: 'https://v16.tiktokcdn.com/watermarked.mp4',
      ext: 'mp4',
      width: 576,
      height: 1024,
      vcodec: 'h264',
      acodec: 'aac',
      filesize: 2_400_000,
      preference: -2,
    },
    {
      format_id: 'play_addr',
      url: 'https://v16.tiktokcdn.com/clean-1080.mp4',
      ext: 'mp4',
      width: 1080,
      height: 1920,
      fps: 30,
      tbr: 2_400,
      vcodec: 'h264',
      acodec: 'aac',
      filesize: 4_100_000,
    },
    {
      format_id: 'play_addr_bytevc1',
      url: 'https://v16.tiktokcdn.com/clean-h265.mp4',
      ext: 'mp4',
      width: 720,
      height: 1280,
      vcodec: 'h265',
      acodec: 'aac',
    },
    {
      format_id: 'audio',
      url: 'https://v16.tiktokcdn.com/audio.m4a',
      ext: 'm4a',
      vcodec: 'none',
      acodec: 'aac',
      abr: 128,
    },
  ],
};

/** The web-API path uses shorter format IDs for the same distinction. */
export const WEB_API_VARIANT = {
  id: AWEME_ID,
  title: 'from the web api',
  uploader: 'dana',
  duration: 8,
  formats: [
    {
      format_id: 'play',
      url: 'https://v16.tiktokcdn.com/web-clean.mp4',
      ext: 'mp4',
      width: 720,
      height: 1280,
      vcodec: 'h264',
      acodec: 'aac',
    },
    {
      format_id: 'download',
      format_note: 'watermarked',
      url: 'https://v16.tiktokcdn.com/web-watermarked.mp4',
      ext: 'mp4',
      width: 720,
      height: 1280,
      vcodec: 'h264',
      acodec: 'aac',
    },
  ],
};

/** Only a watermarked stream is offered — the fallback path of section 9. */
export const WATERMARKED_ONLY = {
  id: AWEME_ID,
  title: 'only the watermarked variant exists',
  uploader: 'erin',
  duration: 30,
  formats: [
    {
      format_id: 'download_addr',
      format_note: 'Download video, watermarked',
      url: 'https://v16.tiktokcdn.com/only-watermarked.mp4',
      ext: 'mp4',
      width: 576,
      height: 1024,
      vcodec: 'h264',
      acodec: 'aac',
    },
  ],
};

/**
 * A photo slideshow: yt-dlp's source notes these have a video duration of 0
 * and expose only the backing audio.
 */
export const PHOTO_SLIDESHOW = {
  id: '7987654321098765432',
  title: 'a slideshow post',
  uploader: 'frank',
  duration: 0,
  formats: [
    {
      format_id: 'audio',
      url: 'https://v16.tiktokcdn.com/slideshow-audio.mp3',
      ext: 'mp3',
      vcodec: 'none',
      acodec: 'mp3',
    },
  ],
};

/** Legacy single-format response: a top-level url and no `formats` array. */
export const SINGLE_FORMAT = {
  id: AWEME_ID,
  title: 'single format',
  uploader: 'gina',
  duration: 5,
  url: 'https://v16.tiktokcdn.com/single.mp4',
  ext: 'mp4',
};

export const NO_FORMATS = {
  id: AWEME_ID,
  title: 'nothing downloadable',
  uploader: 'henry',
  duration: 15,
  formats: [],
};

/** Metadata missing almost everything — the extractor must not throw on nulls. */
export const SPARSE_METADATA = {
  id: AWEME_ID,
  formats: [
    {
      format_id: 'play_addr',
      url: 'https://v16.tiktokcdn.com/sparse.mp4',
      vcodec: 'h264',
      acodec: 'aac',
    },
  ],
};

/** Real stderr text, for the error classifier. */
export const STDERR_SAMPLES = {
  privatePost: 'ERROR: [TikTok] 7123456789012345678: Video not available, status code 10216',
  privateAccount: 'ERROR: [TikTok] 7123456789012345678: Video not available, status code 10222',
  ipBlocked: 'ERROR: [TikTok] 7123456789012345678: Your IP address is blocked from accessing this post',
  deleted: 'ERROR: [TikTok] 7123456789012345678: Unable to download webpage: HTTP Error 404: Not Found',
  removed: 'ERROR: [TikTok] Video has been removed by the author',
  geoBlocked: 'ERROR: [TikTok] This video is not available in your country',
  ageGated: 'ERROR: [TikTok] Sign in to confirm your age',
  rateLimited: 'ERROR: [TikTok] Unable to download API page: HTTP Error 429: Too Many Requests',
  extractorBroken: 'ERROR: [TikTok] 7123456789012345678: Unable to extract aweme detail info',
  jsChallenge: 'ERROR: [TikTok] Unable to solve JS challenge',
  serverError: 'ERROR: [TikTok] Unable to download webpage: HTTP Error 503: Service Unavailable',
  timeout: 'ERROR: unable to download video data: The read operation timed out',
  dnsFailure: 'ERROR: [TikTok] Unable to download webpage: <urlopen error [Errno -3] Temporary failure in name resolution>',
  connectionReset: 'ERROR: unable to download video data: [Errno 104] ECONNRESET Connection reset by peer',
  unknown: 'ERROR: something nobody has seen before happened',
};
