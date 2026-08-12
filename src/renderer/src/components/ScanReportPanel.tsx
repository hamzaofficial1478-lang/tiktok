import { useState } from 'react';
import {
  REJECT_LABELS,
  SUSPICIOUS_REASONS,
  suspiciousCount,
  type RejectReason,
  type ScanReport,
} from '@shared/link-safety';
import { Button, Panel } from './primitives';

/**
 * What an imported file actually contained — spec section 10's "42 links found
 * · 3 duplicates removed", extended to say *why* the rest were dropped.
 *
 * The counts are the point. A file that silently loses a third of its lines is
 * indistinguishable from one that was fine, so every line is accounted for in
 * one of the buckets and the totals add up.
 */
export function ScanReportPanel({
  report,
  fileNames,
  onDismiss,
}: {
  report: ScanReport;
  fileNames: readonly string[];
  onDismiss: () => void;
}): React.JSX.Element {
  const [showRejected, setShowRejected] = useState(false);
  const suspicious = suspiciousCount(report);

  if (report.fatal !== null) {
    return (
      <Panel title="File rejected">
        <p className="text-sm text-danger-400">{report.fatal}</p>
        <p className="mt-2 text-xs text-ink-500">Nothing was added to the queue.</p>
        <div className="mt-4">
          <Button variant="ghost" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      </Panel>
    );
  }

  const rejectedCount = report.rejected.length;
  const reasons = (Object.keys(REJECT_LABELS) as RejectReason[]).filter((r) => report.counts[r] > 0);

  return (
    <Panel title={`Scanned ${fileNames.join(', ')}`}>
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
        <span className="text-sm text-ink-300">
          <strong className="text-xl text-ink-100">{report.totalLines}</strong> lines read
        </span>
        <span className="text-sm text-mint-300">
          <strong className="text-xl">{report.accepted.length}</strong> ready to download
        </span>
        {rejectedCount > 0 && (
          <span className="text-sm text-ink-500">
            <strong className="text-xl text-ink-300">{rejectedCount}</strong> dropped
          </span>
        )}
      </div>

      {/* A blocked spoof is the one result worth interrupting for. */}
      {suspicious > 0 && (
        <div className="mt-4 rounded-lg border border-danger-400/30 bg-danger-400/10 p-3">
          <p className="text-sm font-medium text-danger-400">
            {suspicious} link{suspicious === 1 ? ' was' : 's were'} deliberately disguised and blocked
          </p>
          <p className="mt-1 text-xs text-ink-300">
            These were built to look like TikTok addresses without being them. They were not queued, and nothing
            from them ran. If you did not expect this, treat wherever the file came from as untrustworthy.
          </p>
        </div>
      )}

      {report.truncated && (
        <p className="mt-3 text-xs text-warn-400">
          The file was longer than the {report.totalLines.toLocaleString()}-line limit; the rest was ignored.
        </p>
      )}

      {reasons.length > 0 && (
        <ul className="mt-4 grid gap-1 text-xs sm:grid-cols-2">
          {reasons.map((reason) => (
            <li key={reason} className="flex items-baseline justify-between gap-3 rounded-md px-2 py-1 hover:bg-white/3">
              <span className={SUSPICIOUS_REASONS.includes(reason) ? 'text-danger-400' : 'text-ink-500'}>
                {REJECT_LABELS[reason]}
              </span>
              <span className="font-mono text-ink-300">{report.counts[reason]}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 flex gap-2">
        {rejectedCount > 0 && (
          <Button variant="ghost" onClick={() => setShowRejected(!showRejected)}>
            {showRejected ? 'Hide' : 'Show'} the {rejectedCount} dropped
          </Button>
        )}
        <Button variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>

      {showRejected && (
        <ul className="mt-3 max-h-64 space-y-1 overflow-y-auto border-t border-white/5 pt-3">
          {report.rejected.map((line) => (
            <li key={`${line.lineNumber}-${line.raw}`} className="flex items-baseline gap-3 text-xs">
              <span className="w-10 shrink-0 text-right font-mono text-ink-500">{line.lineNumber}</span>
              {/* Always plain text: this content is untrusted by definition. */}
              <span className="min-w-0 flex-1 truncate font-mono text-ink-300">{line.raw}</span>
              <span
                className={`shrink-0 ${
                  SUSPICIOUS_REASONS.includes(line.reason) ? 'text-danger-400' : 'text-ink-500'
                }`}
                title={line.detail}
              >
                {REJECT_LABELS[line.reason]}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
