import type { Logger } from 'pino';
import { AppError, toAppError } from '@shared/errors';
import type { Extractor, ResolvedVideo } from './types';
import { isTerminalForChain } from './yt-dlp-errors';

/**
 * The priority chain of section 2: "Multiple implementations register in a
 * priority chain. If the first fails, the next is tried automatically."
 *
 * With one refinement the spec implies but does not spell out: falling through
 * is only correct when a different extractor might actually do better. A
 * deleted, private, region-blocked or age-gated video will fail identically in
 * every implementation, so the chain stops on those immediately. Trying three
 * extractors against a deleted video would triple the outbound requests for
 * that item and eat the rate budget (section 8) to reach the same answer.
 *
 * The chain is itself an Extractor, so callers never care how many
 * implementations are behind it.
 */
export class ExtractorChain implements Extractor {
  readonly name = 'chain';

  constructor(
    private readonly extractors: readonly Extractor[],
    private readonly log?: Logger,
  ) {}

  /** Available when at least one member is. */
  async isAvailable(): Promise<boolean> {
    const availability = await Promise.all(this.extractors.map((e) => e.isAvailable().catch(() => false)));
    return availability.some(Boolean);
  }

  async resolve(canonicalUrl: string, options?: { signal?: AbortSignal }): Promise<ResolvedVideo> {
    if (this.extractors.length === 0) {
      throw new AppError('EXTRACTOR_FAILED', 'no extractors are registered');
    }

    let lastError: AppError | null = null;
    let anyAvailable = false;

    for (const extractor of this.extractors) {
      let available = false;
      try {
        available = await extractor.isAvailable();
      } catch {
        available = false;
      }

      if (!available) {
        // An uninstalled extractor is skipped silently — it is not a failed
        // attempt, and reporting it as one would mislabel a missing sidecar as
        // a broken video.
        this.log?.debug({ extractor: extractor.name }, 'extractor unavailable; skipping');
        continue;
      }
      anyAvailable = true;

      try {
        const resolved = await extractor.resolve(canonicalUrl, options);
        if (lastError) {
          this.log?.info(
            { extractor: extractor.name, after: lastError.code },
            'extractor chain recovered on a later implementation',
          );
        }
        return resolved;
      } catch (err) {
        const appError = toAppError(err, 'EXTRACTOR_FAILED');
        lastError = appError;

        if (isTerminalForChain(appError.code)) {
          this.log?.debug(
            { extractor: extractor.name, code: appError.code },
            'terminal failure; not trying further extractors',
          );
          throw appError;
        }

        this.log?.warn(
          { extractor: extractor.name, code: appError.code, detail: appError.detail },
          'extractor failed; trying next',
        );
      }
    }

    if (!anyAvailable) {
      throw new AppError('EXTRACTOR_FAILED', 'no extractor is installed; update the extractor from Settings');
    }

    throw lastError ?? new AppError('EXTRACTOR_FAILED', `every extractor failed for ${canonicalUrl}`);
  }
}
