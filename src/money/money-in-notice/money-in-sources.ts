import type { FintavaLedgerCounterpartyKind } from '../../../generated/prisma/client';
import type { MoneyInSource } from '../../notification/notification-event';
import { isSwapCreditName } from '../fx/fx-ledger-words';

/** What a credited ledger row says about itself, read by the words below. */
export interface CreditFacts {
  /** A ledger category; one of `MONEY_IN_CATEGORIES` in practice. */
  category: string;
  /** What the movement paid for (`points_cash_out` on a cash-out). */
  linkKind: string | null;
  counterpartyKind: FintavaLedgerCounterpartyKind | null;
  counterpartyName: string | null;
  counterpartyAccountNumber: string | null;
  counterpartyBankName: string | null;
}

/** The part of a money-in event that depends on where the money came from. */
export interface CreditSource {
  source: MoneyInSource;
  senderName: string | null;
  senderAccountNumber: string | null;
  senderBankName: string | null;
}

const NONE = {
  senderName: null,
  senderAccountNumber: null,
  senderBankName: null,
} as const;

/**
 * Where a credited row came from, in the notification's terms (WALLET-39).
 *
 *  - `top_up`: a bank transfer in. The sender's name and account number as the
 *    provider gave them (WALLET-10: the copy masks the number); the bank when
 *    one was named.
 *  - `transfer`: another person sent it from their WAWU account. Their name
 *    only; the copy shortens it ("Tolu B."), and their account number is not
 *    carried at all. A `transfer` row whose other side is a bank account is a
 *    bank transfer in all the same.
 *  - `swap` (WALK4-FIX L-2): a swap into naira ("Swap from USD" in the ledger). Nobody is named.
 *  - `earning`: earnings landing (WALLET-16, a released hold). A points
 *    cash-out is told as such. Nobody is named: the buyer is not the
 *    creator's business on a lock screen.
 *  - `refund`: a refund. Nobody is named.
 *
 * Anything else is read as a bank transfer in (the words never name an
 * account number beside nothing).
 */
export function creditSourceOf(f: CreditFacts): CreditSource {
  switch (f.category) {
    case 'transfer':
      if (f.counterpartyKind === 'bank_account') return bank(f);
      // WALK4-FIX L-2: the naira a swap into naira credits is the person's own money changing currency, written as a transfer
      // from "Swap from USD". It is told as a swap, never as money from a person called "Swap U.".
      if (
        f.counterpartyKind === 'wawu' &&
        isSwapCreditName(f.counterpartyName)
      ) {
        return { source: 'swap', ...NONE };
      }
      return { source: 'transfer', ...NONE, senderName: f.counterpartyName };
    case 'earning':
      return {
        source: f.linkKind === 'points_cash_out' ? 'points' : 'earning',
        ...NONE,
      };
    case 'refund':
      return { source: 'refund', ...NONE };
    default:
      return bank(f);
  }
}

function bank(f: CreditFacts): CreditSource {
  return {
    source: 'bank',
    senderName: f.counterpartyName,
    senderAccountNumber: f.counterpartyAccountNumber,
    senderBankName: f.counterpartyBankName,
  };
}
