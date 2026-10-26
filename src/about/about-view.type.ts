/** One heading and its text. Paragraphs in `body` are separated by a blank line. */
export interface PolicySectionView {
  heading: string;
  body: string;
}

/** The owner's nine legal documents, by slug (src/about/policies.service.ts keeps the order). */
export type PolicySlugView =
  | 'privacy'
  | 'terms'
  | 'cookies'
  | 'creator-monetization'
  | 'verification-refund'
  | 'acceptable-use'
  | 'partner-dpa'
  | 'community-guidelines'
  | 'disclaimer';

/**
 * GET /policies/:slug. `available` is false until the owner has filled the
 * document in; then `title` and `effectiveDate` are null and `sections` is
 * empty, and the app says "not available yet" instead of showing any text.
 */
export interface PolicyView {
  slug: PolicySlugView;
  available: boolean;
  title: string | null;
  /** YYYY-MM-DD, the date the owner gave the text. */
  effectiveDate: string | null;
  sections: PolicySectionView[];
}

/** One row of GET /policies: a published document, with no text. */
export interface PolicySummaryView {
  slug: PolicySlugView;
  title: string;
  /** YYYY-MM-DD, the date the owner gave the text. */
  effectiveDate: string;
}

/**
 * GET /policies. The published documents in the owner's order (privacy, terms, cookies, creator-monetization,
 * verification-refund, acceptable-use, partner-dpa, community-guidelines, disclaimer). Empty until the owner has
 * published one.
 */
export interface PolicyListView {
  items: PolicySummaryView[];
}

/** One document the person agreed to (POST /policies/accept). */
export interface PolicyAcceptedView {
  slug: PolicySlugView;
  /** YYYY-MM-DD, the version agreed to. */
  effectiveDate: string;
  /** When the Hub first kept the agreement. */
  acceptedAt: string;
}

/**
 * POST /policies/accept. What the Hub now holds for the caller: one entry for each published document at its
 * current date. Empty when the owner has published nothing.
 */
export interface PolicyAcceptanceView {
  items: PolicyAcceptedView[];
}

/**
 * GET /about. Every value is config the owner fills in; null means not filled
 * in yet and the app leaves that line out (the bank line) or says so.
 */
export interface AboutView {
  /** The bank that holds the wallets (R-1). */
  bankName: string;
  /** The licence wording, owner's (R-1). Null hides the line. */
  licenceLine: string | null;
  /** Where "Contact support" sends mail. Null until the owner fills it in. */
  supportEmail: string | null;
}
