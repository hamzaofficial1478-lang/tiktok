/**
 * The icon set, drawn inline.
 *
 * No icon library and no font: an icon font is a network request this app has
 * no business making, and a library would pull a few hundred glyphs to use
 * eight. These are hand-drawn on a 24-unit grid with a 1.75 stroke, which is
 * what makes them look like one family rather than eight separate drawings.
 *
 * Everything is `currentColor`, so an icon inherits the colour of the text it
 * sits beside and never needs a variant per state.
 */

export type IconName =
  | 'add'
  | 'queue'
  | 'library'
  | 'history'
  | 'settings'
  | 'logs'
  | 'activity'
  | 'play'
  | 'pause'
  | 'retry'
  | 'trash'
  | 'folder'
  | 'check'
  | 'alert'
  | 'link'
  | 'user'
  | 'file'
  | 'caption'
  | 'search';

const PATHS: Record<IconName, React.ReactNode> = {
  add: (
    <>
      <path d="M12 5v14M5 12h14" />
    </>
  ),
  queue: (
    <>
      <path d="M4 6h16M4 12h16M4 18h9" />
    </>
  ),
  library: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M10 9l5 3-5 3V9z" />
    </>
  ),
  history: (
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v4h4" />
      <path d="M12 8v4l3 2" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" />
    </>
  ),
  logs: (
    <>
      <path d="M5 4h9l5 5v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" />
      <path d="M14 4v5h5M8 13h8M8 17h5" />
    </>
  ),
  /** A pulse trace: what the app is doing, as opposed to the log's document. */
  activity: <path d="M3 12h4l2.5-7 4 14L16.5 12H21" />,
  play: <path d="M7 4l13 8-13 8V4z" />,
  pause: <path d="M8 5v14M16 5v14" />,
  retry: (
    <>
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <path d="M21 4v4h-4" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      <path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
    </>
  ),
  folder: <path d="M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7z" />,
  check: <path d="M4 12.5l5 5L20 6.5" />,
  alert: (
    <>
      <path d="M12 3l9.5 17H2.5L12 3z" />
      <path d="M12 10v4M12 17.5v.01" />
    </>
  ),
  link: (
    <>
      <path d="M10 13a4 4 0 0 0 5.7.3l3-3a4 4 0 0 0-5.7-5.7l-1.5 1.5" />
      <path d="M14 11a4 4 0 0 0-5.7-.3l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 3.6-6 8-6s8 2 8 6" />
    </>
  ),
  file: (
    <>
      <path d="M6 3h8l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
      <path d="M14 3v5h5" />
    </>
  ),
  caption: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M8 11.5a2 2 0 1 0 0 2M16 11.5a2 2 0 1 0 0 2" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-4.5-4.5" />
    </>
  ),
};

export function Icon({
  name,
  size = 18,
  className = '',
}: {
  name: IconName;
  size?: number;
  className?: string;
}): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      // Decorative by default: every icon in this app sits next to its own
      // label, so announcing it again would just make the label stutter.
      aria-hidden="true"
      focusable="false"
      className={`shrink-0 ${className}`}
    >
      {PATHS[name]}
    </svg>
  );
}
