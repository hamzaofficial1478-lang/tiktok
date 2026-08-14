import { Icon, type IconName } from './icons';

/**
 * The primary navigation.
 *
 * It was six text buttons in a 40px header strip, competing for that strip with
 * the app name, the proxy indicator, the pending-questions button and the queue
 * state — and with a status bar added at the bottom, the content had a band of
 * chrome above and below it and nowhere to grow.
 *
 * A rail solves the actual problem rather than shuffling it: vertical space is
 * what this app has spare and horizontal space is what it does not, each
 * destination gets an icon and room for a count without abbreviating, and the
 * seventh screen will fit as easily as the sixth. It also puts navigation in
 * the place a desktop application of this kind puts it, which is worth more
 * than any argument about pixels.
 */

export interface NavItem<T extends string> {
  readonly id: T;
  readonly label: string;
  readonly icon: IconName;
  /** Shown as a pill; omitted at zero rather than shown as "0". */
  readonly count?: number;
  /** Draws attention without a number — used for questions waiting. */
  readonly alert?: boolean;
}

export function Sidebar<T extends string>({
  items,
  current,
  onSelect,
  footer,
}: {
  items: readonly NavItem<T>[];
  current: T;
  onSelect: (id: T) => void;
  footer?: React.ReactNode;
}): React.JSX.Element {
  return (
    <aside className="flex w-52 shrink-0 flex-col border-r border-white/6 bg-base-950/50">
      <div className="flex items-center gap-2.5 px-4 py-4">
        {/* The mark: a play triangle inside a rounded square, in the app's own
            violet rather than anything resembling TikTok's brand. */}
        <span className="grid size-8 place-items-center rounded-lg bg-accent-500/15 text-accent-300">
          <Icon name="play" size={15} />
        </span>
        <span className="text-sm font-semibold leading-tight tracking-tight text-ink-100">
          TikTok
          <br />
          Downloader
        </span>
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 px-2 py-2" aria-label="Screens">
        {items.map((item) => {
          const active = item.id === current;
          return (
            <button
              key={item.id}
              onClick={() => onSelect(item.id)}
              aria-current={active ? 'page' : undefined}
              className={`group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                active ? 'bg-white/8 text-ink-100' : 'text-ink-500 hover:bg-white/4 hover:text-ink-300'
              }`}
            >
              {/* The active marker is a bar, not a colour change alone: colour
                  is the one cue some people cannot use. */}
              <span
                className={`absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full transition-opacity ${
                  active ? 'bg-accent-400 opacity-100' : 'opacity-0'
                }`}
                aria-hidden="true"
              />
              <Icon name={item.icon} size={17} className={active ? 'text-accent-300' : ''} />
              <span className="flex-1 text-left">{item.label}</span>

              {item.count !== undefined && item.count > 0 && (
                <span className="rounded bg-base-700 px-1.5 py-0.5 text-[10px] tabular-nums text-ink-300">
                  {item.count > 999 ? '999+' : item.count}
                </span>
              )}
              {item.alert && (
                <span className="size-1.5 rounded-full bg-warn-400" aria-label="Needs attention" role="img" />
              )}
            </button>
          );
        })}
      </nav>

      {footer && <div className="border-t border-white/6 px-3 py-3">{footer}</div>}
    </aside>
  );
}
