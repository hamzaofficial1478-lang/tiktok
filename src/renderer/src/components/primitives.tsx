import type { ReactNode } from 'react';
import { describeError, type ErrorCode } from '@shared/errors';

/**
 * Shared UI primitives.
 *
 * Deliberately no component library (section 10): the visual direction is
 * specific enough that one would be fought rather than used. Everything here
 * is built on the four-layer elevation scale in theme/tokens.css so surfaces
 * read as one system rather than as scattered effects.
 */

export function Panel({
  title,
  actions,
  children,
  className = '',
}: {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <section className={`elevation-card ${className}`}>
      {(title || actions) && (
        <header className="flex items-center justify-between border-b border-white/5 px-5 py-3">
          {title && <h2 className="text-xs font-semibold uppercase tracking-widest text-ink-500">{title}</h2>}
          {actions}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

export function Button({
  children,
  onClick,
  variant = 'secondary',
  disabled,
  title,
  type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  disabled?: boolean;
  title?: string;
  type?: 'button' | 'submit';
}): React.JSX.Element {
  const styles: Record<string, string> = {
    primary: 'bg-accent-500 text-white hover:bg-accent-400 shadow-[0_4px_16px_-4px_rgba(139,92,246,0.6)]',
    secondary: 'bg-base-700 text-ink-100 hover:bg-base-600 border border-white/8',
    ghost: 'text-ink-300 hover:bg-white/5',
    danger: 'bg-danger-400/15 text-danger-400 hover:bg-danger-400/25 border border-danger-400/30',
  };

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors
        disabled:cursor-not-allowed disabled:opacity-40 ${styles[variant]}`}
    >
      {children}
    </button>
  );
}

const STATUS_STYLES: Record<string, string> = {
  queued: 'bg-base-700 text-ink-300',
  resolving: 'bg-accent-500/20 text-accent-300',
  awaiting_user: 'bg-warn-400/20 text-warn-400',
  downloading: 'bg-accent-500/20 text-accent-300',
  processing: 'bg-accent-500/20 text-accent-300',
  completed: 'bg-mint-500/20 text-mint-300',
  failed: 'bg-danger-400/20 text-danger-400',
  skipped: 'bg-base-700 text-ink-500',
  cancelled: 'bg-base-700 text-ink-500',
  paused: 'bg-base-700 text-ink-300',
};

export function StatusChip({ status }: { status: string }): React.JSX.Element {
  return (
    <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[status] ?? 'bg-base-700 text-ink-300'}`}>
      {status.replace('_', ' ')}
    </span>
  );
}

/**
 * What happened to the watermark, in one glance (section 9).
 *
 * "clean source" and "re-encoded" are deliberately different badges: the first
 * means the untouched, watermark-free stream was downloaded byte for byte, the
 * second means pixels were filtered and the video was encoded again. A file
 * that still carries the watermark says so rather than showing nothing, so an
 * absent badge only ever means "not finished yet".
 */
export function WatermarkBadge({
  sourceStrategy,
  watermarkRemoved,
}: {
  sourceStrategy: string | null;
  watermarkRemoved: boolean | null;
}): React.JSX.Element | null {
  if (sourceStrategy === 'clean_source' && watermarkRemoved) {
    return (
      <span
        title="Downloaded from a watermark-free source; never re-encoded"
        className="shrink-0 rounded bg-mint-500/20 px-1.5 py-0.5 text-[10px] font-medium text-mint-300"
      >
        clean source
      </span>
    );
  }
  if (sourceStrategy === 'removelogo' || sourceStrategy === 'blur') {
    return (
      <span
        title="The watermark was filtered out, which required re-encoding"
        className="shrink-0 rounded bg-warn-400/20 px-1.5 py-0.5 text-[10px] font-medium text-warn-400"
      >
        re-encoded
      </span>
    );
  }
  if (sourceStrategy === 'raw') {
    return (
      <span
        title="No watermark-free source was offered and removal was not attempted, so the watermark is still in the video"
        className="shrink-0 rounded bg-base-700 px-1.5 py-0.5 text-[10px] font-medium text-ink-300"
      >
        watermarked
      </span>
    );
  }
  return null;
}

/** Circular progress ring for a queue row (section 10). */
export function ProgressRing({ value, size = 28 }: { value: number; size?: number }): React.JSX.Element {
  const radius = (size - 4) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(1, value));

  return (
    <svg width={size} height={size} className="shrink-0 -rotate-90" role="img" aria-label={`${Math.round(clamped * 100)}%`}>
      <circle cx={size / 2} cy={size / 2} r={radius} strokeWidth={3} className="fill-none stroke-white/10" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        strokeWidth={3}
        strokeLinecap="round"
        className="fill-none stroke-accent-400 transition-[stroke-dashoffset] duration-200"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - clamped)}
      />
    </svg>
  );
}

/**
 * Renders a taxonomy error.
 *
 * Section 11: no raw stack traces and no bare "Something went wrong" — the
 * message says what happened, and a retry button appears only for codes that
 * can actually be retried.
 */
export function ErrorNote({
  code,
  detail,
  onRetry,
  onAction,
}: {
  code: ErrorCode;
  detail?: string | null;
  onRetry?: () => void;
  onAction?: (action: string) => void;
}): React.JSX.Element {
  const descriptor = describeError(code);

  return (
    <div className="rounded-lg border border-danger-400/25 bg-danger-400/8 p-3 text-sm" role="alert">
      <p className="font-medium text-danger-400">{descriptor.title}</p>
      <p className="mt-1 text-ink-300">{descriptor.message}</p>
      {detail && <p className="mt-2 font-mono text-xs text-ink-500 break-all">{detail}</p>}
      {descriptor.userRetryable && (
        <div className="mt-3 flex gap-2">
          {descriptor.action === 'retry' && onRetry && (
            <Button variant="secondary" onClick={onRetry}>
              Retry
            </Button>
          )}
          {descriptor.action !== 'retry' && descriptor.action !== 'none' && onAction && (
            <Button variant="secondary" onClick={() => onAction(descriptor.action)}>
              {descriptor.action === 'update-extractor'
                ? 'Update extractor'
                : descriptor.action === 'choose-folder'
                  ? 'Choose folder'
                  : descriptor.action === 'open-logs'
                    ? 'Open logs'
                    : 'Fix'}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint: string;
  action?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="grid place-items-center px-6 py-20 text-center">
      <div className="max-w-sm">
        <p className="text-base font-medium text-ink-100">{title}</p>
        <p className="mt-2 text-sm text-ink-500">{hint}</p>
        {action && <div className="mt-5 flex justify-center">{action}</div>}
      </div>
    </div>
  );
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Transfer rate, e.g. "4.2 MB/s". */
export function formatSpeed(bytesPerSecond: number | null): string {
  if (bytesPerSecond === null || bytesPerSecond <= 0) return '—';
  return `${formatBytes(bytesPerSecond)}/s`;
}

/**
 * Time remaining, in the coarsest unit that is still useful.
 *
 * An ETA is a guess, so it is never shown to a precision it does not have:
 * "about 3 min" rather than "3:07" for anything over a minute.
 */
export function formatEta(ms: number | null): string {
  if (ms === null || ms <= 0 || !Number.isFinite(ms)) return '—';
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds}s left`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min left`;
  return `${Math.round(minutes / 60)} h left`;
}

export function formatDuration(ms: number | null): string {
  if (ms === null || ms <= 0) return '—';
  const total = Math.round(ms / 1_000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
