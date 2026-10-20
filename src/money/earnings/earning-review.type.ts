/**
 * Sales the earnings sweep will never pay because they were made before its
 * start (WALLET-16, lead ruling 17 Oct 2026), listed for an admin.
 */
export interface UnsweptSaleView {
  paymentId: string;
  kind: string;
  targetId: string;
  title: string;
  payeeWawuUserId: string;
  /** The payee's 85% of the sale, in kobo: what the sweep would have moved. */
  payeeShareKobo: number;
  completedAt: string;
}

export interface UnsweptSalesPage {
  /** The moment from which the sweep pays sales. */
  startsAt: string;
  /** `config` when EARNINGS_SWEEP_START set it, else `first_run`. */
  source: 'config' | 'first_run';
  /**
   * How many such sales there are in all. Not called `total`: the response
   * interceptor takes any `items` plus a numeric `total` for an offset page
   * and rewrites it, which dropped the cursor and the start (B1 check, F1).
   */
  count: number;
  items: UnsweptSaleView[];
  /** A cursor page (CONVENTIONS section 6): pass as `cursor` for the next page; null on the last. */
  nextCursor: string | null;
}
