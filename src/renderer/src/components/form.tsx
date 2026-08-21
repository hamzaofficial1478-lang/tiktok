import { useId, type ChangeEvent, type ReactNode } from 'react';

/**
 * Form controls.
 *
 * These were inline strings repeated down the Settings screen, which is how a
 * UI drifts: the fourth input gets a slightly different border, nobody notices,
 * and the screen stops reading as one thing. Every control now comes from here,
 * so the caption style panel and the proxy field are the same object.
 *
 * Labels are wired with a generated id rather than by wrapping the control.
 * Wrapping works for a text input and quietly fails for anything custom, and a
 * settings screen full of controls a screen reader cannot name is a settings
 * screen only some people can use.
 */

const CONTROL =
  'w-full rounded-lg border border-white/8 bg-base-900/60 px-3 py-2 text-sm text-ink-100 ' +
  'transition-colors placeholder:text-ink-500/60 focus:border-accent-500/50 focus:outline-none ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

export function Field({
  label,
  hint,
  children,
  htmlFor,
  className = '',
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={`grid gap-1.5 ${className}`}>
      <label htmlFor={htmlFor} className="text-sm font-medium text-ink-100">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs leading-relaxed text-ink-500">{hint}</p>}
    </div>
  );
}

export function TextInput({
  value,
  onChange,
  placeholder,
  readOnly,
  disabled,
  mono,
  id,
  ariaLabel,
  className = '',
}: {
  value: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  readOnly?: boolean;
  disabled?: boolean;
  mono?: boolean;
  id?: string;
  ariaLabel?: string;
  className?: string;
}): React.JSX.Element {
  return (
    <input
      id={id}
      value={value}
      readOnly={readOnly}
      disabled={disabled}
      placeholder={placeholder}
      aria-label={ariaLabel}
      spellCheck={false}
      onChange={(event: ChangeEvent<HTMLInputElement>) => onChange?.(event.target.value)}
      className={`${CONTROL} ${mono ? 'font-mono text-xs' : ''} ${className}`}
    />
  );
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
  id,
}: {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  id?: string;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <input
        id={id}
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => {
          const next = Number(event.target.value);
          // A cleared field parses as NaN; keeping the old value is better than
          // writing one and making the setting jump while it is being typed.
          if (Number.isFinite(next)) onChange(Math.min(max, Math.max(min, next)));
        }}
        className={`${CONTROL} w-24`}
      />
      {suffix && <span className="whitespace-nowrap text-xs text-ink-500">{suffix}</span>}
    </div>
  );
}

/**
 * A slider with its value shown.
 *
 * A range with no readout is a control you can only aim, which is useless for
 * anything measured — "font size 5%" is a number someone wants to reproduce.
 */
export function Slider({
  value,
  onChange,
  min,
  max,
  step = 1,
  format,
  id,
}: {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  format?: (value: number) => string;
  id?: string;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-3">
      <input
        id={id}
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-white/10 accent-accent-500"
      />
      <span className="w-14 shrink-0 text-right text-xs tabular-nums text-ink-300">
        {format ? format(value) : value}
      </span>
    </div>
  );
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  id,
}: {
  value: T;
  onChange: (value: T) => void;
  options: readonly { readonly value: T; readonly label: string }[];
  id?: string;
}): React.JSX.Element {
  return (
    <select
      id={id}
      value={value}
      onChange={(event) => onChange(event.target.value as T)}
      className={`${CONTROL} cursor-pointer`}
    >
      {options.map((option) => (
        // Explicitly coloured: a native option list inherits the system palette
        // on Windows and renders black-on-black inside a dark app.
        <option key={option.value} value={option.value} className="bg-base-800 text-ink-100">
          {option.label}
        </option>
      ))}
    </select>
  );
}

/**
 * A switch, not a checkbox.
 *
 * `role="switch"` rather than a styled checkbox because that is what it is: a
 * setting that takes effect immediately, with no form to submit.
 */
/**
 * The switch on its own, with no label beside it.
 *
 * Split out of `Toggle` for the places where the thing being switched is
 * already named by the row it sits in — a creator's handle, say. Those need the
 * control without a second copy of the name, and they need a title and an
 * accessible name that a screen reader can still read out.
 */
export function Switch({
  checked,
  onChange,
  disabled,
  label,
  title,
  id,
  className = '',
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Accessible name. Required, because a bare switch has nothing else to read. */
  label: string;
  title?: string;
  id?: string;
  className?: string;
}): React.JSX.Element {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors
        disabled:cursor-not-allowed disabled:opacity-40 ${checked ? 'bg-accent-500' : 'bg-base-600'} ${className}`}
    >
      <span
        className={`size-4 rounded-full bg-white shadow-sm transition-transform ${
          checked ? 'translate-x-4' : 'translate-x-0'
        }`}
      />
    </button>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint?: ReactNode;
  disabled?: boolean;
}): React.JSX.Element {
  const id = useId();

  return (
    <div className="flex items-start gap-3">
      <Switch id={id} checked={checked} onChange={onChange} disabled={disabled} label={label} className="mt-0.5" />
      <div className="min-w-0">
        <label htmlFor={id} className="cursor-pointer text-sm font-medium text-ink-100">
          {label}
        </label>
        {hint && <p className="mt-0.5 text-xs leading-relaxed text-ink-500">{hint}</p>}
      </div>
    </div>
  );
}

/**
 * A small set of mutually exclusive choices, all visible at once.
 *
 * Preferred over a dropdown wherever there are four options or fewer: the whole
 * choice is readable without opening anything, and on a settings screen the
 * options are usually the explanation.
 */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: T;
  onChange: (value: T) => void;
  options: readonly { readonly value: T; readonly label: string; readonly hint?: string }[];
  ariaLabel: string;
}): React.JSX.Element {
  const detailed = options.some((option) => option.hint !== undefined);

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={`flex gap-1 rounded-xl border border-white/8 bg-base-900/40 p-1 ${detailed ? '' : 'inline-flex'}`}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(option.value)}
          className={`rounded-lg px-3 py-2 text-left transition ${detailed ? 'flex-1' : ''} ${
            value === option.value
              ? 'bg-accent-500/15 text-ink-100 ring-1 ring-accent-500/40'
              : 'text-ink-400 hover:bg-white/4 hover:text-ink-300'
          }`}
        >
          <span className="block text-sm font-medium">{option.label}</span>
          {option.hint && <span className="mt-0.5 block text-xs text-ink-500">{option.hint}</span>}
        </button>
      ))}
    </div>
  );
}

/**
 * A colour well with a hex field beside it.
 *
 * The picker alone cannot be read back or typed into, and a hex field alone is
 * unusable for choosing. Together they cover both ways people pick a colour.
 */
export function ColourInput({
  value,
  onChange,
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  id?: string;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <input
        id={id}
        type="color"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="size-9 shrink-0 cursor-pointer rounded-lg border border-white/10 bg-transparent p-0.5"
      />
      <input
        value={value.toUpperCase()}
        onChange={(event) => {
          const next = event.target.value.trim();
          // Only committed once it is a whole colour, so the value never spends
          // a keystroke as "#ff" and resets the well to black.
          if (/^#[0-9a-fA-F]{6}$/.test(next)) onChange(next.toLowerCase());
        }}
        spellCheck={false}
        className={`${CONTROL} w-28 font-mono text-xs uppercase`}
      />
    </div>
  );
}
