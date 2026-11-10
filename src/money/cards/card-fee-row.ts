import type { Prisma, WalletCard } from '../../../generated/prisma/client';
import type { LedgerService } from '../ledger/ledger.service';
import type { LedgerRecordResult } from '../ledger/ledger.interface';
import { FEE_ROW_NAME } from '../transfers/wallet-transfer.service';

/**
 * The card's fee in the person's history (CARD-FEE-HISTORY).
 *
 * What a person pays for a card leaves their wallet in up to two moves, and
 * each is one `out` row on their own wallet, so the history adds up to the
 * provider's balance:
 * - the issuer's fee, which the provider takes from the account at the moment
 *   it makes the card (`<card reference>-issuer`), written in the same
 *   database transaction that marks the card made;
 * - WAWU's fee, moved to WAWU's account after the card exists
 *   (`<card reference>-wawu`), written when that transfer is confirmed.
 *
 * Both rows are drawn as a send's fee row is: category `transfer`, the other
 * side `wawu`, named `FEE_ROW_NAME`. The references are the ledger's key
 * (account, direction, reference), so writing one twice is one row.
 */

/** Added to the card's reference for the issuer's fee row. */
export const ISSUER_FEE_SUFFIX = '-issuer';
/** Added to the card's reference for WAWU's fee row (the transfer itself is `<card>-fee`). */
export const WAWU_FEE_ROW_SUFFIX = '-wawu';
/** What the provider sees on the movement; names nobody and nothing personal. */
export const CARD_FEE_ROW_NARRATION = 'WAWU card fee';
/** The note on the row, so a person can tell the card's fee from a send's. */
export const CARD_FEE_ROW_NOTE = 'Card fee';

type Db = Prisma.TransactionClient;

/** One `out` fee row on the person's own wallet, once per reference. */
export function recordCardFeeRow(
  ledger: LedgerService,
  db: Db | undefined,
  card: Pick<WalletCard, 'wawuUserId'>,
  accountNumber: string,
  reference: string,
  kobo: number,
): Promise<LedgerRecordResult | null> {
  if (!Number.isSafeInteger(kobo) || kobo <= 0) return Promise.resolve(null);
  return ledger.record(
    {
      wallet: { kind: 'user', wawuUserId: card.wawuUserId, accountNumber },
      direction: 'out',
      status: 'completed',
      category: 'transfer',
      amountKobo: kobo,
      feeKobo: 0,
      totalKobo: kobo,
      narration: CARD_FEE_ROW_NARRATION,
      note: CARD_FEE_ROW_NOTE,
      references: { customerReference: reference },
      counterparty: { kind: 'wawu', name: FEE_ROW_NAME },
      source: 'send',
    },
    db,
  );
}

/**
 * The issuer's fee row of a card the provider has made. Call it inside the
 * transaction that adopts the card, so the card is "made" and its fee is in
 * the history together or not at all. The amount is the fee the card was
 * claimed with (the provider's fee as configured when the person asked).
 */
export function recordIssuerFeeRow(
  ledger: LedgerService,
  db: Db,
  card: Pick<WalletCard, 'wawuUserId' | 'reference' | 'providerFeeKobo'>,
  accountNumber: string,
): Promise<LedgerRecordResult | null> {
  return recordCardFeeRow(
    ledger,
    db,
    card,
    accountNumber,
    `${card.reference}${ISSUER_FEE_SUFFIX}`,
    Number(card.providerFeeKobo ?? 0n),
  );
}
