import { useMemo, useState, type ChangeEvent, type DragEvent } from 'react';
import { parse } from '@shared/url-parse';
import { describeError } from '@shared/errors';
import { useAppStore } from '../store/app-store';
import { invoke } from '../lib/ipc';
import { Button, EmptyState, Panel } from '../components/primitives';

/**
 * Add Links — spec section 10.
 *
 * Validation is synchronous and local. `parse` lives in shared/ precisely so
 * this screen can revalidate every line on every keystroke without an IPC round
 * trip; at 300 lines, routing that through main would make typing stutter.
 *
 * Short links are shown as valid-but-unresolved rather than guessed at: their
 * ID is only knowable after a redirect, and claiming otherwise would produce a
 * duplicate count that turns out to be wrong.
 */

type LineStatus = 'valid' | 'short-link' | 'duplicate' | 'invalid';

interface Line {
  readonly raw: string;
  readonly status: LineStatus;
  readonly note: string;
}

function splitInput(value: string): string[] {
  // Newline or comma separated, per section 10.
  return value
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

function analyse(value: string): Line[] {
  const seen = new Set<string>();

  return splitInput(value).map((raw) => {
    const parsed = parse(raw);

    if (parsed.status === 'invalid') {
      return { raw, status: 'invalid' as const, note: describeError(parsed.code).title };
    }

    const key = parsed.status === 'resolved' ? `id:${parsed.awemeId}` : `url:${parsed.shortUrl.toLowerCase()}`;
    if (seen.has(key)) return { raw, status: 'duplicate' as const, note: 'Duplicate in this paste' };
    seen.add(key);

    if (parsed.status === 'needs-redirect') {
      return { raw, status: 'short-link' as const, note: 'Short link — resolved when queued' };
    }
    return {
      raw,
      status: 'valid' as const,
      note: parsed.kind === 'photo' ? 'Photo slideshow — not supported' : `@${parsed.authorHandle ?? '…'}`,
    };
  });
}

const DOT: Record<LineStatus, string> = {
  valid: 'bg-mint-400',
  'short-link': 'bg-accent-400',
  duplicate: 'bg-warn-400',
  invalid: 'bg-danger-400',
};

export function AddLinks({ onQueued }: { onQueued: () => void }): React.JSX.Element {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const pushToast = useAppStore((s) => s.pushToast);

  const lines = useMemo(() => analyse(value), [value]);
  const addable = lines.filter((l) => l.status === 'valid' || l.status === 'short-link').length;
  const duplicates = lines.filter((l) => l.status === 'duplicate').length;
  const invalid = lines.filter((l) => l.status === 'invalid').length;

  async function add(): Promise<void> {
    setBusy(true);
    try {
      const result = await invoke('queue:addLinks', { urls: splitInput(value) });
      const parts = [`${result.added} queued`];
      if (result.duplicatesRemoved > 0) parts.push(`${result.duplicatesRemoved} duplicates removed`);
      if (result.alreadyInQueue > 0) parts.push(`${result.alreadyInQueue} already in queue`);
      if (result.invalid.length > 0) parts.push(`${result.invalid.length} invalid`);

      pushToast({ kind: result.added > 0 ? 'success' : 'warning', message: parts.join(' · ') });
      if (result.added > 0) {
        setValue('');
        onQueued();
      }
    } catch (err) {
      pushToast({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  function onDrop(event: DragEvent<HTMLTextAreaElement>): void {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (!file) return;
    // .txt/.csv import, section 12. Read in the renderer because a dropped
    // File is already in memory — no filesystem access is involved.
    void file.text().then((text) => setValue((current) => (current ? `${current}\n${text}` : text)));
  }

  return (
    <div className="mx-auto grid max-w-5xl gap-5">
      <Panel title="Paste links">
        <textarea
          value={value}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setValue(event.target.value)}
          onDrop={onDrop}
          onDragOver={(event) => event.preventDefault()}
          spellCheck={false}
          placeholder={'https://www.tiktok.com/@creator/video/7123456789012345678\nhttps://vm.tiktok.com/ZMabcdef/\n\nOr drop a .txt or .csv file here.'}
          aria-label="TikTok links, one per line"
          className="h-56 w-full resize-none rounded-xl border border-white/8 bg-base-900/60 p-4 font-mono text-sm
            text-ink-100 placeholder:text-ink-500/60 focus:border-accent-500/50 focus:outline-none"
        />

        <div className="mt-4 flex flex-wrap items-center gap-4">
          <span className="text-sm text-ink-300" aria-live="polite">
            {lines.length === 0 ? (
              'No links yet'
            ) : (
              <>
                <strong className="text-ink-100">{lines.length}</strong> links found
                {duplicates > 0 && <> · {duplicates} duplicates removed</>}
                {invalid > 0 && <> · {invalid} invalid</>}
              </>
            )}
          </span>

          <div className="ml-auto flex gap-2">
            {value !== '' && (
              <Button variant="ghost" onClick={() => setValue('')}>
                Clear
              </Button>
            )}
            <Button variant="primary" onClick={() => void add()} disabled={addable === 0 || busy}>
              {busy ? 'Adding…' : `Add ${addable} to queue`}
            </Button>
          </div>
        </div>
      </Panel>

      {lines.length > 0 && (
        <Panel title={`Preview (${lines.length})`}>
          <ul className="max-h-80 space-y-1 overflow-y-auto">
            {lines.map((line, index) => (
              <li key={`${line.raw}-${index}`} className="flex items-center gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-white/3">
                <span className={`size-2 shrink-0 rounded-full ${DOT[line.status]}`} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-300">{line.raw}</span>
                <span
                  className={`shrink-0 text-xs ${
                    line.status === 'invalid'
                      ? 'text-danger-400'
                      : line.status === 'duplicate'
                        ? 'text-warn-400'
                        : 'text-ink-500'
                  }`}
                >
                  {line.note}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {lines.length === 0 && (
        <EmptyState
          title="Nothing pasted yet"
          hint="Paste TikTok links one per line, or drop a .txt or .csv file into the box above. Each line is checked as you type."
        />
      )}
    </div>
  );
}
