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
export type ContentPieceResponse = Omit<ContentPiece, 'fullAssetUrl'> & {
  fullAssetUrl: string | null;
  fullAssetLocked: boolean;
};
