import { useEffect, useState, type ReactNode } from 'react';
import type { AppConfig } from '@shared/config-schema';
import type { InvokeResponse } from '@shared/ipc/contract';
import { previewTemplate } from '@shared/filename-template';
import { useAppStore } from '../store/app-store';
import { invoke } from '../lib/ipc';
import { Button, Panel } from '../components/primitives';

/** Settings — section 10. Every control writes through the single AppConfig. */
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }): React.JSX.Element {
  return (
    <label className="grid gap-1.5">
      <span className="text-sm font-medium text-ink-100">{label}</span>
      {children}
      {hint && <span className="text-xs text-ink-500">{hint}</span>}
    </label>
  );
}

type ProxyTestState = InvokeResponse<'system:testProxy'> | 'testing' | null;

const inputClass =
  'rounded-lg border border-white/8 bg-base-900/60 px-3 py-2 text-sm text-ink-100 focus:border-accent-500/50 focus:outline-none';

export function Settings(): React.JSX.Element {
  const config = useAppStore((s) => s.config);
  const updateConfig = useAppStore((s) => s.updateConfig);
  const pushToast = useAppStore((s) => s.pushToast);
  const versions = useAppStore((s) => s.versions);
  const capabilities = useAppStore((s) => s.capabilities);
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
      <Panel title="Output">
        <div className="grid gap-4">
          <Field label="Output folder" hint={config.outputDir || 'Not chosen yet'}>
            <div className="flex gap-2">
              <input readOnly value={config.outputDir} className={`${inputClass} flex-1`} />
              <Button
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
            <input
              value={config.filenameTemplate}
              onChange={(event) => void set('filenameTemplate', event.target.value)}
              className={inputClass}
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

      <Panel title="Downloading">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Concurrent downloads"
            hint={
              config.concurrency > 1
                ? 'Above 1, completion order no longer matches paste order — faster videos finish first. Downloads still start in order.'
                : 'The main speed lever. Raise it to 3 or 4 for large batches; completion order then stops matching paste order.'
            }
          >
            <input
              type="number"
              min={1}
              max={4}
              value={config.concurrency}
              onChange={(event) => void set('concurrency', Number(event.target.value))}
              className={inputClass}
            />
          </Field>

          <Field label="Gap between requests (ms)" hint="0.5s–10s. Lower risks TikTok throttling your connection.">
            <input
              type="number"
              min={500}
              max={10_000}
              step={100}
              value={config.rateLimitMs}
              onChange={(event) => void set('rateLimitMs', Number(event.target.value))}
              className={inputClass}
            />
          </Field>

          <Field
            label="Proxy"
            hint="http(s):// or socks5://. Leave empty for none. Used for resolving links and downloading."
          >
            <div className="flex gap-2">
              <input
                value={config.proxyUrl}
                onChange={(event) => void set('proxyUrl', event.target.value)}
                placeholder="socks5://127.0.0.1:9050"
                className={`${inputClass} min-w-0 flex-1`}
              />
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
              <p className={`mt-2 text-xs ${proxyTest.ok ? 'text-mint-300' : 'text-danger-400'}`}>
                {proxyTest.ok ? '✓ ' : '✕ '}
                {proxyTest.message}
              </p>
            )}
          </Field>
        </div>
      </Panel>

      <Panel title="Processing">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Watermark"
            hint="Auto uses a watermark-free source when TikTok offers one, which needs no re-encoding at all."
          >
            <select
              value={config.watermarkMode}
              onChange={(event) => void set('watermarkMode', event.target.value as typeof config.watermarkMode)}
              className={inputClass}
            >
              <option value="auto">Auto (recommended)</option>
              <option value="force_removal">Force removal</option>
              <option value="keep">Keep watermark</option>
            </select>
          </Field>

          <Field label="Trailing outro" hint="Never trims videos under 8s, more than 5s, or more than 15% of a video.">
            <select
              value={config.outroMode}
              onChange={(event) => void set('outroMode', event.target.value as typeof config.outroMode)}
              className={inputClass}
            >
              <option value="ask">Ask on first detection</option>
              <option value="always">Always trim</option>
              <option value="never">Never trim</option>
            </select>
          </Field>
        </div>

        <div className="mt-4 grid gap-2">
          {(
            [
              ['autoUpdateExtractor', 'Keep the extractor up to date automatically'],
              ['audioOnly', 'Extract audio only (MP3/M4A)'],
              ['detectReposts', 'Detect reposts (slower: decodes each video again)'],
              ['hardwareAcceleration', 'Use hardware encoding when available'],
              ['reduceEffects', 'Reduce visual effects'],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="flex items-center gap-2 text-sm text-ink-300">
              <input
                type="checkbox"
                checked={config[key]}
                onChange={(event) => void set(key, event.target.checked)}
                className="size-4 accent-accent-500"
              />
              {label}
            </label>
          ))}
        </div>
      </Panel>

      <Panel title="Engine">
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
