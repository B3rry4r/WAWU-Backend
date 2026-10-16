import { type StatementFormat } from './statement-view.type';

/**
 * Where a statement can be sent (task WALLET-35, W38 "Send to"), as the
 * contract describes it. The address is always the signed-in person's own,
 * read from their WAWU ID token and shown masked: a statement lists every
 * movement and counterparty name, so it is never sent to an address the
 * person types.
 */
export interface StatementDeliveryView {
  /** The account's own address, masked (`a***@example.com`). Null when `canEmail` is false. */
  email: string | null;
  /**
   * True when the account has an email address that was confirmed. False
   * means a statement cannot be emailed yet: the person confirms their
   * email first (`409 email_not_verified` on the send).
   */
  canEmail: boolean;
  /** The formats a statement can be asked for today (`csv`; a stamped PDF needs Fintava, G-68). */
  formats: StatementFormat[];
}

/** The answer to emailing a statement. */
export interface StatementEmailView {
  /** The address it went to, masked. */
  sentTo: string;
  /** The first day, YYYY-MM-DD in Africa/Lagos time, as asked. Included. */
  from: string;
  /** The last day, YYYY-MM-DD in Africa/Lagos time, as asked. Included. */
  to: string;
  format: StatementFormat;
  /** The attached file's name, for example `statement-2026-09-01-to-2026-09-30.csv`. */
  fileName: string;
  /** How many movements the file lists. */
  rowCount: number;
  /** When the mail was handed to WAWU ID's sender (ISO 8601, UTC). */
  sentAt: string;
}
