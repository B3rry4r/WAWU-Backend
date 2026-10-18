/**
 * The note a ledger row carries when the provider states a charge other than
 * the one the row was quoted at. One builder, because two places must agree
 * on its words: the provider's adapter writes it on the row when it records
 * the provider's charge (Nuvion's outflow recorder), and the ledger reads it
 * back to know that the difference on a completed row is already explained
 * (`LedgerService.restateCompletedCharge`, FIX-74).
 */
export function chargeDifferenceNote(
  label: string,
  statedKobo: bigint | number,
  quotedKobo: bigint | number,
): string {
  return `${label} charged ${statedKobo} kobo, the quote was ${quotedKobo} kobo; ${label}'s figure is recorded`;
}
