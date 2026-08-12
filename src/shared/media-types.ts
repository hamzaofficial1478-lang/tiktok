/**
 * Media shapes shared by both processes.
 *
 * Mirrors main/resolve/types so the renderer can type a template preview
 * without importing anything from main. Kept minimal on purpose: only what
 * crosses the boundary belongs here.
 */
export interface VideoMetadata {
  readonly awemeId: string;
  readonly authorHandle: string | null;
  readonly authorName: string | null;
  readonly caption: string | null;
  readonly durationMs: number | null;
  readonly coverUrl: string | null;
  readonly musicTitle: string | null;
  readonly uploadedAt: number | null;
  readonly hashtags: readonly string[];
  readonly isPhotoPost: boolean;
  readonly stats: {
    readonly views: number | null;
    readonly likes: number | null;
    readonly comments: number | null;
    readonly shares: number | null;
  };
}
