import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { isRowOf } from '../../wallet-provider/provider-rows';
import {
  safeKoboNumber,
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import { WalletProviderError } from '../../wallet-provider/wallet-provider-error';
import type { OpenWallet } from '../gate/wallet-gate';
import { MoneyError } from '../money-error';
import type { WalletBalanceView } from '../money-view.type';

/** W6's refusal: the bank did not answer, so there is no figure to show. */
export const BALANCE_UNREACHABLE_MESSAGE =
  'We could not reach your account. Your money is safe. Try again in a moment.';

/**
 * The caller's Naira balance (task MONEY-11): the wallet provider's
 * available balance (Fintava's `availableBalance`), asked for on every
 * request and never anything else. Read through the wallet provider seam
 * (MONEY-20), never a provider's client.
 *
 * - Never a sum of our own records, and never cached: there is no stored
 *   balance anywhere to fall back on, so when Fintava does not answer the
 *   only honest answer is `503 provider_unreachable` (W6), never a 0.
 * - Naira becomes kobo once, inside the MONEY-06 client
 *   (`fintavaAmountToKobo`, decimal text, no float arithmetic). This file
 *   passes the integer through untouched.
 * - The wallet is found from the caller's token only. No request names a
 *   wallet, so nobody can ask for somebody else's.
 * - No wallet yet, or one still being opened, never gets here: the route's
 *   wallet gate (MONEY-13) answers first, with the same body every wallet
 *   route gives.
 * - Only a wallet of the provider the server runs is asked about (NUV-01):
 *   after a rollback, a wallet another provider holds is never sent to this
 *   one (its id means nothing here). It answers W6's 503, which is true:
 *   the bank that holds that money is not reachable from this server.
 */
@Injectable()
export class WalletBalanceService {
  private readonly logger = new Logger(WalletBalanceService.name);

  constructor(
    @Inject(WALLET_PROVIDER) private readonly provider: WalletProvider,
    private readonly prisma: PrismaService,
  ) {}

  /** The balance of the wallet the gate found for the caller. */
  async balance(
    wallet: Pick<OpenWallet, 'wawuUserId' | 'walletId'>,
  ): Promise<WalletBalanceView> {
    const row = await this.prisma.fintavaWallet.findUnique({
      where: { wawuUserId: wallet.wawuUserId },
      select: { provider: true },
    });
    if (!isRowOf(this.provider.name, row?.provider)) {
      this.logger.warn(
        `wallet balance: the wallet is held by another provider than ${this.provider.label}; not asked`,
      );
      throw new MoneyError(
        'provider_unreachable',
        BALANCE_UNREACHABLE_MESSAGE,
        {
          retryAfterSeconds: this.provider.timings.retryAfterSeconds,
        },
      );
    }
    try {
      const balance = await this.provider.getBalance({
        walletId: wallet.walletId,
      });
      return {
        availableKobo: safeKoboNumber(balance.availableKobo),
        asOf: new Date().toISOString(),
      };
    } catch (e) {
      if (e instanceof WalletProviderError) throw this.refusal(e);
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
  private refusal(error: WalletProviderError): HttpException {
    if (error.kind === 'wallet_inactive') return error.toHttpException();
    if (error.kind === 'not_found') {
      this.logger.warn(
        `wallet balance: ${this.provider.label} has no wallet under a stored walletId`,
      );
    }
    return new MoneyError('provider_unreachable', BALANCE_UNREACHABLE_MESSAGE, {
      retryAfterSeconds: this.provider.timings.retryAfterSeconds,
    });
  }
}
