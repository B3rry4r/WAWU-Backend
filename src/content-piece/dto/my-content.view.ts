import type { ContentPieceResponse } from '../../common/types/content-piece.type';

/**
 * One piece on the creator's own shelf (M28, M26, M25).
 *
 * `salesCount` is the number of completed content purchases of this piece.
 * `rejectionReason` and `rejectedAt` are the latest reviewer rejection, and
 * are set only while the piece is `rejected`: once it is sent again the old
 * reason no longer describes it. The reviewer's identity is never included.
 */
export type MyContentItem = ContentPieceResponse & {
  /** CONTENT-COVER (R-114): a fresh link to the piece's cover picture; null when it has none. Always present here. */
  coverUrl: string | null;
  salesCount: number;
  rejectionReason: string | null;
  rejectedAt: Date | null;
  /**
   * WEB-HOLD (R-126): `'wallet'` while a moderator has approved the piece and it waits for its creator to open their wallet in
   * the app, then goes live by itself; null otherwise. Only pieces made by the new web upload flow can wait. `status` stays
   * `pending` meanwhile. Added; no existing field changed.
   */
  waitingFor: 'wallet' | null;
};

/** Filter tab counts for the My content screen: All, Live, In review, Rejected. */
export interface MyContentCounts {
  all: number;
  live: number;
  pending: number;
  rejected: number;
}
