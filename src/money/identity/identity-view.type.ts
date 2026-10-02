/**
 * Response shapes of Open your wallet's identity step (task KYC-01). Named
 * interfaces, one components.schemas entry each (G-1), like
 * src/money/money-view.type.ts. Times are ISO 8601 UTC strings.
 */

/** The gender Fintava's BVN record gives, read case-insensitively. */
export type BvnGender = 'male' | 'female';

/** A BVN check that passed. Only its last 4 digits are ever kept or shown. */
export interface CheckedBvnView {
  last4: string;
  verifiedAt: string;
}

/**
 * The person's identity step as it stands (GET /money/identity). Nothing in
 * it is a full BVN or NIN, and nothing in it came from the BVN record except
 * that the check passed.
 */
export interface WalletIdentityView {
  /** The BVN check that passed (the BVN's phone matched the account's), or null. */
  bvn: CheckedBvnView | null;
  /** The last 4 digits of the NIN given with that BVN, or null. */
  ninLast4: string | null;
  /** Typed on A5, or null. */
  occupation: string | null;
  /** BVN checks this person may still run in the current 24 hours. */
  checksLeft: number;
}

/**
 * A5's "From your BVN" card. Sent once, in the answer to the check that
 * passed, and never stored: the app keeps it for A5. Any field Fintava did
 * not return, or returned in a form we cannot read, is null.
 */
export interface BvnPrefillView {
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  /** YYYY-MM-DD. */
  dateOfBirth: string | null;
  gender: BvnGender | null;
}

/** The answer to a BVN check that passed (POST /money/identity/bvn). */
export interface BvnCheckView {
  identity: WalletIdentityView;
  prefill: BvnPrefillView;
}
