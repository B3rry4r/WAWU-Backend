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
  // A reply bubble (INBOX-08) is the creator's writing; it goes with them.
  { model: 'DmReply', column: 'creatorWawuId', disposition: 'AUTHORED' },
  // A free chat message (INBOX-06) is this person's writing; it goes with
  // them. The other person's messages in the same chat stay.
  { model: 'ChatMessage', column: 'senderWawuId', disposition: 'AUTHORED' },
  // A rating IS writing, even when it is only a number: it is this person's
  // opinion, it is published under their account, and it moves an average
  // other people read. Leaving it behind would keep their judgment of a
  // professional on the platform after they had gone.
  {
    model: 'ProfessionalReview',
    column: 'authorWawuId',
    disposition: 'AUTHORED',
  },

  // ── things that exist only because this account exists ──────────────────
  { model: 'SavedItem', column: 'userWawuId', disposition: 'OWNED' },
  { model: 'CommentLike', column: 'userWawuId', disposition: 'OWNED' },
  // Likes, daily opens and daily shares of content (HOME-04): what this
  // person did on other people's pieces. It goes with them. The counters on
  // the piece are not walked back, as with CommentLike above.
  { model: 'ContentLike', column: 'userWawuId', disposition: 'OWNED' },
  { model: 'ContentView', column: 'viewerWawuId', disposition: 'OWNED' },
  { model: 'ContentShare', column: 'sharerWawuId', disposition: 'OWNED' },
  // TGIF reactions, reads and shares (HOME-10): the person's own taps. Counts
  // are computed from the rows, so no counter is left behind.
  { model: 'TgifReaction', column: 'userWawuId', disposition: 'OWNED' },
  { model: 'TgifRead', column: 'userWawuId', disposition: 'OWNED' },
  { model: 'TgifShare', column: 'userWawuId', disposition: 'OWNED' },
  // A star rating of a piece (HOME-06) is this person's opinion, published
  // under their account and counted in an average other people read, so it
  // goes with them (AUTHORED, as ProfessionalReview is). The cached
  // `ratingPct` on the piece is not walked back until the next rating; the
  // average the detail route serves is computed from the rows, so it is right
  // at once.
  { model: 'ContentRating', column: 'userWawuId', disposition: 'AUTHORED' },
  { model: 'MarketplaceSave', column: 'userWawuId', disposition: 'OWNED' },
  { model: 'CartItem', column: 'userWawuId', disposition: 'OWNED' },
  { model: 'EventGoing', column: 'userWawuId', disposition: 'OWNED' },
  { model: 'EventSave', column: 'userWawuId', disposition: 'OWNED' },
  // This person's saved creators and finished course lessons (ME-10): their
  // own bookmarks and their own progress. Both go with them.
  { model: 'SavedCreator', column: 'userWawuId', disposition: 'OWNED' },
  {
    model: 'CourseLessonProgress',
    column: 'userWawuId',
    disposition: 'OWNED',
  },
  // The views OF this profile. A statistic about the account, so it goes with
  // the account. The other column on this table is somebody else's, below.
  { model: 'ProfileView', column: 'profileWawuId', disposition: 'OWNED' },
  // This person's own job history. It is part of their profile and nothing
  // else references it, so it goes when the account goes. The employers named
  // on those rows are free text, not other accounts, so there is no
  // counterparty here to preserve.
  { model: 'ProfileExperience', column: 'wawuUserId', disposition: 'OWNED' },
  // Location, skills, open-to chips, Threads handle and social-link order (ME-05).
  // Part of this person's profile and nothing else references it.
  { model: 'ProfileDetails', column: 'wawuUserId', disposition: 'OWNED' },
  // Featured works and education (ME-16): part of this person's profile, shown
  // under their name; nothing else references them. The works' pictures are
  // storage objects, which the purge's storage step handles with the rest of
  // this person's uploads.
  { model: 'ProfileWork', column: 'wawuUserId', disposition: 'OWNED' },
  { model: 'ProfileEducation', column: 'wawuUserId', disposition: 'OWNED' },
  { model: 'CourseEnrollment', column: 'userWawuId', disposition: 'OWNED' },
  { model: 'CommunityMembership', column: 'userWawuId', disposition: 'OWNED' },
  // How far this person has read in each community (INBOX-01).
  { model: 'CommunityReadMarker', column: 'userWawuId', disposition: 'OWNED' },
  { model: 'Notification', column: 'userWawuId', disposition: 'OWNED' },
  { model: 'NotificationSettings', column: 'userWawuId', disposition: 'OWNED' },
  { model: 'PrivacySettings', column: 'userWawuId', disposition: 'OWNED' },
  // Whether this person wants TGIF on Today (HOME-11): theirs alone.
  { model: 'TgifPreference', column: 'userWawuId', disposition: 'OWNED' },
  { model: 'DataExportRequest', column: 'userWawuId', disposition: 'OWNED' },
  { model: 'BlockedAccount', column: 'userWawuId', disposition: 'OWNED' },
  // How far this person had read in each chat: theirs alone.
  { model: 'ChatParticipant', column: 'wawuUserId', disposition: 'OWNED' },
  { model: 'CreditsState', column: 'userWawuId', disposition: 'OWNED' },
  { model: 'CreditPurchase', column: 'userWawuId', disposition: 'OWNED' },
  // What somebody paid for their own tick. OWNED rather than AUDIT: the
  // row exists only because this account bought something, there is no
  // counterparty whose record it also is, and nothing else in the product
  // needs it once the account is gone.
  {
    model: 'VerificationPurchase',
    column: 'wawuUserId',
    disposition: 'OWNED',
  },
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
  // The chat that writes a legal brief (LEGAL-01): the person's own words and
  // the assistant's replies. Before LegalIntake, which it points at.
  { model: 'LegalIntakeMessage', column: 'wawuUserId', disposition: 'OWNED' },
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
  // The transaction PIN (MONEY-09): a hash of this person's own secret and
  // their wrong-try count. Nothing else references it, so it goes with them.
  { model: 'TransactionPin', column: 'wawuUserId', disposition: 'OWNED' },
  // Resetting that PIN by a code to the phone (MONEY-14): the code's hash,
  // its tries and the phone it went to. The phone that may approve with a
  // fingerprint or face (a public key) and its one-time challenges. All of
  // it is this person's and goes with them.
  {
    model: 'TransactionPinReset',
    column: 'wawuUserId',
    disposition: 'OWNED',
  },
  { model: 'ApprovalDevice', column: 'wawuUserId', disposition: 'OWNED' },
  { model: 'ApprovalChallenge', column: 'wawuUserId', disposition: 'OWNED' },
  // The pointer to this person's Fintava wallet (MONEY-11). Like
  // CreatorWallet above, removing it removes WAWU's pointer, not the account
  // at Fintava, which is why deletion needs an empty wallet first (R-17).
  { model: 'FintavaWallet', column: 'wawuUserId', disposition: 'OWNED' },
  // The ledger's rows on this person's wallet (MONEY-10), like
  // WalletLedgerEntry above; their FintavaLedgerReference rows go with them
  // (cascade). Deletion needs an empty wallet first (R-17). Default (agent),
  // owner may override: how long money records are kept after an account
  // is deleted is the owner's call.
  {
    model: 'FintavaLedgerEntry',
    column: 'wawuUserId',
    disposition: 'OWNED',
  },
  // Open your wallet's identity step (KYC-01): keyed hashes and last 4 digits
  // of this person's BVN and NIN, their verified phone and occupation, and
  // the record of their BVN checks. All of it is theirs and goes with them.
  { model: 'WalletIdentity', column: 'wawuUserId', disposition: 'OWNED' },
  { model: 'BvnCheckAttempt', column: 'wawuUserId', disposition: 'OWNED' },
  // The record of this person's selfie matches (KYC-02): outcome, time and
  // confidence only, never the image.
  { model: 'SelfieMatchAttempt', column: 'wawuUserId', disposition: 'OWNED' },
  // The record of opening this person's Fintava account (MONEY-12): its
  // state, the keyed BVN hash and the proved phone. Like FintavaWallet, it
  // is WAWU's record, not the account at Fintava, which stays there.
  {
    model: 'FintavaWalletOpening',
    column: 'wawuUserId',
    disposition: 'OWNED',
  },
  // This person's saved beneficiaries and payout account (WALLET-14): their
  // own list of where they send money, and the bank account their
  // withdrawals go to. Both go with them.
  { model: 'MoneyBeneficiary', column: 'ownerWawuId', disposition: 'OWNED' },
  { model: 'MoneyPayoutAccount', column: 'wawuUserId', disposition: 'OWNED' },
  // The codes this person made to share their receipts (WALLET-18). They go
  // with them, and each code then opens the plain "not found" page.
  { model: 'MoneyReceipt', column: 'wawuUserId', disposition: 'OWNED' },

  // Which ads this person viewed, tapped or skipped on which day (ADS-05):
  // theirs, so the rows go with them. The daily totals the owner invoices from
  // (AdDailyTotal) name nobody, are not walked back, and stay.
  { model: 'AdEvent', column: 'viewerWawuId', disposition: 'OWNED' },

  // Last: everything above may reference these.
  // An admin's choice to feature this creator in Explore (EXPLORE-03): a
  // placement about the account, gone with it. The row's admin id is not a
  // user reference and stays out of the map.
  { model: 'FeaturedCreator', column: 'wawuUserId', disposition: 'OWNED' },
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
  // Somebody else's saved creator that names this account (ME-10): their
  // bookmark. It stays; their Saved list stops showing it once this account's
  // profile is gone (the list joins UserProfile).
  {
    model: 'SavedCreator',
    column: 'creatorWawuId',
    disposition: 'COUNTERPARTY',
  },
  // The other person named on somebody else's notification (ME-10: the
  // buyer, tipper, follower, asker or rater). The notification is the
  // reader's; it stays, and this id is scrubbed by WAWU ID's anonymize. The
  // reader's own notifications (and their targets, by cascade) go with the
  // reader under Notification above.
  {
    model: 'NotificationTarget',
    column: 'actorWawuId',
    disposition: 'COUNTERPARTY',
  },
  // A chat is shared by two people. Deleting the row would delete the other
  // person's messages with it (they cascade), so the chat stays for them and
  // this account's id on it is scrubbed by WAWU ID's anonymize, as above.
  {
    model: 'ChatConversation',
    column: 'userAWawuId',
    disposition: 'COUNTERPARTY',
  },
  {
    model: 'ChatConversation',
    column: 'userBWawuId',
    disposition: 'COUNTERPARTY',
  },
  // Views this account made of OTHER people's profiles. Deleting them would
  // silently reduce somebody else's historical figures, which is editing a
  // third party's records to erase this one; the reference is scrubbed by
  // WAWU ID's anonymize like every other counterparty id here.
  {
    model: 'ProfileView',
    column: 'viewerWawuId',
    disposition: 'COUNTERPARTY',
  },
  // The other side named on somebody else's ledger row (MONEY-10): their
  // money record survives.
  {
    model: 'FintavaLedgerEntry',
    column: 'counterpartyWawuUserId',
    disposition: 'COUNTERPARTY',
  },
  // Somebody else's saved beneficiary that names this account (WALLET-14):
  // their list, not this person's. It stays; once this account is gone the
  // list no longer shows it (the list shows only people with a wallet, and
  // this account's FintavaWallet row went with it above).
  {
    model: 'MoneyBeneficiary',
    column: 'recipientWawuId',
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
  // WAWU's fee in kobo on a ledger row (MONEY-10), not a person.
  { model: 'FintavaLedgerEntry', column: 'wawuFeeKobo' },
];

/** The rows a purge actually removes. */
export function rowsToDelete(): ColumnRule[] {
  return ACCOUNT_DATA_MAP.filter(
    (r) => r.disposition === 'OWNED' || r.disposition === 'AUTHORED',
  );
}
