import { HttpException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { FintavaClient } from '../../fintava/fintava-client';
import { FINTAVA_DEFAULTS } from '../../fintava/fintava-config';
import { FintavaError } from '../../fintava/fintava-error';
import { MoneyError } from '../money-error';
import type { WalletBalanceView } from '../money-view.type';
import { stoppedOnIdentity } from '../opening/opening-stops';

/** W6's refusal: the bank did not answer, so there is no figure to show. */
export const BALANCE_UNREACHABLE_MESSAGE =
  'We could not reach your account. Your money is safe. Try again in a moment.';

/** No wallet yet (R-6): the app leads to Open your wallet (MONEY-12, MONEY-13). */
export const BALANCE_NOT_OPEN_MESSAGE = 'Open your wallet to see your balance.';

/** The account is still being opened (MONEY-12, A7). */
export const BALANCE_OPENING_MESSAGE =
  'Your account is still being opened. Check again in a moment.';

/**
 * The caller's Naira balance (task MONEY-11): Fintava's `availableBalance`,
 * asked for on every request and never anything else.
 *
 * - Never a sum of our own records, and never cached: there is no stored
 *   balance anywhere to fall back on, so when Fintava does not answer the
 *   only honest answer is `503 provider_unreachable` (W6), never a 0.
 * - Naira becomes kobo once, inside the MONEY-06 client
 *   (`fintavaAmountToKobo`, decimal text, no float arithmetic). This file
 *   passes the integer through untouched.
 * - The wallet is found from the caller's token only. No request names a
 *   wallet, so nobody can ask for somebody else's.
 */
@Injectable()
export class WalletBalanceService {
  private readonly logger = new Logger(WalletBalanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fintava: FintavaClient,
  ) {}

  async balance(wawuUserId: string): Promise<WalletBalanceView> {
    const wallet = await this.prisma.fintavaWallet.findUnique({
      where: { wawuUserId },
      select: { walletId: true },
    });
    if (!wallet) {
      // A7: the account is being opened (MONEY-12), so the app waits
      // rather than sending the person back to Open your wallet.
      const opening = await this.prisma.fintavaWalletOpening.findUnique({
        where: { wawuUserId },
        select: { state: true, failure: true },
      });
      if (
        opening &&
        opening.state !== 'failed' &&
        !stoppedOnIdentity(opening)
      ) {
        throw new MoneyError('wallet_opening', BALANCE_OPENING_MESSAGE);
      }
      throw new MoneyError('wallet_not_open', BALANCE_NOT_OPEN_MESSAGE);
    }

    try {
      const balance = await this.fintava.getWalletBalance(wallet.walletId);
      return {
        availableKobo: balance.availableKobo,
        asOf: new Date().toISOString(),
      };
    } catch (e) {
      if (e instanceof FintavaError) throw this.refusal(e);
      throw e;
    }
  }

  /**
   * A failed balance read in the contract's shape. A frozen wallet keeps the
   * client's own mapping (`wallet_inactive` to `423 wallet_frozen`). Every
   * other failure is W6: the client's kinds for a read that did not work
   * (timeout, no connection, 5xx, rate limit, an unreadable answer, a key
   * problem, no key) and Fintava saying it has no wallet under the id we
   * stored, which is ours to look into, not the person's to fix by opening
   * a second wallet.
   */
  private refusal(error: FintavaError): HttpException {
    if (error.kind === 'wallet_inactive') return error.toHttpException();
    if (error.kind === 'not_found') {
      this.logger.warn(
        'wallet balance: Fintava has no wallet under a stored walletId',
      );
    }
    return new MoneyError('provider_unreachable', BALANCE_UNREACHABLE_MESSAGE, {
      retryAfterSeconds: FINTAVA_DEFAULTS.retryAfterSeconds,
    });
  }
}
