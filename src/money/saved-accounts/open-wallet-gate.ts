import type { PrismaService } from '../../common/prisma/prisma.service';
import { BALANCE_OPENING_MESSAGE } from '../balance/wallet-balance.service';
import { MoneyError } from '../money-error';
import { stoppedOnIdentity } from '../opening/opening-stops';

/** No wallet yet (R-6): the app leads to Open your wallet. */
export const SAVED_ACCOUNTS_NOT_OPEN_MESSAGE =
  'Open your wallet to save where your money goes.';

/**
 * Beneficiaries and the payout account belong to a wallet, so every route of
 * WALLET-14 needs an open one, answered exactly as the balance answers it
 * (MONEY-11): a FintavaWallet row is open; an opening still in flight (not
 * failed, not stopped on identity) is `409 wallet_opening`; anything else is
 * `409 wallet_not_open`. MONEY-13 builds the one gate for every money route;
 * when it lands, these routes use it and this file goes.
 *
 * `wallet_frozen` is declared on these routes but not answered: nothing
 * stores a freeze yet, and none of these routes moves money (MONEY-13).
 */
export async function requireOpenWallet(
  prisma: PrismaService,
  wawuUserId: string,
): Promise<{ accountNumber: string }> {
  const wallet = await prisma.fintavaWallet.findUnique({
    where: { wawuUserId },
    select: { accountNumber: true },
  });
  if (wallet) return wallet;
  const opening = await prisma.fintavaWalletOpening.findUnique({
    where: { wawuUserId },
    select: { state: true, failure: true },
  });
  if (opening && opening.state !== 'failed' && !stoppedOnIdentity(opening)) {
    throw new MoneyError('wallet_opening', BALANCE_OPENING_MESSAGE);
  }
  throw new MoneyError('wallet_not_open', SAVED_ACCOUNTS_NOT_OPEN_MESSAGE);
}
