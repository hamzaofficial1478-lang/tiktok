import { useAppStore } from '../store/app-store';
import { PageHeader } from '../components/primitives';
import { CaptionSettings } from '../components/CaptionSettings';

/**
 * Captions — its own section rather than a panel inside Add links.
 *
 * The editor had grown: a mode, a source, a target language, and a style block
 * with a font, a size, colours, an outline, a position and an animation. That
 * is a screen's worth of decisions, and folding it into the page where links
 * are pasted meant scrolling past all of it to reach the paste box.
 *
 * It is deliberately still not in Settings. These are choices about the videos
 * being downloaded now, and Settings is where things go to be forgotten — the
 * whole reason this was moved out of there in the first place. A section of its
 * own is the middle: reachable in one click from the navigation, out of the way
 * of the box people came here to type in.
 */
export function Captions(): React.JSX.Element {
  const captions = useAppStore((s) => s.config?.captions ?? null);
  const updateConfig = useAppStore((s) => s.updateConfig);

  return (
    <div className="mx-auto grid max-w-5xl gap-5">
      <PageHeader
        title="Captions"
        description="How captions are written onto the videos you download. These apply to everything in the queue; a saved account can override the mode for its own videos."
      />

      {captions && (
        <CaptionSettings value={captions} onChange={(next) => void updateConfig({ captions: next })} />
      )}
    </div>
  );
}
