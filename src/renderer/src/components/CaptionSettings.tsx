import type { CaptionSettings as CaptionSettingsValue } from '@shared/caption-schema';
import { CAPTION_ANIMATIONS, CAPTION_POSITIONS, translationIsSupported } from '@shared/caption-schema';
import { Panel } from './primitives';
import { ColourInput, Field, SegmentedControl, Select, Slider, Toggle } from './form';

/**
 * The caption controls.
 *
 * Grouped by the question being answered rather than by the shape of the data:
 * whether captions happen at all, where the words come from, and what they look
 * like. The style controls are hidden entirely when captions are off — a panel
 * of colour pickers for a feature that is not running is noise the eye has to
 * step over on every visit to this screen.
 */

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

  return (
    <Panel title="Captions" description="Subtitles on the downloaded video, from TikTok's own track or transcribed.">
      <div className="grid gap-5">
        <Field
          label="Captions"
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

            <div className="grid gap-4 border-t border-white/5 pt-5 sm:grid-cols-2">
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
                    label: {
                      none: 'None — a hard cut',
                      fade: 'Fade in and out',
                      pop: 'Pop — scales up',
                      rise: 'Rise — drifts upward',
                    }[animation],
                  }))}
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
