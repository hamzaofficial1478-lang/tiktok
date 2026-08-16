import { useMemo, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { parse, parseProfile } from '@shared/url-parse';
import { scanText, suspiciousCount, type ScanReport } from '@shared/link-safety';
import { describeError } from '@shared/errors';
import { useAppStore } from '../store/app-store';
import { invoke } from '../lib/ipc';
import { Button, EmptyState, PageHeader, Panel } from '../components/primitives';
import { SegmentedControl, TextInput } from '../components/form';
import { ScanReportPanel } from '../components/ScanReportPanel';
import { Creators } from '../components/Creators';
import { RunStatus } from '../components/RunStatus';
import { Icon } from '../components/icons';
import { Queue } from './Queue';

/** How each caption source reads in one phrase, for the summary strip. */
const CAPTION_SOURCE_LABEL: Record<string, string> = {
  auto: "TikTok's own, transcribed if there are none",
  tiktok: "TikTok's own captions",
  transcribe: 'transcribed from the audio',
};

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

type LineStatus = 'valid' | 'short-link' | 'duplicate' | 'profile' | 'invalid';

/** Which of the two things the user is pasting. */
type Mode = 'links' | 'profile';

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
    /**
     * A profile link pasted into the links box is not a mistake, it is the
     * other feature — so it is labelled as itself rather than rejected as an
     * invalid video link, and the Fetch button turns it into the videos it
     * stands for.
     */
    const profile = parseProfile(raw);
    if (profile) {
      return { raw, status: 'profile' as const, note: `Whole account — press Fetch videos` };
    }

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
      note: parsed.kind === 'photo' ? 'Photo slideshow — you will be asked' : `@${parsed.authorHandle ?? '…'}`,
    };
  });
}

const DOT: Record<LineStatus, string> = {
  valid: 'bg-mint-400',
  'short-link': 'bg-accent-400',
  duplicate: 'bg-warn-400',
  profile: 'bg-sky-400',
  invalid: 'bg-danger-400',
};



/**
 * @param onOpenQueue Switches to the full Queue screen. Adding links no longer
 *   navigates there on its own: the queue is rendered at the foot of this page,
 *   so the rows appear where the user is already looking instead of the page
 *   changing under them the moment they press Add.
 * @param onOpenCaptions Switches to the Captions section, from the summary
 *   strip that replaced the full editor here.
 */
export function AddLinks({
  onOpenQueue,
  onOpenCaptions,
}: {
  onOpenQueue: () => void;
  onOpenCaptions: () => void;
}): React.JSX.Element {
  const [value, setValue] = useState('');
  const [mode, setMode] = useState<Mode>('links');
  const [profileInput, setProfileInput] = useState('');
  const [fetching, setFetching] = useState(false);
  /**
   * The account the links in the box came from, if they came from one.
   *
   * Held so that Add can file them in a folder of their own. Cleared the moment
   * the text is edited by hand: once the list is not simply "what @creator
   * posted" any more, filing it under that name would be a claim about the
   * files that is no longer true.
   */
  const [fetchedFrom, setFetchedFrom] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [scan, setScan] = useState<{ report: ScanReport; fileNames: string[] } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pushToast = useAppStore((s) => s.pushToast);
  const captions = useAppStore((s) => s.config?.captions ?? null);

  const lines = useMemo(() => analyse(value), [value]);
  const addable = lines.filter((l) => l.status === 'valid' || l.status === 'short-link').length;
  const duplicates = lines.filter((l) => l.status === 'duplicate').length;
  const invalid = lines.filter((l) => l.status === 'invalid').length;
  const profiles = lines.filter((l) => l.status === 'profile');
  const profileTarget = parseProfile(profileInput);

  /**
   * Lists an account and drops its videos into the same box.
   *
   * Deliberately two steps rather than one. Listing can come back with two
   * hundred videos, and queueing them the instant a profile link is pasted
   * would turn one keystroke into an hour of downloads nobody agreed to. The
   * links land in the preview, where the count and every line is visible, and
   * the existing Add button does what it always did.
   */
  async function fetchProfile(input: string): Promise<void> {
    setFetching(true);
    try {
      // No limit: every video the account has posted.
      const result = await invoke('queue:expandProfile', { input });
      const fetched = result.urls.join('\n');

      setValue((current) => {
        // The profile line itself is replaced by what it stands for, so the
        // preview does not keep offering to fetch an account already fetched.
        const kept = splitInput(current).filter((line) => parseProfile(line)?.handle !== result.handle);
        return [...kept, fetched].filter((part) => part !== '').join('\n');
      });
      setProfileInput('');
      setFetchedFrom(result.handle);
      setMode('links');

      pushToast({
        kind: 'success',
        message:
          `@${result.handle} · ${result.urls.length} video${result.urls.length === 1 ? '' : 's'} found` +
          ` · they will be saved in a folder named ${result.handle}`,
      });
    } catch (err) {
      pushToast({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setFetching(false);
    }
  }

  async function add(): Promise<void> {
    setBusy(true);
    try {
      const result = await invoke('queue:addLinks', {
        urls: splitInput(value),
        subfolder: fetchedFrom,
      });
      const parts = [`${result.added} queued`];
      if (result.duplicatesRemoved > 0) parts.push(`${result.duplicatesRemoved} duplicates removed`);
      if (result.alreadyInQueue > 0) parts.push(`${result.alreadyInQueue} already in queue`);
      if (result.invalid.length > 0) parts.push(`${result.invalid.length} invalid`);

      if (fetchedFrom && result.added > 0) parts.push(`saved to a folder named ${fetchedFrom}`);
      pushToast({ kind: result.added > 0 ? 'success' : 'warning', message: parts.join(' · ') });
      if (result.added > 0) {
        setValue('');
        setFetchedFrom(null);
      }
    } catch (err) {
      pushToast({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  /**
   * .txt/.csv import, section 12. Read in the renderer because a File the user
   * chose or dropped is already in memory — no filesystem access is involved,
   * so this does not need to cross IPC.
   */
  async function importFiles(files: readonly File[]): Promise<void> {
    if (files.length === 0) return;
    try {
      const texts = await Promise.all(files.map((file) => file.text()));

      // Screened before a single line reaches the textarea, so a hostile or
      // malformed file cannot get as far as the queue — and so the counts can
      // be reported at the moment the user picks the file rather than after
      // rows have already appeared.
      const report = scanText(texts.join('\n'));
      setScan({ report, fileNames: files.map((f) => f.name) });

      if (report.fatal !== null) return;

      const safe = report.accepted.map((line) => line.raw).join('\n');
      if (safe !== '') setValue((current) => (current ? `${current}\n${safe}` : safe));

      const blocked = suspiciousCount(report);
      pushToast({
        kind: blocked > 0 ? 'warning' : 'success',
        message:
          `${report.accepted.length} of ${report.totalLines} lines ready` +
          (blocked > 0 ? ` · ${blocked} disguised link${blocked === 1 ? '' : 's'} blocked` : ''),
      });
    } catch (err) {
      pushToast({
        kind: 'error',
        message: `Could not read the file: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  function onDrop(event: DragEvent<HTMLTextAreaElement>): void {
    event.preventDefault();
    setDragging(false);
    void importFiles([...event.dataTransfer.files]);
  }

  function onFileInput(event: ChangeEvent<HTMLInputElement>): void {
    void importFiles([...(event.target.files ?? [])]);
    // Reset so picking the same file twice fires change again.
    event.target.value = '';
  }

  return (
    <div className="mx-auto grid max-w-5xl gap-5">
      <PageHeader
        title="Add links"
        description="Paste TikTok links, import a .txt or .csv, or pull every video from one account. Nothing downloads until you add it to the queue."
      />

      {/* Above the fold, before the paste box: how much is left and what
          failed. This is the answer to "is it working?", and it belongs where
          the work is started rather than one screen away. */}
      <RunStatus onOpenQueue={onOpenQueue} />

      {/* Two ways in, stated as a choice rather than left to be discovered. */}
      <SegmentedControl
        ariaLabel="What you are adding"
        value={mode}
        onChange={setMode}
        options={[
          { value: 'links', label: 'Video links', hint: 'Paste or import individual TikTok links' },
          { value: 'profile', label: 'Creators', hint: 'Save accounts and take the newest videos from each' },
        ]}
      />

      {mode === 'profile' && <Creators />}

      {mode === 'profile' && (
        <Panel
          title="Or fetch one account now"
          description="A one-off: lists every video from a single account without saving it to the list above."
        >
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-64 flex-1" onKeyDown={(event) => {
              if (event.key === 'Enter' && profileTarget && !fetching) void fetchProfile(profileInput);
            }}>
              <TextInput
                value={profileInput}
                onChange={setProfileInput}
                mono
                placeholder="https://www.tiktok.com/@creator   or   @creator"
                ariaLabel="TikTok profile link or handle"
              />
            </div>
            <Button
              variant="primary"
              onClick={() => void fetchProfile(profileInput)}
              disabled={!profileTarget || fetching}
            >
              {fetching ? 'Fetching all videos…' : 'Fetch all videos'}
            </Button>
          </div>
          <p className="mt-3 text-xs text-ink-500">
            {profileInput === ''
              ? 'Every video the account has posted is listed for you to review before anything downloads. A large account takes a minute or two to list.'
              : profileTarget
                ? `Ready to list every video on @${profileTarget.handle}. Nothing downloads until you press Add.`
                : 'That is not a profile link. A single video link goes in the Video links tab.'}
          </p>
        </Panel>
      )}

      {/**
       * A summary, not the editor.
       *
       * The full caption controls now have a section of their own — they had
       * grown to a font, a size, colours, an outline, a position and an
       * animation, all of which sat between the top of this page and the paste
       * box. What belongs here is the one thing someone about to press Add
       * needs to know: what will happen to these videos, and where to change
       * it.
       */}
      {captions && (
        <Panel bodyClassName="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
          <span className="flex items-center gap-2 text-sm text-ink-300">
            <Icon name="caption" size={15} className={captions.mode === 'off' ? 'text-ink-500' : 'text-accent-400'} />
            {captions.mode === 'off' ? (
              'Captions off — videos download exactly as posted'
            ) : (
              <>
                Captions{' '}
                <strong className="font-medium text-ink-100">
                  {captions.mode === 'burn' ? 'burned into the video' : 'as a subtitle track'}
                </strong>
                {' · '}
                {CAPTION_SOURCE_LABEL[captions.source]}
                {' · '}
                {captions.style.animation} · {captions.style.fontFamily}
              </>
            )}
          </span>
          <Button variant="ghost" size="sm" icon="settings" onClick={onOpenCaptions}>
            {captions.mode === 'off' ? 'Turn captions on' : 'Change'}
          </Button>
        </Panel>
      )}

      <Panel
        title="Paste links"
        description={
          fetchedFrom
            ? `${lines.length} video${lines.length === 1 ? '' : 's'} from @${fetchedFrom} — these will be saved together in a folder named ${fetchedFrom}, numbered in this order.`
            : undefined
        }
      >
        <textarea
          value={value}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
            setValue(event.target.value);
            // Edited by hand: this is no longer one account's list.
            setFetchedFrom(null);
          }}
          onDrop={onDrop}
          onDragOver={(event) => {
            event.preventDefault();
            if (!dragging) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          spellCheck={false}
          placeholder={'https://www.tiktok.com/@creator/video/7123456789012345678\nhttps://vm.tiktok.com/ZMabcdef/\n\nPaste as many as you like, one per line — or use Import file.'}
          aria-label="TikTok links, one per line"
          className={`h-56 w-full resize-none rounded-xl border bg-base-900/60 p-4 font-mono text-sm
            text-ink-100 placeholder:text-ink-500/60 focus:outline-none ${
              dragging ? 'border-accent-500 bg-accent-500/5' : 'border-white/8 focus:border-accent-500/50'
            }`}
        />

        <div className="mt-4 flex flex-wrap items-center gap-4">
          <span className="text-sm text-ink-300" aria-live="polite">
            {lines.length === 0 ? (
              'No links yet'
            ) : (
              <>
                <strong className="text-ink-100">{lines.length}</strong> links found
                {duplicates > 0 && <> · {duplicates} duplicates removed</>}
                {profiles.length > 0 && <> · {profiles.length} account{profiles.length === 1 ? '' : 's'}</>}
                {invalid > 0 && <> · {invalid} invalid</>}
              </>
            )}
          </span>

          <div className="ml-auto flex gap-2">
            {profiles.length > 0 && profiles[0] && (
              <Button
                variant="secondary"
                icon="user"
                onClick={() => void fetchProfile(profiles[0]!.raw)}
                disabled={fetching}
              >
                {fetching ? 'Fetching…' : `Fetch videos from ${profiles.length > 1 ? 'first account' : 'account'}`}
              </Button>
            )}
            {/* A real file picker, not just the drop target: dropping a file is
                undiscoverable unless you already know it works. */}
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,.csv,text/plain,text/csv"
              multiple
              onChange={onFileInput}
              className="hidden"
            />
            <Button variant="secondary" icon="file" onClick={() => fileInputRef.current?.click()}>
              Import file…
            </Button>
            {value !== '' && (
              <Button
                variant="ghost"
                onClick={() => {
                  setValue('');
                  setFetchedFrom(null);
                }}
              >
                Clear
              </Button>
            )}
            <Button variant="primary" onClick={() => void add()} disabled={addable === 0 || busy}>
              {busy ? 'Adding…' : `Add ${addable} to queue`}
            </Button>
          </div>
        </div>
      </Panel>

      {scan && (
        <ScanReportPanel report={scan.report} fileNames={scan.fileNames} onDismiss={() => setScan(null)} />
      )}

      {/* The queue itself, on the page that fills it. Empty, it renders
          nothing at all rather than an empty-state competing with the paste
          box directly above it. */}
      <Queue embedded onAddLinks={onOpenQueue} />

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
                        : line.status === 'profile'
                          ? 'text-sky-300'
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

    </div>
  );
}
