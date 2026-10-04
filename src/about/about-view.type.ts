/** One heading and its text. Paragraphs in `body` are separated by a blank line. */
export interface PolicySectionView {
  heading: string;
  body: string;
}

/**
 * GET /policies/:slug. `available` is false until the owner has filled the
 * document in; then `title` and `effectiveDate` are null and `sections` is
 * empty, and the app says "not available yet" instead of showing any text.
 */
export interface PolicyView {
  slug: 'terms' | 'privacy';
  available: boolean;
  title: string | null;
  /** YYYY-MM-DD, the date the owner gave the text. */
  effectiveDate: string | null;
  sections: PolicySectionView[];
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
