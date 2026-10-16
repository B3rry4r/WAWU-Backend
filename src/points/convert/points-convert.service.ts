import { Inject, Injectable } from '@nestjs/common';
import {
  BillingCurrencyService,
  type BillingClaims,
} from '../../plans/billing-currency.service';
import { PLANS_CONFIG, type PlansConfig } from '../../plans/plans-config';
import { FeeQuoteService } from '../../money/fees/fee-quote.service';
import { MoneyError } from '../../money/money-error';
import { safeKoboNumber } from '../../wallet-provider/wallet-provider.interface';
import { PointsError } from '../points-error';
import { POINTS_WORD } from '../points-words';
import { PointsService } from '../points.service';
import { PointsCashOutService } from './points-cash-out.service';
import type { IdempotencyScope } from '../../money/payments/idempotency';
import {
  BELOW_MINIMUM_WORDS,
  cashForPoints,
  CURRENCY_WORDS,
  POINTS_PER_RATE_UNIT,
  pointsWithinCap,
  TOO_MUCH_WORDS,
} from './points-convert-rules';
import type {
  ConvertBlockedBy,
  PointsConversionView,
  PointsConvertQuoteView,
} from './points-convert-view.type';

/**
 * Points to cash, as a person meets it (task POINTS-04, PT6): the quote
 * before the PIN, the checks that come before the PIN, and the conversion.
 * The rate and the minimum are the config's (TIER-01), never the design's;
 * the provider's cap on one move is the running provider's. The moving of the
 * cash is `PointsCashOutService`.
 *
 * A person billed in dollars is refused in plain words: their cash would be
 * dollars and the dollar wallet is not built yet (NUV-09). They are not
 * charged and nothing is held.
 */
@Injectable()
export class PointsConvertService {
  constructor(
    @Inject(PLANS_CONFIG) private readonly config: PlansConfig,
    private readonly currency: BillingCurrencyService,
    private readonly points: PointsService,
    private readonly fees: FeeQuoteService,
    private readonly cashOut: PointsCashOutService,
  ) {}

  /**
   * What PT6 shows before the PIN: the rate, the minimum, the balance, and
   * the cash for the points asked about (the whole balance when none is
   * asked). It answers `canConvert` and, when false, `blockedBy`, instead of
   * refusing, so the screen can draw "below the minimum" with the figures.
   * Nothing is held or sent. A dollar-billed person gets
   * `409 currency_not_supported`.
   */
  async quote(
    wawuUserId: string,
    claims: BillingClaims,
    asked?: number,
  ): Promise<PointsConvertQuoteView> {
    await this.requireNairaAccount(wawuUserId, claims);
    const balance = await this.points.balanceOf(wawuUserId);
    const points = asked ?? balance;
    const rate = this.rate();
    const minimum = this.config.cashOut.minimumPoints;
    const maximum = pointsWithinCap(this.cap(), rate);
    let blockedBy: ConvertBlockedBy | null = null;
    if (points < minimum) blockedBy = 'below_minimum';
    else if (maximum !== null && points > maximum) blockedBy = 'above_maximum';
    else if (points > balance) blockedBy = 'insufficient_points';
    return {
      currency: 'NGN',
      balancePoints: balance,
      minimumPoints: minimum,
      maximumPoints: maximum,
      rate: { points: Number(POINTS_PER_RATE_UNIT), kobo: rate },
      points,
      cashKobo: safeKoboNumber(cashForPoints(points, rate)),
      feeKobo: 0,
      wawuPaysProviderCharge: true,
      canConvert: blockedBy === null,
      blockedBy,
    };
  }

  /**
   * The checks that come before the PIN, so a request that cannot succeed
   * never uses up a PIN try and changes nothing: a dollar-billed person,
   * fewer points than the minimum, more cash than one move may carry, more
   * points than the person has. (No wallet is the wallet gate's, ahead of
   * this.) The conversion checks the balance again under the person's points
   * lock, so this read decides nothing on its own.
   */
  async assertMayConvert(
    wawuUserId: string,
    claims: BillingClaims,
    points: number,
  ): Promise<void> {
    await this.requireNairaAccount(wawuUserId, claims);
    const rate = this.rate();
    const minimum = this.config.cashOut.minimumPoints;
    const balance = await this.points.balanceOf(wawuUserId);
    if (points < minimum) {
      throw new MoneyError('below_minimum', BELOW_MINIMUM_WORDS, {
        minimumPoints: minimum,
        balancePoints: balance,
      });
    }
    const cash = cashForPoints(points, rate);
    const cap = this.cap();
    if (cash <= 0n || (cap !== null && cash > BigInt(cap))) {
      throw new MoneyError('amount_out_of_range', TOO_MUCH_WORDS, {
        ...(cap !== null ? { maximumKobo: cap } : {}),
      });
    }
    if (points > balance) {
      throw new PointsError(
        'insufficient_points',
        `You don't have enough ${POINTS_WORD} for this.`,
        {
          balancePoints: balance,
          neededPoints: points,
          shortfallPoints: points - balance,
        },
      );
    }
  }

  /**
   * Turns the points into cash (the checks above are made again here, since
   * a guard's read can be stale): the points are held, the cash is paid from
   * WAWU's account into the wallet, and the hold is committed once the
   * provider has confirmed it.
   */
  async convert(
    wawuUserId: string,
    claims: BillingClaims,
    points: number,
    scope: IdempotencyScope,
  ): Promise<PointsConversionView> {
    await this.assertMayConvert(wawuUserId, claims, points);
    const rate = this.rate();
    return this.cashOut.start({
      wawuUserId,
      points,
      per1000PointsKobo: rate,
      cashKobo: cashForPoints(points, rate),
      scope,
    });
  }

  /** One conversion, for the person it belongs to. */
  read(wawuUserId: string, id: string): Promise<PointsConversionView> {
    return this.cashOut.read(wawuUserId, id);
  }

  /** Kobo paid for 1,000 points (config). */
  private rate(): number {
    return this.config.cashOut.per1000Points.kobo;
  }

  /** The provider's cap on one move through WAWU's account, or null. */
  private cap(): number | null {
    return this.fees.providerFees.merchantMaxPerTxnKobo;
  }

  private async requireNairaAccount(
    wawuUserId: string,
    claims: BillingClaims,
  ): Promise<void> {
    const billing = await this.currency.resolve(wawuUserId, claims);
    if (billing.currency !== 'NGN') {
      throw new MoneyError('currency_not_supported', CURRENCY_WORDS);
    }
  }
}
