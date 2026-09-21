import type { DirectMessageModel } from '../../../generated/prisma/models';
import type { VerificationState } from '../verification/verification-state';

/**
 * The wire shape for a paid DM.
 *
 * This used to be `export type DirectMessage = DirectMessageModel` — a bare
 * re-export of the Prisma model, returned to the app by spread. Registry
 * hazard H-1: under that arrangement every column added to the table appears
 * verbatim in the SHIPPED app's responses without a line of application code
 * changing. Refund tracking added six columns, two of which must never leave
 * this process:
 *
 *   refundError      Flutterwave's own failure text, written for an operator
 *   refundLockedAt   in-flight marker for the refund executor's mutex
 *   refundAttempts   retry bookkeeping
 *   flutterwaveTxId  the payment processor's transaction id
 *
 * So the shape is now stated explicitly and built by `toWireDm`. The payer
 * DOES get to see the refund's outcome — being refunded is a fact about
 * their money and hiding it would be the opposite mistake — but they get the
 * outcome, not our retry bookkeeping.
 */
export type DirectMessage = Pick<
  DirectMessageModel,
  | 'id'
  | 'creatorWawuId'
  | 'senderWawuId'
  | 'text'
  | 'amount'
  | 'status'
  | 'sentAt'
  | 'deadlineAt'
  | 'respondedAt'
  | 'responseText'
  | 'flutterwaveTxRef'
  | 'responseWindowHours'
  | 'refundStatus'
  | 'refundedAt'
  | 'refundReference'
> & {
  /**
   * ADDITIVE — the OTHER party in this thread (never the caller themselves):
   * the sender on inbox()'s creator-facing rows, the creator on threads()'s
   * fan-facing rows, whichever one the caller isn't on findOne(). Every
   * DirectMessage row only ever carried the other party's bare wawuId, with
   * no name/handle/avatar to render, which is the same "id with nothing to
   * show" gap already fixed on CreatorDiscovery and Professional. `null`
   * only when toWireDm() is called with no lookup result at all (see its own
   * doc comment) — never omitted, so a caller can't mistake "not looked up"
   * for "this DM has no other party".
   */
  otherParty: DmOtherParty | null;
};

/** The other party's public identity, batch-looked-up alongside a page of DMs. */
export interface DmOtherParty {
  wawuId: string;
  /** Real display name from WAWU ID, falling back to the handle, then ''. */
  name: string;
  handle: string | null;
  avatarUrl: string | null;
  /** Both ticks, derived server-side. Never a rung, never a rank. */
  verification: VerificationState;
}

/**
 * Narrow a stored row to what may cross the wire. Every DM returned from
 * this API goes through here — if a new column should be public, add it to
 * the Pick above deliberately rather than by omission.
 *
 * `otherParty` is a second, optional argument rather than baked into the
 * Pick's own fields: it does not live on the DirectMessage row at all, it is
 * joined in by the caller from a batched profile lookup (see
 * DirectMessageService.lookupOtherParties). Omitted call sites (sendVerify,
 * respond) get `null` rather than a lookup on every single write — those
 * responses are consumed straight off the action just taken, where the
 * caller already knows who they just paid or just answered.
 */
export function toWireDm(
  row: DirectMessageModel,
  otherParty: DmOtherParty | null = null,
): DirectMessage {
  return {
    id: row.id,
    creatorWawuId: row.creatorWawuId,
    senderWawuId: row.senderWawuId,
    text: row.text,
    amount: row.amount,
    status: row.status,
    sentAt: row.sentAt,
    deadlineAt: row.deadlineAt,
    respondedAt: row.respondedAt,
    responseText: row.responseText,
    flutterwaveTxRef: row.flutterwaveTxRef,
    responseWindowHours: row.responseWindowHours,
    refundStatus: row.refundStatus,
    refundedAt: row.refundedAt,
    refundReference: row.refundReference,
    otherParty,
  };
}
