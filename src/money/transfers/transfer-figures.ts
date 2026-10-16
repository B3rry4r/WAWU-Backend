/**
 * How the provider's charge on a send is split between "the provider's" and
 * "WAWU's" once the provider's own record says what it really took (task
 * WALLET-07, R-10).
 *
 * A send is quoted as the provider's charge plus WAWU's fee on top, and the
 * provider collects both in the one transfer (Fintava's dashboard "Merchant
 * charges", docs/fintava/fees.md). What the provider's record then says it
 * took is ONE figure, so the split on the send and on its ledger rows is
 * ours to make, and it must add up to what really left the wallet:
 *
 * - it took at least what was quoted: WAWU's fee stands as quoted and the
 *   rest is the provider's (an excess is flagged for review, not hidden);
 * - it took less: the provider's own charge is paid first, and WAWU's fee is
 *   what is left, down to nothing (WAWU's fee is the part nothing in the
 *   provider's answer confirms, and the first thing a missing dashboard
 *   charge shows up as).
 *
 * Pure: integer kobo in, integer kobo out, the two always add up to `real`.
 */
export interface QuotedCharge {
  providerFeeKobo: number;
  wawuFeeKobo: number;
}

export function splitCharge(
  quoted: QuotedCharge,
  realFeeKobo: number,
): QuotedCharge {
  if (!Number.isSafeInteger(realFeeKobo) || realFeeKobo < 0) {
    throw new RangeError('splitCharge: the charge is a whole number of kobo.');
  }
  const quotedTotal = quoted.providerFeeKobo + quoted.wawuFeeKobo;
  if (realFeeKobo >= quotedTotal) {
    return {
      providerFeeKobo: realFeeKobo - quoted.wawuFeeKobo,
      wawuFeeKobo: quoted.wawuFeeKobo,
    };
  }
  const providerFeeKobo = Math.min(realFeeKobo, quoted.providerFeeKobo);
  return { providerFeeKobo, wawuFeeKobo: realFeeKobo - providerFeeKobo };
}
