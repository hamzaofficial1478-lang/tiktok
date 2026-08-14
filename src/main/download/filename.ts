import { existsSync, mkdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { sanitizeBasename, sanitizeSegment } from '@shared/filename-template';
import { AppError } from '@shared/errors';

export {
  renderTemplate,
  sanitizeSegment,
  sanitizeBasename,
  previewTemplate,
} from '@shared/filename-template';
export type { TemplateContext } from '@shared/filename-template';

void sanitizeBasename;

/**
 * The folder an item's video belongs in, created if it does not exist.
 *
 * `subdir` is a TikTok handle that arrived over the network, so it is treated
 * as untrusted: sanitised to one path segment, then checked to actually resolve
 * inside the output folder. The check is not redundant with the sanitiser —
 * belt and braces on a value that decides where files are written is the right
 * ratio, because the failure mode is writing outside the folder the user chose.
 */
export function resolveOutputDirectory(root: string, subdir: string | null | undefined): string {
  if (!subdir) return root;

  /**
   * Flattened to one segment before anything else looks at it.
   *
   * Separators become spaces and runs of dots are dropped, so "../../etc"
   * arrives as "etc" rather than as a folder literally named ".. .. etc" —
   * which is what a naive replacement produces, and which is both ugly and
   * indistinguishable from traversal to the check below.
   */
  const flattened = subdir.replace(/[\\/]+/g, ' ').replace(/\.{2,}/g, ' ');
  const segment = sanitizeBasename(sanitizeSegment(flattened));
  if (segment === '' || segment === '.' || segment === 'untitled') return root;

  const directory = join(root, segment);
  const inside = relative(resolve(root), resolve(directory));
  // The boundary matters: a folder legitimately named "..cool" is not an escape.
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new AppError('PERMISSION_DENIED', `refusing to write outside the output folder: ${subdir}`);
  }

  mkdirSync(directory, { recursive: true });
  return directory;
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

