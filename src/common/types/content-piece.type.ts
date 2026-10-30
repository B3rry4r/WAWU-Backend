import type { ContentPieceModel } from '../../../generated/prisma/models';

export type ContentPiece = ContentPieceModel;

/**
 * Wire response for GET /content, /content/:id, /content/mine etc.
 * `fullAssetLocked` (registry note: "derived") is computed per-requester at
 * read time (free content, or requester has a completed Purchase) — never a
 * stored column. `fullAssetUrl` is redacted (set to null) at the service
 * layer when the requester hasn't unlocked it, even though the underlying
 * column is populated.
 */
export type ContentPieceResponse = Omit<
  ContentPiece,
  'fullAssetUrl' | 'coverKey'
> & {
  fullAssetUrl: string | null;
  fullAssetLocked: boolean;
  /**
   * CONTENT-COVER (R-114): a fresh link to the piece's own cover picture, null when it has none. Served on the app's
   * requests (`X-Wawu-Client: app`) and on the routes only the app calls; the routes the web and the dashboard call
   * answer exactly as before, so on those it is absent. The picture is the piece's, never a frame of its preview file.
   */
  coverUrl?: string | null;
};
