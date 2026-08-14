import { useEffect, useState } from 'react';
import type { LibraryEntryDto } from '@shared/ipc/contract';
import { invoke } from '../lib/ipc';
import { useAppStore } from '../store/app-store';
import { Button, EmptyState, PageHeader, Panel, WatermarkBadge, formatBytes, formatDuration } from '../components/primitives';
import { TextInput } from '../components/form';

/** Library — completed downloads, searchable, with the section 7 repost badge. */
export function Library(): React.JSX.Element {
  const [entries, setEntries] = useState<LibraryEntryDto[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [clearing, setClearing] = useState(false);
  /** Two presses, because there is no undo and no confirmation dialog here. */
  const [confirmClear, setConfirmClear] = useState(false);
  const pushToast = useAppStore((s) => s.pushToast);

  async function clearAll(): Promise<void> {
    setClearing(true);
    try {
      const { removed } = await invoke('library:clearRecords');
      setEntries([]);
      setTotal(0);
      setConfirmClear(false);
      pushToast({
        kind: 'success',
        message: `${removed} record${removed === 1 ? '' : 's'} cleared · your video files were not touched`,
      });
    } catch (err) {
      pushToast({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setClearing(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // Debounced so typing does not fire a query per keystroke.
    const timer = setTimeout(() => {
      void invoke('library:list', { search, limit: 300 })
        .then((result) => {
          if (cancelled) return;
          setEntries(result.entries);
          setTotal(result.total);
        })
        .catch((err: unknown) => {
          if (!cancelled) pushToast({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 200);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [search, pushToast]);

  async function remove(entry: LibraryEntryDto, alsoFile: boolean): Promise<void> {
    try {
      await invoke(alsoFile ? 'library:deleteFile' : 'library:deleteRecord', { downloadId: entry.downloadId });
      setEntries((current) => current.filter((e) => e.downloadId !== entry.downloadId));
      pushToast({ kind: 'success', message: alsoFile ? 'File deleted' : 'Record removed' });
    } catch (err) {
      pushToast({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  if (!loading && entries.length === 0 && search === '') {
    return (
      <EmptyState
        icon="library"
        title="Nothing downloaded yet"
        hint="Finished downloads appear here, with what happened to the watermark on each one."
      />
    );
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <PageHeader
        title="Library"
        description="Every download this app has recorded. Clearing the list forgets the records; it never deletes a video."
      />

      <Panel className="shrink-0" bodyClassName="px-5 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-56 flex-1">
            <TextInput
              value={search}
              onChange={setSearch}
              placeholder="Search captions and authors…"
              ariaLabel="Search the library"
            />
          </div>
          <span className="text-sm text-ink-500">
            {total} item{total === 1 ? '' : 's'}
          </span>

          {/**
           * Two presses rather than a dialog. Clearing cannot be undone and it
           * takes duplicate detection's memory with it — a video downloaded
           * before this will not be recognised as one afterwards — so the
           * second press names the consequence instead of asking "are you
           * sure?", which nobody reads.
           */}
          {total > 0 &&
            (confirmClear ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-warn-400">
                  Forget all {total} records? Your video files stay where they are.
                </span>
                <Button variant="danger" size="sm" disabled={clearing} onClick={() => void clearAll()}>
                  {clearing ? 'Clearing…' : 'Yes, clear the list'}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmClear(false)}>
                  Keep
                </Button>
              </div>
            ) : (
              <Button variant="ghost" icon="trash" onClick={() => setConfirmClear(true)}>
                Clear all
              </Button>
            ))}
        </div>
      </Panel>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {entries.length === 0 ? (
          <EmptyState
            icon="library"
            title={search === '' ? 'Nothing here yet' : 'No matches'}
            hint={
              search === ''
                ? 'Downloads appear here once they finish, with what happened to the watermark on each one.'
                : 'Nothing in the library matches that search.'
            }
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {entries.map((entry) => (
              <article key={entry.downloadId} className="elevation-card overflow-hidden">
                <div className="p-4">
                  <div className="flex items-start justify-between gap-2">
                    <p className="min-w-0 flex-1 truncate text-sm font-medium text-ink-100">
                      @{entry.authorHandle ?? 'unknown'}
                    </p>
                    <div className="flex shrink-0 gap-1">
                      <WatermarkBadge
                        sourceStrategy={entry.sourceStrategy}
                        watermarkRemoved={entry.watermarkRemoved}
                      />
                      {entry.possibleRepost && (
                        <span
                          title="Matches other content in the library; perceptual hashing can produce false positives"
                          className="rounded bg-accent-500/20 px-1.5 py-0.5 text-[10px] font-medium text-accent-300"
                        >
                          possible repost
                        </span>
                      )}
                    </div>
                  </div>

                  <p className="mt-1 line-clamp-2 text-xs text-ink-500">{entry.caption ?? 'No caption'}</p>

                  <div className="mt-3 flex items-center gap-3 text-xs text-ink-500">
                    <span>{formatDuration(entry.durationMs)}</span>
                    <span>{formatBytes(entry.fileSize)}</span>
                    <span>{new Date(entry.completedAt).toLocaleDateString()}</span>
                    {!entry.fileExists && <span className="text-danger-400">file missing</span>}
                  </div>

                  <div className="mt-3 flex flex-wrap gap-1">
                    <Button
                      variant="ghost"
                      disabled={!entry.fileExists}
                      onClick={() => void invoke('system:openPath', { path: entry.filePath })}
                    >
                      Play
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={!entry.fileExists}
                      onClick={() => void invoke('system:showInFolder', { path: entry.filePath })}
                    >
                      Show
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        void navigator.clipboard.writeText(entry.canonicalUrl);
                        pushToast({ kind: 'info', message: 'Link copied' });
                      }}
                    >
                      Copy link
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => void invoke('queue:addLinks', { urls: [entry.canonicalUrl] })}
                    >
                      Re-download
                    </Button>
                    <Button variant="ghost" onClick={() => void remove(entry, entry.fileExists)}>
                      {entry.fileExists ? 'Delete file' : 'Remove record'}
                    </Button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
