import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import { MoneyError } from '../money-error';

const NO_RATE_MESSAGE =
  'We cannot price the card right now. Nothing was taken from your wallet. Try again in a moment.';

/**
 * The card's issuance fee in naira (task NUV-FEES; R-10, R-138). Nuvion's
 * live fee for making a card is in dollars, so the naira the person pays is
 * Nuvion's own rate at that moment: an FX quote from WAWU's naira account for
 * exactly that many dollar cents, asked through `WALLET_PROVIDER.fx`
 * (R-39), the same call PAY-FX's refunds use. A quote moves no money. Its
 * `amountFromMinor` is the naira Nuvion would take for those dollars, already
 * rounded the way Nuvion rounds it.
 *
 * The seam checks a foreign side by its account, so the quote names an open
 * USD account the Hub knows (the person's own first, then any), as the store's
 * dollar rate does. There is no cache: each quote and each card asks again,
 * and no rate means no card and no charge (`409 rate_unavailable`). The rate
 * is never guessed, stored as a default or taken from anywhere but Nuvion.
 */
@Injectable()
export class CardFeeRateService {
  private readonly logger = new Logger(CardFeeRateService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(WALLET_PROVIDER) private readonly provider: WalletProvider,
  ) {}

  /** `usdCents` of US dollars in kobo at Nuvion's rate now; refuses plainly when none can be had. */
  async kobo(usdCents: number, wawuUserId: string): Promise<number> {
    const fx = this.provider.fx;
    if (!fx?.quoteFromMerchant) {
      throw new MoneyError('rate_unavailable', NO_RATE_MESSAGE);
    }
    try {
      const account = await this.usdAccount(wawuUserId);
      if (!account) {
        this.logger.warn(
          'card fee: no open USD account is known, so no rate was asked for',
        );
        throw new MoneyError('rate_unavailable', NO_RATE_MESSAGE);
      }
      const q = await fx.quoteFromMerchant({
        to: { currency: 'USD', accountId: account },
        amountToMinor: BigInt(usdCents),
      });
      const kobo = Number(q.amountFromMinor);
      if (
        q.amountToMinor !== BigInt(usdCents) ||
        !Number.isSafeInteger(kobo) ||
        kobo <= 0
      ) {
        throw new MoneyError('rate_unavailable', NO_RATE_MESSAGE);
      }
      return kobo;
    } catch (e) {
      if (e instanceof MoneyError) throw e;
      this.logger.warn(
        `card fee: the rate could not be had (${e instanceof Error ? e.name : 'error'})`,
      );
      throw new MoneyError('rate_unavailable', NO_RATE_MESSAGE);
    }
  }

  private async usdAccount(wawuUserId: string): Promise<string | null> {
    const where = {
      provider: this.provider.name,
      currency: 'USD',
      status: 'open',
      providerAccountId: { not: null },
    };
    const row =
      (await this.prisma.fxAccount.findFirst({
        where: { ...where, wawuUserId },
        select: { providerAccountId: true },
        orderBy: { createdAt: 'asc' },
      })) ??
      (await this.prisma.fxAccount.findFirst({
        where,
        select: { providerAccountId: true },
        orderBy: { createdAt: 'asc' },
      }));
    return row?.providerAccountId ?? null;
  }
}
