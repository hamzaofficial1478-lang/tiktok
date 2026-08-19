/**
 * The remaining count, drawn small enough to read on a taskbar button.
 *
 * Rendered here rather than in the main process for one blunt reason: Windows
 * wants an image, not a number, and the only thing in an Electron app that can
 * turn text into pixels without adding a dependency is the window.
 */

/** Windows draws the overlay at 16×16; twice that keeps it sharp when scaled. */
const SIZE = 32;

/**
 * What the badge says for a given count.
 *
 * Three digits do not fit legibly in sixteen pixels, so anything past 99 is
 * "99+". The exact number is on screen in the app; the badge exists to answer
 * "is it still going, and roughly how much is left" from across the room.
 */
export function badgeLabel(remaining: number): string {
  if (remaining <= 0) return '';
  return remaining > 99 ? '99+' : String(remaining);
}

export interface BadgeColours {
  /** Circle fill. Red when something failed, otherwise the accent. */
  readonly background: string;
  readonly text: string;
}

export function badgeColours(hasFailures: boolean): BadgeColours {
  return hasFailures ? { background: '#d1493f', text: '#ffffff' } : { background: '#5b6ef5', text: '#ffffff' };
}

/**
 * Draws the badge and returns a PNG data URL, or null when there is nothing
 * to show.
 *
 * Returns null rather than a blank image for zero, so the caller has one
 * obvious way to mean "clear it".
 */
export function drawBadge(remaining: number, hasFailures: boolean): string | null {
  const label = badgeLabel(remaining);
  if (label === '') return null;

  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const { background, text } = badgeColours(hasFailures);

  ctx.beginPath();
  ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2 - 1, 0, Math.PI * 2);
  ctx.fillStyle = background;
  ctx.fill();
  // A rim, so the badge stays visible against both light and dark taskbars.
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.stroke();

  // Three characters need to be smaller than one or two to fit the circle.
  ctx.font = `600 ${label.length > 2 ? 14 : 19}px system-ui, sans-serif`;
  ctx.fillStyle = text;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, SIZE / 2, SIZE / 2 + 1);

  return canvas.toDataURL('image/png');
}
