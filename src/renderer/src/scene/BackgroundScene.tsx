import { usePrefersReducedMotion } from '../lib/motion-prefs';

/**
 * The backdrop, drawn once and then left alone.
 *
 * ## Why this is no longer three.js
 *
 * It was a WebGL particle field and a turning wireframe form, and it cost more
 * than it was worth in three separate ways:
 *
 *  - It rendered continuously. `useFrame` called `invalidate()`, which turned
 *    `frameloop="demand"` into a loop running at the display's full rate — 60,
 *    120 or 144 times a second — to animate a drift slow enough to read as
 *    stillness.
 *  - It was 2 MB of JavaScript to parse before anything appeared, plus a WebGL
 *    context and geometry buffers held for the life of the window.
 *  - The GPU it used is the same GPU ffmpeg wants for hardware encoding, on the
 *    machine of someone who is downloading videos.
 *
 * What replaced it is CSS gradients and one small repeating SVG, both of which
 * the compositor draws once and never touches again. No frame loop, no WebGL
 * context, no measurable processor cost, and the same layered sci-fi feel the
 * design called for. Nothing here animates, deliberately.
 */

/**
 * A faint grid, as a data URI.
 *
 * Inline rather than a file because the CSP for this app allows `data:` images
 * and nothing else external — and at this size the whole pattern is smaller
 * than the request that would fetch it.
 */
const GRID =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='64'%3E%3Cpath d='M64 0H0v64' fill='none' stroke='%23ffffff' stroke-opacity='0.028' stroke-width='1'/%3E%3C/svg%3E\")";

export function BackgroundScene(): React.JSX.Element | null {
  const reduced = usePrefersReducedMotion();

  /**
   * "Reduce visual effects" still removes it entirely.
   *
   * It used to mean "do not download 2 MB of three.js", which mattered a great
   * deal. Now it means a plain flat ground, which is a smaller difference — but
   * it is still a preference someone expressed, and honouring it costs nothing.
   */
  if (reduced) return null;

  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      {/* The ground, so the page never shows the host's colour through. */}
      <div className="absolute inset-0 bg-base-950" />

      {/* Two wide, soft pools of colour: the depth the scene used to imply. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(60rem 40rem at 18% 8%, rgba(91,110,245,0.16), transparent 62%),' +
            'radial-gradient(48rem 36rem at 88% 78%, rgba(64,224,184,0.10), transparent 60%)',
        }}
      />

      {/* The grid, faded out towards the edges so it never reads as a table. */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: GRID,
          maskImage: 'radial-gradient(80% 70% at 50% 40%, #000 35%, transparent 100%)',
          WebkitMaskImage: 'radial-gradient(80% 70% at 50% 40%, #000 35%, transparent 100%)',
        }}
      />

      {/* A single vignette, which is what stops the flat areas looking flat. */}
      <div
        className="absolute inset-0"
        style={{ background: 'radial-gradient(120% 100% at 50% 0%, transparent 45%, rgba(0,0,0,0.55) 100%)' }}
      />
    </div>
  );
}
