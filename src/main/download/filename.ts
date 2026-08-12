import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { VideoMetadata } from '../resolve/types';

/**
 * Filename templating — spec sections 9 step 9 and 10 (Settings).
 *
 * Tokens: {author} {id} {date} {caption:N} {index}
 *
 * Sanitisation targets Windows because Windows is target platform #1 and its
 * rules are the strict superset: characters macOS allows happily (`:` `?` `*`)
 * make a file uncreatable there, a trailing dot or space is silently stripped
 * by the shell, and names like CON or NUL are reserved device names no
 * extension can rescue. Getting this wrong produces a batch that downloads
 * fine and then fails to save, which reads to the user as data loss.
 */

/**
 * Characters Windows forbids outright, plus C0 control characters.
 * Spaces and hyphens are deliberately kept: they are the separators most
 * templates are built from.
 */
const ILLEGAL_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;

/** Reserved device names, with or without an extension. */
const RESERVED_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

/** Leaves room for a " (12)" collision suffix and the extension. */
const MAX_BASENAME_LENGTH = 180;

export interface TemplateContext {
  readonly metadata: VideoMetadata;
  readonly awemeId: string;
  /** 1-based position within the batch, for {index}. */
  readonly index: number;
  readonly extension: string;
}

/**
 * Replaces every character that cannot appear in a filename.
 *
 * Emoji and non-Latin scripts are deliberately preserved — TikTok captions are
 * full of both, and stripping them would turn most filenames into noise.
 */
export function sanitizeSegment(value: string): string {
  const cleaned = value
    .replace(ILLEGAL_CHARS, '')
    // Collapse whitespace so a multi-line caption does not become a multi-line
    // filename.
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned;
}

/** Applies the whole-name rules that only make sense once the name is assembled. */
export function sanitizeBasename(value: string): string {
  let name = sanitizeSegment(value);

  // Windows silently drops trailing dots and spaces, so a name ending in one
  // resolves to a different file than the one we recorded in the database.
  name = name.replace(/[. ]+$/, '');

  if (name.length > MAX_BASENAME_LENGTH) name = name.slice(0, MAX_BASENAME_LENGTH).replace(/[. ]+$/, '');

  const withoutExtension = name.split('.')[0] ?? name;
  if (RESERVED_NAMES.has(withoutExtension.toUpperCase())) name = `_${name}`;

  // An empty name is unusable; the caller always has an ID to fall back on.
  return name === '' ? 'untitled' : name;
}

function formatDate(epochMs: number | null): string {
  const date = epochMs === null ? new Date() : new Date(epochMs);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/**
 * Renders a template to a basename (no extension, no directory).
 *
 * Unknown tokens are left untouched rather than blanked, so a typo in Settings
 * is visible in the preview instead of silently producing a shorter name.
 */
export function renderTemplate(template: string, context: TemplateContext): string {
  const { metadata } = context;

  const rendered = template.replace(/\{(\w+)(?::(\d+))?\}/g, (match, token: string, limit?: string) => {
    const max = limit ? Number(limit) : undefined;

    switch (token) {
      case 'author':
        return sanitizeSegment(metadata.authorHandle ?? 'unknown');
      case 'authorName':
        return sanitizeSegment(metadata.authorName ?? metadata.authorHandle ?? 'unknown');
      case 'id':
        return context.awemeId;
      case 'date':
        return formatDate(metadata.uploadedAt);
      case 'caption': {
        const caption = sanitizeSegment(metadata.caption ?? '');
        if (caption === '') return '';
        return max !== undefined && caption.length > max ? caption.slice(0, max).trim() : caption;
      }
      case 'index':
        return String(context.index);
      case 'duration':
        return metadata.durationMs === null ? '' : `${Math.round(metadata.durationMs / 1_000)}s`;
      default:
        return match;
    }
  });

  // A template like "{author} - {caption:40}" leaves a dangling separator when
  // the caption is empty; tidy those rather than shipping "creator - .mp4".
  const tidied = rendered
    .replace(/\s*[-–—_]\s*(?=$|\s*[-–—_])/g, ' ')
    .replace(/\s*[-–—_]\s*$/, '')
    .replace(/^\s*[-–—_]\s*/, '')
    .replace(/\[\s*\]|\(\s*\)/g, '');

  return sanitizeBasename(tidied);
}

export interface ResolvePathOptions {
  readonly directory: string;
  readonly basename: string;
  readonly extension: string;
  /**
   * 'replace' overwrites the existing file (dedup layer 3's Replace);
   * 'suffix' finds the next free "(n)" (Download again, and ordinary
   * collisions between different videos with the same rendered name).
   */
  readonly onCollision: 'replace' | 'suffix';
  readonly exists?: (path: string) => boolean;
}

/**
 * Produces the final absolute path, resolving collisions.
 *
 * The `.part` file lives alongside it and is renamed here only after
 * verification, which is what guarantees section 8's rule that no output file
 * ever exists in a truncated state under its final name.
 */
export function resolveOutputPath(options: ResolvePathOptions): string {
  const exists = options.exists ?? existsSync;
  const extension = options.extension.startsWith('.') ? options.extension : `.${options.extension}`;
  const first = join(options.directory, `${options.basename}${extension}`);

  if (options.onCollision === 'replace' || !exists(first)) return first;

  for (let n = 2; n < 10_000; n++) {
    const candidate = join(options.directory, `${options.basename} (${n})${extension}`);
    if (!exists(candidate)) return candidate;
  }

  // Effectively unreachable; better than looping forever.
  return join(options.directory, `${options.basename} (${Date.now()})${extension}`);
}

/** The Settings screen's live preview (section 10). */
export function previewTemplate(template: string, extension = '.mp4'): string {
  return `${renderTemplate(template, {
    awemeId: '7123456789012345678',
    index: 1,
    extension,
    metadata: {
      awemeId: '7123456789012345678',
      authorHandle: 'creator',
      authorName: 'Creator Name',
      caption: 'an example caption that runs on for a while #tag',
      durationMs: 14_000,
      coverUrl: null,
      musicTitle: null,
      uploadedAt: Date.UTC(2026, 2, 14),
      hashtags: ['tag'],
      isPhotoPost: false,
      stats: { views: null, likes: null, comments: null, shares: null },
    },
  })}${extension}`;
}
