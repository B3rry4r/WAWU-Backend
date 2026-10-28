/**
 * The words the naira side of a swap carries in the ledger ("Swap to USD", "Swap from USD"): the counterparty name and the note.
 * One place, so what writes them (FxOperationsService.ledgerNaira) and what reads them back to tell a person
 * (src/money/money-in-notice/money-in-sources.ts, WALK4-FIX L-2) cannot drift apart.
 */
export const NGN_LEDGER = 'Swap';

/** "Swap to USD" for the naira going out, "Swap from USD" for the naira coming in. */
export function swapLedgerName(out: boolean, other: string | null): string {
  return `${NGN_LEDGER} ${out ? 'to' : 'from'} ${other}`;
}

/** A currency code as the ledger name holds it: USD, EUR, USDT ... */
const SWAP_CREDIT_NAME = new RegExp(`^${NGN_LEDGER} from [A-Z0-9]{2,8}$`);

/** True for the counterparty name of the naira credit a swap into naira writes. */
export function isSwapCreditName(name: string | null | undefined): boolean {
  return typeof name === 'string' && SWAP_CREDIT_NAME.test(name.trim());
}
