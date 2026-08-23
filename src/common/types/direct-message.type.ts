import type { DirectMessageModel } from '../../../generated/prisma/models';

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
>;

/**
 * Narrow a stored row to what may cross the wire. Every DM returned from
 * this API goes through here — if a new column should be public, add it to
 * the Pick above deliberately rather than by omission.
 */
export function toWireDm(row: DirectMessageModel): DirectMessage {
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
  };
}
