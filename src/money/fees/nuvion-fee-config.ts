import {
  type FeeBand,
  FeeConfigError,
  koboSetting,
  MAX_FEE_KOBO,
} from './fee-config';

/**
 * Nuvion's charges, as settings (task NUV-07; R-42, owner, 7 Oct 2026:
 * "fees and limits are settings filled in when Nuvion answers, and nothing
 * moves real money before they are set").
 *
 * Nuvion publishes no NGN fee schedule (its docs show only that a transfer
 * carries an `applicable_fee` on top of the amount), so this file holds the
 * setting names and how a value is read, and NO figure: there is no default.
 * The owner fills them in when Nuvion answers (NUV-10). While any of them is
 * unset under WALLET_PROVIDER=nuvion, every fee quote and every money-moving
 * route answers `503 fees_not_set` before anything is sent to Nuvion
 * (fee-quote.service.ts, fees-set.guard.ts, src/money/limits/).
 *
 *   NUVION_FEE_BOOK_TRANSFER  a book transfer between two accounts at Nuvion:
 *                             a send to a WAWU user, a purchase into WAWU's
 *                             operational account (R-42)
 *   NUVION_FEE_BANK_PAYOUT    a payout to a Nigerian bank (NIP): a send to a
 *                             bank, a withdrawal
 *   NUVION_FEE_INFLOW         money arriving by bank transfer into a person's
 *                             account number (adding money, R-42)
 *
 * Each is kobo, written one of two ways: one whole number for any amount
 * (`2500`), or `from:fee` bands, comma separated, the first from 0 and each
 * `from` above the one before (`0:1000,500000:2000`). A value that is set but
 * unusable stops the server at boot naming the setting; it is read only when
 * Nuvion is the running provider, so a rollback to Fintava never trips on it.
 *
 * Fintava's schedule (fee-config.ts) is untouched: it is what a rollback runs.
 * WAWU's own fees on top (R-10) are the same under either provider.
 */
export const NUVION_FEE_CONFIG_KEYS = {
  bookTransfer: 'NUVION_FEE_BOOK_TRANSFER',
  bankPayout: 'NUVION_FEE_BANK_PAYOUT',
  inflow: 'NUVION_FEE_INFLOW',
} as const;
export type NuvionFeeName = keyof typeof NUVION_FEE_CONFIG_KEYS;

/** One charge: the same for any amount, or by amount band. */
export type FeeRule =
  | { kind: 'flat'; feeKobo: number }
  | { kind: 'bands'; bands: readonly FeeBand[] };

/** The charge a rule puts on this amount. */
export function feeOf(rule: FeeRule, amountKobo: number): number {
  if (rule.kind === 'flat') return rule.feeKobo;
  let fee = rule.bands[0].feeKobo;
  for (const band of rule.bands) {
    if (amountKobo >= band.fromKobo) fee = band.feeKobo;
  }
  return fee;
}

function blank(raw: string | undefined | null): boolean {
  return raw === undefined || raw === null || raw.trim() === '';
}

/**
 * Reads one Nuvion charge: null when unset (no default, ever), a flat rule
 * for digits only, bands for `from:fee` pairs. Anything else stops the app.
 */
export function feeRuleSetting(
  raw: string | undefined | null,
  key: string,
): FeeRule | null {
  if (blank(raw)) return null;
  const text = raw!.trim();
  if (!text.includes(':')) {
    const feeKobo = koboSetting(text, key, Number.NaN);
    return { kind: 'flat', feeKobo };
  }
  const shape = `${key} must be one whole number of kobo, or from:fee pairs in kobo, comma separated, the first from 0.`;
  const bands: FeeBand[] = [];
  for (const pair of text.split(',')) {
    const [from, fee, ...rest] = pair.trim().split(':');
    if (rest.length > 0 || blank(from) || blank(fee)) {
      throw new FeeConfigError(shape);
    }
    const fromKobo = koboSetting(
      from,
      key,
      Number.NaN,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const feeKobo = koboSetting(fee, key, Number.NaN, 0, MAX_FEE_KOBO);
    const prev = bands[bands.length - 1];
    if (prev ? fromKobo <= prev.fromKobo : fromKobo !== 0) {
      throw new FeeConfigError(
        `${key}: the first band starts at 0 and each next one higher.`,
      );
    }
    bands.push({ fromKobo, feeKobo });
  }
  return { kind: 'bands', bands };
}

/** Nuvion's charges as read at boot, and which settings are still unset. */
export interface NuvionFees {
  readonly bookTransfer: FeeRule | null;
  readonly bankPayout: FeeRule | null;
  readonly inflow: FeeRule | null;
  /** The setting names still unset, in the order above; empty when all are set. */
  readonly unset: readonly string[];
}

/** Reads every Nuvion charge through `get` (ConfigService.get, or an env map). */
export function readNuvionFees(
  get: (key: string) => string | undefined | null,
): NuvionFees {
  const K = NUVION_FEE_CONFIG_KEYS;
  const bookTransfer = feeRuleSetting(get(K.bookTransfer), K.bookTransfer);
  const bankPayout = feeRuleSetting(get(K.bankPayout), K.bankPayout);
  const inflow = feeRuleSetting(get(K.inflow), K.inflow);
  const unset = (
    [
      [K.bookTransfer, bookTransfer],
      [K.bankPayout, bankPayout],
      [K.inflow, inflow],
    ] as const
  )
    .filter(([, rule]) => rule === null)
    .map(([key]) => key);
  return { bookTransfer, bankPayout, inflow, unset };
}
