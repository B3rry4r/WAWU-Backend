/**
 * EVERY PLACE AN ACCOUNT'S DATA LIVES, CLASSIFIED.
 *
 * Deleting an account means deleting it everywhere, and this schema has
 * roughly fifty tables carrying a WAWU user id. A hand-written list of the
 * ones somebody remembered would rot the first time a table was added -
 * silently, leaving personal data behind in the one operation where that is
 * least acceptable.
 *
 * So every wawu-id column in the schema is classified here, and
 * account-data-map.spec.ts fails the build if the schema grows one this file
 * does not mention. Adding a table with a user id means coming back here and
 * saying what happens to it. That is the point.
 *
 * The four classifications:
 *
 *   OWNED     the row IS the account's data. Delete the row.
 *   AUTHORED  the row is the account's contribution to something shared
 *             (a comment, a community message). Delete the row: a purge that
 *             leaves the writing behind has not deleted the person.
 *   COUNTERPARTY
 *             the row is somebody ELSE's record that happens to name this
 *             account (a purchase they made from this creator, a follow of
 *             this account). Their record survives; the reference is scrubbed
 *             by WAWU ID's anonymize, not by dropping the other party's data.
 *   AUDIT     an admin action record. Kept deliberately: an audit trail that
 *             disappears when its subject does is not an audit trail.
 */

export type Disposition = 'OWNED' | 'AUTHORED' | 'COUNTERPARTY' | 'AUDIT';

export interface ColumnRule {
  model: string;
  column: string;
  disposition: Disposition;
}

/**
 * Ordered parent-last: rows that reference others are removed before the
 * things they point at, so a purge does not trip a foreign key on the way
 * through. UserProfile and CreatorState come last for that reason.
 */
export const ACCOUNT_DATA_MAP: ColumnRule[] = [
  // ── the account's own contributions to shared surfaces ──────────────────
  { model: 'Comment', column: 'authorWawuId', disposition: 'AUTHORED' },
  {
    model: 'CommunityMessage',
    column: 'senderWawuId',
    disposition: 'AUTHORED',
  },
  { model: 'DmReport', column: 'reporterWawuId', disposition: 'AUTHORED' },

  // ── things that exist only because this account exists ──────────────────
  { model: 'SavedItem', column: 'userWawuId', disposition: 'OWNED' },
  { model: 'CommentLike', column: 'userWawuId', disposition: 'OWNED' },
  { model: 'MarketplaceSave', column: 'userWawuId', disposition: 'OWNED' },
  { model: 'CartItem', column: 'userWawuId', disposition: 'OWNED' },
  { model: 'EventGoing', column: 'userWawuId', disposition: 'OWNED' },
  { model: 'CourseEnrollment', column: 'userWawuId', disposition: 'OWNED' },
  { model: 'CommunityMembership', column: 'userWawuId', disposition: 'OWNED' },
  { model: 'Notification', column: 'userWawuId', disposition: 'OWNED' },
  { model: 'NotificationSettings', column: 'userWawuId', disposition: 'OWNED' },
  { model: 'PrivacySettings', column: 'userWawuId', disposition: 'OWNED' },
  { model: 'DataExportRequest', column: 'userWawuId', disposition: 'OWNED' },
  { model: 'BlockedAccount', column: 'userWawuId', disposition: 'OWNED' },
  { model: 'CreditsState', column: 'userWawuId', disposition: 'OWNED' },
  { model: 'CreditPurchase', column: 'userWawuId', disposition: 'OWNED' },
  { model: 'CreditLot', column: 'userWawuId', disposition: 'OWNED' },
  { model: 'CreditSpend', column: 'userWawuId', disposition: 'OWNED' },
  {
    model: 'FollowRelationship',
    column: 'followerWawuId',
    disposition: 'OWNED',
  },
  {
    model: 'ServiceApplication',
    column: 'applicantWawuId',
    disposition: 'OWNED',
  },
  { model: 'MentorRequest', column: 'requesterWawuId', disposition: 'OWNED' },
  {
    model: 'VerificationSubmission',
    column: 'wawuUserId',
    disposition: 'OWNED',
  },
  { model: 'KycSubmission', column: 'wawuUserId', disposition: 'OWNED' },
  { model: 'PendingCharge', column: 'wawuUserId', disposition: 'OWNED' },
  { model: 'HealthSubscription', column: 'wawuUserId', disposition: 'OWNED' },
  { model: 'LegalRequest', column: 'wawuUserId', disposition: 'OWNED' },
  { model: 'LegalIntake', column: 'wawuUserId', disposition: 'OWNED' },
  { model: 'ProfessionalProfile', column: 'wawuUserId', disposition: 'OWNED' },
  { model: 'StorageObject', column: 'wawuUserId', disposition: 'OWNED' },
  { model: 'DittoOptIn', column: 'wawuUserId', disposition: 'OWNED' },
  { model: 'EventReferral', column: 'ownerWawuId', disposition: 'OWNED' },
  {
    model: 'CreatorNoResponseTracker',
    column: 'creatorWawuId',
    disposition: 'OWNED',
  },
  { model: 'EvgScore', column: 'creatorWawuId', disposition: 'OWNED' },
  { model: 'ContentPiece', column: 'creatorWawuId', disposition: 'OWNED' },
  { model: 'Community', column: 'hostWawuId', disposition: 'OWNED' },
  { model: 'Event', column: 'hostWawuId', disposition: 'OWNED' },
  { model: 'DirectMessage', column: 'senderWawuId', disposition: 'OWNED' },
  { model: 'BillPayment', column: 'buyerWawuId', disposition: 'OWNED' },
  { model: 'ShopOrder', column: 'buyerWawuId', disposition: 'OWNED' },
  { model: 'EventOrder', column: 'buyerWawuId', disposition: 'OWNED' },
  { model: 'Purchase', column: 'buyerWawuId', disposition: 'OWNED' },
  // ── the wallet ──────────────────────────────────────────────────────────
  // A withdrawal's banking details and the ledger of what moved are this
  // account's own records, so they go with it. The wallet ROW goes too, but
  // note what that does and does not do: it removes WAWU's pointer to the
  // account. The account itself is at Flutterwave MFB in the creator's name
  // and is Flutterwave's to close, which is why account deletion has to drain
  // a wallet before it runs rather than leaving money behind a deleted row.
  { model: 'WalletWithdrawal', column: 'wawuUserId', disposition: 'OWNED' },
  { model: 'WalletLedgerEntry', column: 'wawuUserId', disposition: 'OWNED' },
  { model: 'CreatorWallet', column: 'wawuUserId', disposition: 'OWNED' },

  // Last: everything above may reference these.
  { model: 'CreatorState', column: 'wawuUserId', disposition: 'OWNED' },
  { model: 'UserProfile', column: 'wawuUserId', disposition: 'OWNED' },

  // ── somebody else's record that names this account ──────────────────────
  // Deleting these would delete another person's history, not this one's.
  { model: 'Purchase', column: 'creatorWawuId', disposition: 'COUNTERPARTY' },
  {
    model: 'CreditSpend',
    column: 'creatorWawuId',
    disposition: 'COUNTERPARTY',
  },
  {
    model: 'CreditSpendEarning',
    column: 'creatorWawuId',
    disposition: 'COUNTERPARTY',
  },
  {
    model: 'DirectMessage',
    column: 'creatorWawuId',
    disposition: 'COUNTERPARTY',
  },
  {
    model: 'FollowRelationship',
    column: 'followingWawuId',
    disposition: 'COUNTERPARTY',
  },
  {
    model: 'BlockedAccount',
    column: 'blockedWawuId',
    disposition: 'COUNTERPARTY',
  },

  // ── admin audit trail, kept on purpose ──────────────────────────────────
  { model: 'AdminKycAudit', column: 'subjectWawuUserId', disposition: 'AUDIT' },
  {
    model: 'AdminVerificationAudit',
    column: 'subjectWawuUserId',
    disposition: 'AUDIT',
  },
  {
    model: 'AdminVerificationAudit',
    column: 'tierElevatedAtWawuId',
    disposition: 'AUDIT',
  },
  { model: 'AdminOpsAudit', column: 'subjectWawuId', disposition: 'AUDIT' },
  {
    model: 'AdminContentReview',
    column: 'creatorWawuId',
    disposition: 'AUDIT',
  },
  { model: 'AdminEventReview', column: 'hostWawuId', disposition: 'AUDIT' },
];

/**
 * Columns that merely have "wawu" in the name and identify nobody. Listed so
 * the drift test can tell "not a user id" from "nobody has classified this
 * yet" - the second must fail the build, the first must not.
 */
export const NOT_A_USER_REFERENCE: ReadonlyArray<{
  model: string;
  column: string;
}> = [
  { model: 'Product', column: 'wawuPick' },
  { model: 'Product', column: 'wawuVerified' },
];

/** The rows a purge actually removes. */
export function rowsToDelete(): ColumnRule[] {
  return ACCOUNT_DATA_MAP.filter(
    (r) => r.disposition === 'OWNED' || r.disposition === 'AUTHORED',
  );
}
