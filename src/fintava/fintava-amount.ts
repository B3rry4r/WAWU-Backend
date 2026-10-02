/**
 * Kobo at the Fintava boundary (docs/contract/CONVENTIONS.md section 1).
 *
 * Fintava speaks naira decimals: numbers in balances and transfer responses
 * (`49960`, `2.75`), strings in transaction records and bill lists
 * (`"100.00"`, `"900"`). Everything else in this backend is integer kobo.
 * This file is the only place that converts, and it never multiplies a float:
 * the decimal text is split into its whole and fraction parts. A value with
 * more than 2 decimal places is refused rather than rounded.
 */

const NAIRA_TEXT = /^(-?)(\d+)(?:\.(\d{1,2}))?$/;

/** A Fintava amount we could not read as naira with at most 2 decimals. */
export class FintavaAmountError extends Error {
  constructor(what: string) {
    super(`Fintava sent an amount that is not naira with 2 decimals: ${what}`);
    this.name = 'FintavaAmountError';
  }
}

/**
 * Naira as Fintava sends it (a JSON number or a decimal string) to integer
 * kobo. `"100.00"` is 10000, `2.75` is 275, `49960` is 4996000.
 */
export function fintavaAmountToKobo(value: unknown): number {
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new FintavaAmountError('not finite');
    // A double's shortest decimal form: 2.75 -> "2.75", 0.1 + 0.2 ->
    // "0.30000000000000004" (refused below), 1e21 -> "1e+21" (refused).
    text = String(value);
  } else if (typeof value === 'string') {
    text = value.trim();
  } else {
    throw new FintavaAmountError(typeof value);
  }
  const m = NAIRA_TEXT.exec(text);
  if (!m) throw new FintavaAmountError(`"${text.slice(0, 24)}"`);
  const [, sign, whole, fraction = ''] = m;
  const kobo = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(kobo)) throw new FintavaAmountError('too large');
  return sign === '-' && kobo !== 0 ? -kobo : kobo;
}

/** Same, for a field that may be absent: null stays null. */
export function fintavaAmountToKoboOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  return fintavaAmountToKobo(value);
}

/**
 * Integer kobo to the naira number Fintava's request bodies take: 1050 is
 * 10.5, 30000 is 300. Built from integer division; the decimal text of the
 * result reads back as exactly the same naira.
 */
export function koboToFintavaAmount(kobo: number): number {
  if (!Number.isSafeInteger(kobo) || kobo <= 0) {
    throw new RangeError('An amount sent to Fintava is a positive whole kobo.');
  }
  const rest = kobo % 100;
  const whole = (kobo - rest) / 100;
  return Number(`${whole}.${String(rest).padStart(2, '0')}`);
}
