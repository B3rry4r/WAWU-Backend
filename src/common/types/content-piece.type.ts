import type { ContentPieceModel } from '../../../generated/prisma/models';

export type ContentPiece = ContentPieceModel;

/** HUB-THUMBS: links to a picture's two small copies (96 and 640 px on the long side). */
export interface ThumbLinks {
  w96: string;
  w640: string;
}

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
  | 'fullAssetUrl'
  | 'coverKey'
  | 'uploadedVia'
  | 'heldForWalletAt'
  | 'ownerRemovedAt'
> & {
  fullAssetUrl: string | null;
  fullAssetLocked: boolean;
  /**
   * CONTENT-COVER (R-114): a fresh link to the piece's own cover picture, null when it has none. Served on the app's
   * requests (`X-Wawu-Client: app`) and on the routes only the app calls; the routes the web and the dashboard call
   * answer exactly as before, so on those it is absent. The picture is the piece's, never a frame of its preview file.
   */
  coverUrl?: string | null;
  /**
   * HUB-THUMBS: small copies of the preview picture and the cover; null when a picture has none. Served on the app's
   * requests only (`X-Wawu-Client: app`); on every other request the keys are absent.
   */
  previewThumbs?: ThumbLinks | null;
  coverThumbs?: ThumbLinks | null;
};
