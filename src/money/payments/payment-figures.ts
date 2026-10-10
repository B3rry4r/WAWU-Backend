/**
 * What a payment is completed AT (MONEY-17 round 7, lead ruling R6-1): the one
 * place that turns the provider's own record of a debit into the payment's
 * figures. Every way a payment completes (the provider's answer to the send,
 * the payment sweep's lookup, the ledger's status check, a ledger row settled
 * by anything) goes through `completedFigures`, so the quote is never what the
 * payment records when the provider says it took something else.
 *
 * Pure: bigint kobo in, bigint kobo out, no rounding and no I/O.
 */

/** What the buyer was quoted (and what the payment was claimed with). */
export interface QuotedDebit {
  providerFeeKobo: bigint;
  totalKobo: bigint;
}

/**
 * What the provider's record says the buyer paid. `feeKobo` and `totalKobo`
 * are null when the record does not carry them (Fintava's lookups and history
 * carry no charge for a wallet-to-wallet send): the quote then stands, since
 * nothing in the record contradicts it.
 */
export interface RecordedDebit {
  amountKobo: bigint;
  feeKobo: bigint | null;
  totalKobo: bigint | null;
}

/**
 * `as_quoted`: the provider took what the quote said. `above`: it took more
 * (flagged for review, NUV-08 reconciles it). `below`: it took less (recorded
 * as taken, nobody is owed anything, no flag).
 */
export type DebitVerdict = 'as_quoted' | 'above' | 'below';

export interface CompletedFigures {
  verdict: DebitVerdict;
  feeKobo: bigint;
  totalKobo: bigint;
  /** Both figures in words, for `discrepancy`; null when the quote stood. */
  note: string | null;
}

export function completedFigures(
  quoted: QuotedDebit,
  record: RecordedDebit,
  label: string,
): CompletedFigures {
  // A record that gives neither figure says nothing against the quote; one
  // that gives one of them gives the other by the amount.
  let feeKobo = record.feeKobo ?? quoted.providerFeeKobo;
  let totalKobo = record.totalKobo ?? quoted.totalKobo;
  if (record.feeKobo !== null && record.totalKobo === null) {
    totalKobo = record.amountKobo + record.feeKobo;
  } else if (record.feeKobo === null && record.totalKobo !== null) {
    feeKobo = record.totalKobo - record.amountKobo;
  }
  if (feeKobo === quoted.providerFeeKobo && totalKobo === quoted.totalKobo) {
    return { verdict: 'as_quoted', feeKobo, totalKobo, note: null };
  }
  const verdict: DebitVerdict =
    totalKobo > quoted.totalKobo ? 'above' : 'below';
  return {
    verdict,
    feeKobo,
    totalKobo,
    note: `${verdict === 'above' ? 'debit above the quote' : 'debit differs from the quote'}: ${label} took ${totalKobo} kobo (fee ${feeKobo}), quoted ${quoted.totalKobo} kobo (fee ${quoted.providerFeeKobo})`,
  };
}

/** Joins notes for a `discrepancy` column: no empty piece, no piece twice. */
export function joinNotes(
  ...notes: ReadonlyArray<string | null | undefined>
): string | null {
  let joined = '';
  for (const n of notes) {
    if (!n) continue;
    if (joined && `; ${joined}; `.includes(`; ${n}; `)) continue;
    joined = joined ? `${joined}; ${n}` : n;
  }
  return joined ? joined.slice(0, 1000) : null;
}
