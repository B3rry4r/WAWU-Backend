/**
 * The statement the wallet's owner asks for (task WALLET-27, W38), as the
 * contract describes it. The file travels inside the usual envelope as
 * text, so the app saves or shares it as `fileName` with `contentType`.
 */

/** The formats a statement comes in. A stamped PDF needs Fintava to issue one (G-68). */
export const STATEMENT_FORMATS = ['csv'] as const;
export type StatementFormat = (typeof STATEMENT_FORMATS)[number];

/** The time zone the period's days are read in. */
export const STATEMENT_TIME_ZONE = 'Africa/Lagos';

export interface StatementView {
  /** The first day, YYYY-MM-DD in Africa/Lagos time, as asked. Included. */
  from: string;
  /** The last day, YYYY-MM-DD in Africa/Lagos time, as asked. Included. */
  to: string;
  /** Always `Africa/Lagos`: the days above, and each row's date and time, are Lagos time. */
  timeZone: string;
  format: StatementFormat;
  /** A name to save the file under, for example `statement-2026-09-01-to-2026-09-30.csv`. */
  fileName: string;
  /** `text/csv; charset=utf-8`. */
  contentType: string;
  /** How many movements the file lists (its lines, less the header). */
  rowCount: number;
  /**
   * The file itself: a byte-order mark, a header line, then one line per
   * completed movement on the caller's wallet in the period, oldest first,
   * lines ending CRLF (RFC 4180). Amounts are naira with two decimals
   * (`1250.00`), written from integer kobo, never through a float.
   */
  content: string;
  /** When the server wrote the file (ISO 8601, UTC). */
  generatedAt: string;
}
