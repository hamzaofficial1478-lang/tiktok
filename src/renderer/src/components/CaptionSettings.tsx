import type { CaptionSettings as CaptionSettingsValue } from '@shared/caption-schema';
import { CAPTION_ANIMATIONS, CAPTION_POSITIONS, translationIsSupported } from '@shared/caption-schema';
import { useEffect, useState } from 'react';
import { Panel } from './primitives';
import { Icon } from './icons';
import { ColourInput, Field, SegmentedControl, Select, Slider, Toggle } from './form';
import { Button } from './primitives';
import { invoke, subscribe } from '../lib/ipc';
import { needsWordTimings } from '@shared/caption-schema';

/**
 * The caption controls.
 *
 * Grouped by the question being answered rather than by the shape of the data:
 * whether captions happen at all, where the words come from, and what they look
 * like. The style controls are hidden entirely when captions are off — a panel
 * of colour pickers for a feature that is not running is noise the eye has to
 * step over every time.
 *
 * It lives on the Add Links screen rather than in Settings, and that was a
 * correction. Captions are a decision about the batch being queued, not a
 * preference set once and forgotten: nobody opens Settings on their way to
 * pasting links, so a caption control in Settings is a caption control nobody
 * uses. The mode is on screen where the links go in, and the two dozen styling
 * controls stay folded away until someone wants them.
 */

/**
 * The four at the end need word timings, so they are marked.
 *
 * Hiding them until a video happens to have been transcribed would mean the
 * best-looking options are the ones nobody discovers; saying what they need is
 * better than pretending they are unavailable.
 */
const ANIMATION_LABELS: Record<string, string> = {
  none: 'None — a hard cut',
  fade: 'Fade in and out',
  pop: 'Pop — scales up',
  rise: 'Rise — drifts upward',
  slide: 'Slide — in from the left',
  bounce: 'Bounce — overshoots and settles',
  typewriter: 'Typewriter — wipes in',
  karaoke: 'Karaoke — sweeps word by word (needs transcription)',
  'word-pop': 'Word pop — each word scales in (needs transcription)',
  highlight: 'Highlight — colours the word being said (needs transcription)',
  'one-word': 'One word at a time (needs transcription)',
};

const LANGUAGES: readonly { value: string; label: string }[] = [
  { value: 'auto', label: 'Same language as the video' },
  { value: 'en', label: 'Translate to English' },
];

export function CaptionSettings({
  value,
  onChange,
}: {
  value: CaptionSettingsValue;
  onChange: (next: CaptionSettingsValue) => void;
}): React.JSX.Element {
  const set = <K extends keyof CaptionSettingsValue>(key: K, next: CaptionSettingsValue[K]): void =>
    onChange({ ...value, [key]: next });
  const setStyle = <K extends keyof CaptionSettingsValue['style']>(
    key: K,
    next: CaptionSettingsValue['style'][K],
  ): void => onChange({ ...value, style: { ...value.style, [key]: next } });

  const on = value.mode !== 'off';
  const [styleOpen, setStyleOpen] = useState(false);
  const [whisper, setWhisper] = useState<{ installed: boolean; model: string | null } | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);

  useEffect(() => {
    void invoke('app:whisperStatus').then(setWhisper);
    return subscribe('whisper:installProgress', (event) => {
      const megabytes = (bytes: number): string => `${(bytes / 1_048_576).toFixed(0)} MB`;
      setInstalling(
        event.phase === 'downloading-model' || event.phase === 'downloading-program'
          ? `${event.message} — ${megabytes(event.receivedBytes)}${
              event.totalBytes ? ` of ${megabytes(event.totalBytes)}` : ''
            }`
          : event.message,
      );
      if (event.phase === 'done') {
        setInstalling(null);
        void invoke('app:whisperStatus').then(setWhisper);
      }
    });
  }, []);

  const wordLevel = needsWordTimings(value.style.animation);

  return (
    <Panel
      title="Captions"
      description="Subtitles on the videos you are about to download, from TikTok's own track or transcribed."
    >
      <div className="grid gap-5">
        <Field
          label="Mode"
          hint={
            value.mode === 'burn'
              ? 'Painted into the picture: survives any re-upload, cannot be switched off, and re-encodes the video.'
              : value.mode === 'soft'
                ? 'Added as a subtitle track: no re-encoding and no quality lost, but players and platforms that ignore subtitle tracks will not show them.'
                : 'No captions are added and nothing extra is downloaded.'
          }
        >
          <SegmentedControl
            ariaLabel="Caption mode"
            value={value.mode}
            onChange={(mode) => set('mode', mode)}
            options={[
              { value: 'off', label: 'Off' },
              { value: 'soft', label: 'Subtitle track' },
              { value: 'burn', label: 'Burned in' },
            ]}
          />
        </Field>

        {on && (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Where the words come from"
                hint="TikTok's own captions are instant and already correct. Transcribing is only used when there are none."
              >
                <Select
                  value={value.source}
                  onChange={(source) => set('source', source)}
                  options={[
                    { value: 'auto', label: "TikTok's captions, then transcribe" },
                    { value: 'tiktok', label: "Only TikTok's captions" },
                    { value: 'transcribe', label: 'Always transcribe' },
                  ]}
                />
              </Field>

              <Field
                label="Language"
                hint={
                  translationIsSupported(value)
                    ? 'Offline transcription can translate into English. Other target languages are not supported, so they are not offered.'
                    : `Nothing can translate into ${value.targetLanguage} offline.`
                }
              >
                <Select
                  value={value.targetLanguage}
                  onChange={(language) => set('targetLanguage', language)}
                  options={LANGUAGES}
                />
              </Field>
            </div>

            {/**
             * The transcriber, offered where it matters rather than in
             * Settings: this is the panel where someone picks a word-by-word
             * animation, and that is the moment they need to know it requires
             * one. Never installed on its own — it is a 150 MB download.
             */}
            {whisper && !whisper.installed && (
              <div
                className={`rounded-lg border p-3 ${
                  wordLevel ? 'border-warn-400/30 bg-warn-400/8' : 'border-white/8 bg-base-900/40'
                }`}
              >
                <p className="text-xs text-ink-300">
                  <strong className="font-medium text-ink-100">Offline transcription is not installed.</strong>{' '}
                  {wordLevel
                    ? 'The animation you picked needs to know when each word is spoken, which only transcription produces. Without it this style falls back to a plain fade.'
                    : "TikTok's own captions cover most videos. Transcription fills in the rest, and unlocks the word-by-word animations."}{' '}
                  It runs entirely on this machine — no account, no key, nothing sent anywhere.
                </p>

                {installing ? (
                  <p className="mt-2 text-xs text-ink-300" aria-live="polite">
                    {installing}
                  </p>
                ) : (
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    <Button
                      variant={wordLevel ? 'primary' : 'secondary'}
                      size="sm"
                      onClick={() => {
                        setInstalling('starting…');
                        void invoke('app:installWhisper', { model: 'base.en' }).then((result) => {
                          setInstalling(null);
                          setWhisper({ installed: result.installed, model: result.model });
                        });
                      }}
                    >
                      Install transcriber
                    </Button>
                    <span className="text-xs text-ink-500">About 150 MB, once. English model.</span>
                  </div>
                )}
              </div>
            )}

            {whisper?.installed && wordLevel && (
              <p className="text-xs text-mint-300">
                Transcription is installed ({whisper.model}), so this animation has the word timings it needs.
              </p>
            )}

            <button
              type="button"
              onClick={() => setStyleOpen(!styleOpen)}
              aria-expanded={styleOpen}
              className="flex items-center gap-2 border-t border-white/5 pt-4 text-left text-sm font-medium
                text-ink-300 transition-colors hover:text-ink-100"
            >
              <span
                className={`transition-transform ${styleOpen ? 'rotate-90' : ''}`}
                aria-hidden="true"
              >
                <Icon name="play" size={11} />
              </span>
              {styleOpen ? 'Hide styling' : 'Styling — colour, size, position, animation'}
            </button>

            {styleOpen && (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Text colour">
                <ColourInput value={value.style.textColour} onChange={(colour) => setStyle('textColour', colour)} />
              </Field>
              <Field label="Outline colour">
                <ColourInput
                  value={value.style.outlineColour}
                  onChange={(colour) => setStyle('outlineColour', colour)}
                />
              </Field>

              <Field label="Size" hint="A share of the video's height, so it looks the same at any resolution.">
                <Slider
                  value={value.style.fontSizePct}
                  min={2}
                  max={12}
                  step={0.5}
                  format={(size) => `${size}%`}
                  onChange={(size) => setStyle('fontSizePct', size)}
                />
              </Field>

              <Field label="Outline thickness">
                <Slider
                  value={value.style.outlinePct}
                  min={0}
                  max={30}
                  format={(width) => (width === 0 ? 'none' : `${width}%`)}
                  onChange={(width) => setStyle('outlinePct', width)}
                />
              </Field>

              <Field
                label="Background"
                hint={
                  value.style.backgroundOpacity === 0
                    ? 'No box — outlined text only. Harder to read over a bright or busy shot.'
                    : 'A box behind the text, which is what keeps captions readable over anything.'
                }
              >
                <Slider
                  value={value.style.backgroundOpacity}
                  min={0}
                  max={100}
                  format={(opacity) => (opacity === 0 ? 'none' : `${opacity}%`)}
                  onChange={(opacity) => setStyle('backgroundOpacity', opacity)}
                />
              </Field>

              <Field label="Background colour">
                <ColourInput
                  value={value.style.backgroundColour}
                  onChange={(colour) => setStyle('backgroundColour', colour)}
                />
              </Field>

              <Field
                label="Position"
                hint="TikTok's own caption and buttons sit along the bottom and right, so a low caption competes with them."
              >
                <SegmentedControl
                  ariaLabel="Caption position"
                  value={value.style.position}
                  onChange={(position) => setStyle('position', position)}
                  options={CAPTION_POSITIONS.map((position) => ({
                    value: position,
                    label: position.charAt(0).toUpperCase() + position.slice(1),
                  }))}
                />
              </Field>

              <Field label="Distance from that edge">
                <Slider
                  value={value.style.marginPct}
                  min={0}
                  max={40}
                  format={(margin) => `${margin}%`}
                  onChange={(margin) => setStyle('marginPct', margin)}
                />
              </Field>

              <Field label="Animation" hint="How each line arrives. Costs nothing extra — it happens as it is drawn.">
                <Select
                  value={value.style.animation}
                  onChange={(animation) => setStyle('animation', animation)}
                  options={CAPTION_ANIMATIONS.map((animation) => ({
                    value: animation,
                    label: ANIMATION_LABELS[animation] ?? animation,
                  }))}
                />
              </Field>

              <Field
                label="Highlight colour"
                hint="What a word turns as it is spoken, for the word-by-word styles."
              >
                <ColourInput
                  value={value.style.highlightColour}
                  onChange={(colour) => setStyle('highlightColour', colour)}
                />
              </Field>

              <Field label="Letter spacing">
                <Slider
                  value={value.style.letterSpacingPct}
                  min={-5}
                  max={30}
                  format={(spacing) => `${spacing}%`}
                  onChange={(spacing) => setStyle('letterSpacingPct', spacing)}
                />
              </Field>

              <Field label="Tilt" hint="A few degrees reads as hand-placed; more reads as a mistake.">
                <Slider
                  value={value.style.rotation}
                  min={-15}
                  max={15}
                  format={(angle) => `${angle}°`}
                  onChange={(angle) => setStyle('rotation', angle)}
                />
              </Field>

              <Field label="Drop shadow">
                <Slider
                  value={value.style.shadowPct}
                  min={0}
                  max={30}
                  format={(shadow) => (shadow === 0 ? 'none' : `${shadow}%`)}
                  onChange={(shadow) => setStyle('shadowPct', shadow)}
                />
              </Field>

              <Field label="Lines at a time" hint="Longer cues are wrapped, and never past the edge of the frame.">
                <Slider
                  value={value.style.maxLines}
                  min={1}
                  max={4}
                  onChange={(lines) => setStyle('maxLines', lines)}
                />
              </Field>
            </div>

                <div className="grid gap-4 border-t border-white/5 pt-5">
                  <Toggle
                    checked={value.style.bold}
                    onChange={(bold) => setStyle('bold', bold)}
                    label="Bold"
                    hint="Bold text holds up over moving footage; regular weight disappears into it."
                  />
                  <Toggle
                    checked={value.style.uppercase}
                    onChange={(upper) => setStyle('uppercase', upper)}
                    label="Uppercase"
                    hint="Louder, and harder to read in long lines."
                  />
                </div>

                <CaptionPreview value={value} />
              </>
            )}
          </>
        )}
      </div>
    </Panel>
  );
}

/**
 * A live sample, drawn in the browser rather than by ffmpeg.
 *
 * Approximate on purpose — libass does the real rendering and this is CSS — but
 * it answers the questions the controls actually raise: is that readable, is it
 * too big, is the box too dark. Waiting for a download to find out would make
 * every one of these settings a guess.
 */
function CaptionPreview({ value }: { value: CaptionSettingsValue }): React.JSX.Element {
  const { style } = value;
  const text = style.uppercase ? 'THIS IS HOW YOUR CAPTIONS WILL LOOK' : 'This is how your captions will look';

  return (
    <div>
      <p className="mb-2 text-sm font-medium text-ink-100">Preview</p>
      <div
        className="relative mx-auto aspect-9/16 w-40 overflow-hidden rounded-lg border border-white/10
          bg-[linear-gradient(140deg,#3b3b58,#7c5cff_45%,#1c1c2b)]"
        aria-hidden="true"
      >
        <div
          className="absolute inset-x-2 flex justify-center"
          style={{
            top: style.position === 'top' ? `${style.marginPct}%` : undefined,
            bottom: style.position === 'bottom' ? `${style.marginPct}%` : undefined,
            ...(style.position === 'middle' ? { top: '50%', transform: 'translateY(-50%)' } : {}),
          }}
        >
          <span
            className="text-center leading-tight"
            style={{
              // The preview is 40 units wide against a 1080-wide frame, so the
              // percentage has to resolve against the preview's own height.
              fontSize: `${(style.fontSizePct / 100) * 284}px`,
              color: style.textColour,
              fontWeight: style.bold ? 700 : 400,
              padding: '0.1em 0.3em',
              backgroundColor:
                style.backgroundOpacity > 0
                  ? `${style.backgroundColour}${Math.round((style.backgroundOpacity / 100) * 255)
                      .toString(16)
                      .padStart(2, '0')}`
                  : 'transparent',
              textShadow:
                style.outlinePct > 0
                  ? `0 0 ${style.outlinePct / 8}px ${style.outlineColour}, 0 0 ${style.outlinePct / 4}px ${
                      style.outlineColour
                    }`
                  : 'none',
            }}
          >
            {text}
          </span>
        </div>
      </div>
      <p className="mt-2 text-center text-xs text-ink-500">Approximate — the real rendering is done by ffmpeg.</p>
    </div>
  );
}
