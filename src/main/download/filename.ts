import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizeBasename } from '@shared/filename-template';

export {
  renderTemplate,
  sanitizeSegment,
  sanitizeBasename,
  previewTemplate,
} from '@shared/filename-template';
export type { TemplateContext } from '@shared/filename-template';

void sanitizeBasename;

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

