import { useEffect, useState } from 'react';
import type { AppConfig } from '@shared/config-schema';
import type { InvokeResponse } from '@shared/ipc/contract';
import { previewTemplate } from '@shared/filename-template';
import { useAppStore } from '../store/app-store';
import { invoke } from '../lib/ipc';
import { Button, PageHeader, Panel, formatBytes } from '../components/primitives';
import { Field, NumberInput, Select, TextInput, Toggle } from '../components/form';
import { Icon } from '../components/icons';
import { CaptionSettings } from '../components/CaptionSettings';

/**
 * Settings — section 10. Every control writes through the single AppConfig.
 *
 * The controls used to be declared here: a local Field, a shared `inputClass`
 * string, raw selects and a column of bare checkboxes. They now come from
 * components/form, which is what stops this screen and the next one drifting
 * apart one border colour at a time.
 */
type ProxyTestState = InvokeResponse<'system:testProxy'> | 'testing' | null;

export function Settings(): React.JSX.Element {
  const config = useAppStore((s) => s.config);
  const updateConfig = useAppStore((s) => s.updateConfig);
  const pushToast = useAppStore((s) => s.pushToast);
  const versions = useAppStore((s) => s.versions);
  const capabilities = useAppStore((s) => s.capabilities);
  const ffmpegMissing = useAppStore((s) => !s.sidecars.find((sc) => sc.name === 'ffmpeg')?.present);
  const install = useAppStore((s) => s.install);
  const [installing, setInstalling] = useState(false);
  const [updating, setUpdating] = useState(false);
  /** null = not tested since the URL last changed; 'testing' = in flight. */
  const [proxyTest, setProxyTest] = useState<ProxyTestState>(null);
  const proxyUrl = config?.proxyUrl ?? '';

  // A result describes one specific proxy URL, so editing the field invalidates
  // it. Showing a stale green tick against a changed proxy would be a lie.
  useEffect(() => {
    setProxyTest(null);
  }, [proxyUrl]);

  if (!config) return <div className="p-8 text-ink-500">Loading settings…</div>;

  async function installFfmpeg(): Promise<void> {
    setInstalling(true);
    try {
      const result = await invoke('app:installFfmpeg');
      pushToast({ kind: 'success', message: result.message });
    } catch (err) {
      pushToast({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setInstalling(false);
    }
  }

  async function testProxy(): Promise<void> {
    setProxyTest('testing');
    try {
      const result = await invoke('system:testProxy', { proxyUrl });
      setProxyTest(result);
    } catch (err) {
      setProxyTest({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
        latencyMs: null,
      });
    }
  }

  async function set<K extends keyof AppConfig>(key: K, value: AppConfig[K]): Promise<void> {
    try {
      await updateConfig({ [key]: value } as Partial<AppConfig>);
    } catch (err) {
      // Config validation rejects the whole update, so nothing half-applies.
      pushToast({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <div className="mx-auto grid max-w-3xl gap-5 pb-10">
      <PageHeader title="Settings" description="Every change is saved immediately and applies to the next item." />

      <Panel title="Output" description="Where files go, and what they are called.">
        <div className="grid gap-4">
          <Field
            label="Output folder"
            hint="Every download lands here, named by the template below."
          >
            <div className="flex gap-2">
              <div className="min-w-0 flex-1">
                <TextInput readOnly value={config.outputDir} mono ariaLabel="Output folder" />
              </div>
              <Button
                icon="folder"
                onClick={async () => {
                  const { path } = await invoke('system:chooseFolder');
                  if (path) void set('outputDir', path);
                }}
              >
                Choose…
              </Button>
            </div>
          </Field>

          <Field label="Filename template" hint={`Preview: ${previewTemplate(config.filenameTemplate)}`}>
            <TextInput
              value={config.filenameTemplate}
              onChange={(value) => void set('filenameTemplate', value)}
              mono
            />
          </Field>

          <div className="flex flex-wrap gap-1.5">
            {['{n:3}', '{author}', '{id}', '{date}', '{caption:40}', '{index:4}'].map((token) => (
              <button
                key={token}
                onClick={() => void set('filenameTemplate', `${config.filenameTemplate}${token}`)}
                className="rounded-md bg-base-700 px-2 py-1 font-mono text-xs text-ink-300 hover:bg-base-600"
              >
                {token}
              </button>
            ))}
          </div>
          <p className="text-xs text-ink-500">
            <span className="font-mono text-ink-300">{'{n:3}'}</span> numbers each link by its place in the paste
            — 001, 002, 003 — so the folder reads in the order you added them. The padding matters: without it
            Explorer sorts 1, 10, 11, 2.{' '}
            <span className="font-mono text-ink-300">{'{index:4}'}</span> is the same idea but counts across every
            batch, so it never repeats.
          </p>
        </div>
      </Panel>

      <Panel title="Downloading" description="Speed, and what to do when TikTok refuses a request.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Concurrent downloads"
            hint={
              config.concurrency > 1
                ? 'Above 1, completion order no longer matches paste order — faster videos finish first. Downloads still start in order.'
                : 'The main speed lever. Raise it to 3 or 4 for large batches; completion order then stops matching paste order.'
            }
          >
            <NumberInput
              value={config.concurrency}
              min={1}
              max={4}
              suffix="at a time"
              onChange={(value) => void set('concurrency', value)}
            />
          </Field>

          <Field label="Gap between requests" hint="0.5s–10s. Lower risks TikTok throttling your connection.">
            <NumberInput
              value={config.rateLimitMs}
              min={500}
              max={10_000}
              step={100}
              suffix="ms"
              onChange={(value) => void set('rateLimitMs', value)}
            />
          </Field>

          <Field
            label="Use cookies from"
            hint="If a video plays in your browser but the app is refused, that difference is the session — not your connection."
          >
            <Select
              value={config.browserCookies}
              onChange={(value) => void set('browserCookies', value)}
              options={[
                { value: 'none', label: 'No browser (default)' },
                { value: 'chrome', label: 'Chrome' },
                { value: 'edge', label: 'Edge' },
                { value: 'firefox', label: 'Firefox' },
                { value: 'brave', label: 'Brave' },
                { value: 'chromium', label: 'Chromium' },
                { value: 'opera', label: 'Opera' },
                { value: 'vivaldi', label: 'Vivaldi' },
                { value: 'safari', label: 'Safari' },
              ]}
            />
            <p className="mt-2 text-xs text-ink-500">
              Reads that browser&rsquo;s TikTok cookies so requests carry your own session. Close the browser first —
              Chrome and Edge lock their cookie database while running.
            </p>
          </Field>

          <Field
            label="Proxy"
            hint="http(s):// or socks5://. Leave empty for none. Used for resolving links and downloading."
          >
            <div className="flex gap-2">
              <div className="min-w-0 flex-1">
                <TextInput
                  value={config.proxyUrl}
                  onChange={(value) => void set('proxyUrl', value)}
                  placeholder="socks5://127.0.0.1:9050"
                  ariaLabel="Proxy URL"
                />
              </div>
              <Button
                variant="secondary"
                disabled={config.proxyUrl.trim() === '' || proxyTest === 'testing'}
                onClick={() => void testProxy()}
              >
                {proxyTest === 'testing' ? 'Testing…' : 'Test'}
              </Button>
            </div>

            {/* A proxy that parses but does not work is the failure this
                setting invites, so its state is always on screen. */}
            {config.proxyUrl.trim() === '' ? (
              <p className="mt-2 text-xs text-ink-500">
                No proxy — connecting to TikTok directly.
              </p>
            ) : proxyTest === 'testing' ? (
              <p className="mt-2 text-xs text-ink-300">Contacting TikTok through the proxy…</p>
            ) : proxyTest === null ? (
              <p className="mt-2 text-xs text-warn-400">
                Proxy is active but untested — press Test to confirm it reaches TikTok.
              </p>
            ) : (
              <p
                className={`mt-2 flex items-start gap-1.5 text-xs ${
                  proxyTest.ok ? 'text-mint-300' : 'text-danger-400'
                }`}
              >
                <Icon name={proxyTest.ok ? 'check' : 'alert'} size={13} className="mt-0.5" />
                {proxyTest.message}
              </p>
            )}
          </Field>
        </div>
      </Panel>

      <Panel title="Processing" description="What happens to a video after it lands.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Watermark"
            hint="Auto uses a watermark-free source when TikTok offers one, which needs no re-encoding at all."
          >
            <Select
              value={config.watermarkMode}
              onChange={(value) => void set('watermarkMode', value)}
              options={[
                { value: 'auto', label: 'Auto (recommended)' },
                { value: 'force_removal', label: 'Force removal' },
                { value: 'keep', label: 'Keep watermark' },
              ]}
            />
          </Field>

          <Field label="Trailing outro" hint="Never trims videos under 8s, more than 5s, or more than 15% of a video.">
            <Select
              value={config.outroMode}
              onChange={(value) => void set('outroMode', value)}
              options={[
                { value: 'ask', label: 'Ask on first detection' },
                { value: 'always', label: 'Always trim' },
                { value: 'never', label: 'Never trim' },
              ]}
            />
          </Field>
        </div>

        {/* Both of the settings above degrade silently without ffmpeg, which is
            the worst way for a feature to be unavailable: the user sets it,
            nothing happens, and nothing says why. */}
        {ffmpegMissing && (
          <div className="mt-4 rounded-lg border border-warn-400/30 bg-warn-400/10 p-3">
            <p className="text-xs text-warn-400">
              <strong className="font-medium">ffmpeg is not installed.</strong> Watermark-free downloads still
              work — those come from a clean source and need no processing. But filtering a watermark out of the
              pixels, and trimming a TikTok end card, both need ffmpeg.
            </p>

            {install ? (
              <p className="mt-3 text-xs text-ink-300" aria-live="polite">
                {install.phase === 'downloading'
                  ? `Downloading ffmpeg… ${formatBytes(install.receivedBytes)}${
                      install.totalBytes ? ` of ${formatBytes(install.totalBytes)}` : ''
                    }`
                  : install.phase === 'extracting'
                    ? 'Unpacking…'
                    : 'Checking it runs…'}
              </p>
            ) : (
              <div className="mt-3 flex items-center gap-3">
                <Button variant="primary" disabled={installing} onClick={() => void installFfmpeg()}>
                  {installing ? 'Installing…' : 'Install ffmpeg'}
                </Button>
                <span className="text-xs text-ink-500">About 100 MB, once. Nothing else to configure.</span>
              </div>
            )}
          </div>
        )}

        {/* Switches, not checkboxes: each takes effect the moment it is
            pressed, and there is no form to submit. The cost of the two
            expensive ones is stated rather than discovered. */}
        <div className="mt-5 grid gap-4 border-t border-white/5 pt-5">
          {(
            [
              [
                'autoUpdateExtractor',
                'Keep the extractor up to date',
                'A stale extractor is the most common cause of every download failing at once.',
              ],
              [
                'forceIpv4',
                'Force IPv4',
                'TikTok answers some IPv6 clients with 403 while serving the same request over IPv4.',
              ],
              ['audioOnly', 'Extract audio only', 'Saves an M4A instead of the video.'],
              [
                'detectReposts',
                'Detect reposts',
                'Decodes every video a second time to fingerprint it. Noticeably slower.',
              ],
              [
                'hardwareAcceleration',
                'Use hardware encoding when available',
                'Only applies when a video has to be re-encoded at all.',
              ],
              ['reduceEffects', 'Reduce visual effects', 'Turns off the animated background and its 2 MB download.'],
            ] as const
          ).map(([key, label, hint]) => (
            <Toggle
              key={key}
              checked={config[key]}
              onChange={(checked) => void set(key, checked)}
              label={label}
              hint={hint}
            />
          ))}
        </div>
      </Panel>

      <CaptionSettings value={config.captions} onChange={(next) => void set('captions', next)} />

      <Panel
        title="Title and description"
        description="A ready-to-post title and description saved beside each video."
      >
        <Toggle
          checked={config.seoMetadata}
          onChange={(checked) => void set('seoMetadata', checked)}
          label="Write a title and description for each download"
          hint={
            <>
              Saved as a .txt beside the video. Both are taken from what the video actually says — the spoken hook
              becomes the title — never from a template, and never invented. Each one comes with the SEO checks it
              passed and failed, so a weak title is a five-second edit rather than a guess. Needs captions on, or at
              least a TikTok caption track, to have a transcript to work from.
            </>
          }
        />
      </Panel>

      <Panel title="Engine" description="The tools doing the work, and their versions.">
        <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-ink-500">App</dt>
          <dd className="font-mono text-ink-300">{versions?.app ?? '—'}</dd>
          <dt className="text-ink-500">Extractor</dt>
          <dd className="flex items-center gap-3 font-mono text-ink-300">
            {versions?.ytDlp ?? 'not installed'}
            <Button
              disabled={updating}
              onClick={async () => {
                setUpdating(true);
                try {
                  const result = await invoke('app:updateExtractor');
                  pushToast({ kind: 'success', message: result.message });
                } catch (err) {
                  pushToast({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
                } finally {
                  setUpdating(false);
                }
              }}
            >
              {updating ? 'Updating…' : 'Update extractor'}
            </Button>
          </dd>
          <dt className="text-ink-500">ffmpeg</dt>
          <dd className="font-mono text-ink-300">{versions?.ffmpeg ?? 'not installed'}</dd>
          <dt className="text-ink-500">ffmpeg licence</dt>
          <dd className={capabilities?.isGplBuild ? 'text-danger-400' : 'text-ink-300'}>
            {capabilities?.isGplBuild === null || capabilities === null
              ? 'unknown'
              : capabilities.isGplBuild
                ? 'GPL build — must not be shipped commercially'
                : 'LGPL'}
          </dd>
        </dl>

        {capabilities && capabilities.missingRequired.length > 0 && (
          <p className="mt-3 rounded-lg border border-warn-400/30 bg-warn-400/10 p-3 text-xs text-warn-400">
            This ffmpeg build is missing: {capabilities.missingRequired.join(', ')}. Watermark removal will not work
            until it is replaced.
          </p>
        )}
      </Panel>
    </div>
  );
}
