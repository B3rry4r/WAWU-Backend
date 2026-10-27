import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import type { UsdRate } from './store-proceeds';

/** A rate is asked for again after this long. */
const RATE_FRESH_MS = 30 * 60_000;
/** A stored quote older than this is not used. */
const STORED_QUOTE_MAX_AGE_MS = 30 * 24 * 3_600_000;
/** The quote asked for: US$10,000, so the rate carries almost no rounding. */
const QUOTE_USD_MINOR = 1_000_000n;

/**
 * Naira to US dollars for STORE-CUT30. **The FX source is Nuvion's FX quote**,
 * the one rate source the Hub already has (the same quotes its swaps and its
 * pay-from-another-currency use), reached only through `WALLET_PROVIDER.fx`
 * (R-39):
 *
 * 1. a live quote from WAWU's own naira account to US dollars
 *    (`fx.quoteFromMerchant`, the call PAY-FX's refunds use; a quote moves no
 *    money and nothing is sent to the quote for a person), asked at most every
 *    30 minutes; it needs the id of any open USD account the Hub knows, because
 *    the seam checks the destination side's shape;
 * 2. otherwise the newest naira/dollar quote the Hub stored (`FxQuote`, either
 *    way round) from the last 30 days.
 *
 * With neither, there is no rate: nothing is counted this pass (a purchase is
 * never counted at a guessed rate) and the next pass tries again.
 */
@Injectable()
export class StoreUsdRateService {
  private readonly logger = new Logger(StoreUsdRateService.name);
  private cached: { rate: UsdRate; at: number } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(WALLET_PROVIDER) private readonly provider: WalletProvider,
  ) {}

  async current(now = new Date()): Promise<UsdRate | null> {
    if (this.cached && now.getTime() - this.cached.at < RATE_FRESH_MS)
      return this.cached.rate;
    const live = await this.live();
    const rate = live ?? (await this.stored(now));
    if (rate) this.cached = { rate, at: now.getTime() };
    else
      this.logger.warn(
        'store proceeds: no naira to dollar rate is available (no live quote and no stored quote in 30 days); nothing is counted this pass',
      );
    return rate;
  }

  private async live(): Promise<UsdRate | null> {
    const fx = this.provider.fx;
    if (!fx?.quoteFromMerchant) return null;
    try {
      const account = await this.prisma.fxAccount.findFirst({
        where: {
          provider: this.provider.name,
          currency: 'USD',
          status: 'open',
          providerAccountId: { not: null },
        },
        select: { providerAccountId: true },
        orderBy: { createdAt: 'asc' },
      });
      if (!account?.providerAccountId) return null;
      const q = await fx.quoteFromMerchant({
        to: { currency: 'USD', accountId: account.providerAccountId },
        amountToMinor: QUOTE_USD_MINOR,
      });
      if (q.amountFromMinor <= 0n || q.amountToMinor <= 0n) return null;
      return {
        rateKobo: q.amountFromMinor,
        rateCents: q.amountToMinor,
        source: 'nuvion_merchant_quote',
      };
    } catch (e) {
      this.logger.warn(
        `store proceeds: the live quote failed (${e instanceof Error ? e.name : 'error'}); trying the stored quotes`,
      );
      return null;
    }
  }

  private async stored(now: Date): Promise<UsdRate | null> {
    const row = await this.prisma.fxQuote.findFirst({
      where: {
        provider: this.provider.name,
        createdAt: { gte: new Date(now.getTime() - STORED_QUOTE_MAX_AGE_MS) },
        OR: [
          { fromCurrency: 'NGN', toCurrency: 'USD' },
          { fromCurrency: 'USD', toCurrency: 'NGN' },
        ],
        amountFromMinor: { gt: 0n },
        amountToMinor: { gt: 0n },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!row) return null;
    const naira = row.fromCurrency === 'NGN';
    return {
      rateKobo: naira ? row.amountFromMinor : row.amountToMinor,
      rateCents: naira ? row.amountToMinor : row.amountFromMinor,
      source: 'nuvion_stored_quote',
    };
  }
}
