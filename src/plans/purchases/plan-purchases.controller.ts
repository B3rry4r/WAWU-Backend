import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import type { WawuJwtClaims } from '../../common/auth/wawu-jwt-claims.interface';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { WawuAuthGuard } from '../../common/guards/wawu-auth.guard';
import { RequireFeesSet } from '../../money/fees/fees-set.guard';
import {
  CurrentWallet,
  type OpenWallet,
  RequireOpenWallet,
} from '../../money/gate/wallet-gate';
import {
  DEBIT_GATE_ERRORS,
  MoneyErrors,
  WALLET_GATE_ERRORS,
} from '../../money/money-contract';
import {
  CurrentIdempotencyScope,
  type IdempotencyScope,
  RequireIdempotentApproval,
} from '../../money/payments/idempotency';
import {
  PlanPurchaseDto,
  PlanPurchaseQuoteQueryDto,
} from './plan-purchase.dto';
import { ExtraProductsEligibilityGuard } from './extra-products-eligibility.guard';
import {
  PLAN_PURCHASE_ROUTE,
  PlanPurchaseService,
  type PurchaseAnswer,
} from './plan-purchase.service';
import type {
  PendingPlanPurchaseView,
  PlanPurchaseQuoteView,
} from './plan-purchase-view.type';
import type { ExtraProductsQuoteView } from './extra-products-view.type';
import type { PointsPackQuoteView } from './points-pack-view.type';

/**
 * Buy, renew or upgrade a tier from the wallet (task TIER-03, VF5 to VF7).
 * `plans/purchases` is a path nothing else declares (`GET /plans` is the
 * plan's prices); the quote is declared before the id so `quote` is never
 * read as one.
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('plans/purchases')
export class PlanPurchasesController {
  constructor(private readonly purchases: PlanPurchaseService) {}

  /**
   * The pay sheet (VF6) before the PIN: the purchase priced in the caller's
   * billing currency (an upgrade is the difference of the two prices), the
   * wallet provider's charge on top, the total, the wallet's balance and the
   * shortfall, and the signed quote `POST /plans/purchases` sends back.
   * `kind=points_pack&packId=` is a points pack (POINTS-02, PT4): answers a
   * `PointsPackQuoteView` with the pack's price and points, the Founding
   * Maker's bonus points (0 for anyone else) and how long the points last.
   * `kind=extra_products` is the add-on that gives more product places
   * (TIER-04, VF13): answers an `ExtraProductsQuoteView` with the price, how
   * many products it adds and the places the person has now and would have;
   * without a tier that is running it is `402 tier_required`.
   * Nothing is reserved. A purchase that does not fit what the caller holds
   * is `target_not_payable` with the reason in words; a plan payment still
   * going through is `payment_in_progress`.
   */
  @Get('quote')
  @Header('Cache-Control', 'no-store')
  @RequireOpenWallet()
  @MoneyErrors(
    ...WALLET_GATE_ERRORS,
    'target_not_found',
    'target_not_payable',
    'tier_required',
    'pack_not_allowed',
    'payment_in_progress',
    'amount_out_of_range',
    'fees_not_set',
  )
  // Above RequireFeesSet, so it runs right after FeesSetGuard and before any wallet gate: auth, fees_not_set, then the pack's eligibility (R-100).
  @UseGuards(ExtraProductsEligibilityGuard)
  @RequireFeesSet()
  quote(
    @CurrentWallet() wallet: OpenWallet,
    @Query() query: PlanPurchaseQuoteQueryDto,
  ): Promise<
    PlanPurchaseQuoteView | PointsPackQuoteView | ExtraProductsQuoteView
  > {
    return this.purchases.quote(wallet, query);
  }

  /**
   * Pays for a tier from the wallet, once: the tier and its dates, the bonus
   * points as one lot with its expiry, the event pass and the first Voice
   * Intro are granted when the payment is confirmed, and the checkout bump's
   * points with them when it was bought. Answers 201 with the purchase:
   * `paid`, `pending` while the provider has not confirmed the debit yet
   * (poll `GET /plans/purchases/{id}`; it is never sent again), or `failed`
   * when the provider refused it and nothing moved. The same Idempotency-Key
   * and body answer the first result again (`Idempotent-Replayed: true`)
   * without checking the PIN. Not enough money is `402 insufficient_funds`
   * with the shortfall; no wallet is `409 wallet_not_open`.
   *
   * `method: transfer` (TIER-05, VF6 "transfer details shown") confirms the
   * purchase with the PIN at the quote the person saw and takes nothing. It
   * answers 201 with a `PlanTransferOrderView`, `awaiting_transfer`: the
   * wallet's own account number, bank and account name, the Bank charge and
   * the amount still needed (the total less the available balance, never
   * below 0). The purchase is paid from the wallet, once, the moment the
   * balance covers the total, and then reads like any other purchase under
   * the same id. A quote that changed is `409 quote_changed`; the time to send
   * the money (an admin setting) runs out as `expired`, with nothing taken.
   * Two requests for one item leave one waiting purchase.
   *
   * `kind: points_pack` with a `packId` buys a points pack the same way
   * (POINTS-02, PT4 to PT4c), from the wallet or by transfer: one lot of the
   * pack's points (plus the Founding Maker's bonus) is added once, ending
   * after the bought-points expiry, and the answer is a `PointsPackPurchaseView`
   * (`kind: "points_pack"`).
   *
   * `kind: extra_products` (TIER-04, VF13) adds the settings' number of
   * products to the tier the person holds, the same way: from the wallet or
   * by transfer, added once, kept by the account whatever happens to the tier
   * after, and answered as an `ExtraProductsPurchaseView`
   * (`kind: "extra_products"`). Without a tier that is running it is `402
   * tier_required` and nothing is taken.
   */
  @Post()
  @HttpCode(201)
  @RequireIdempotentApproval(PLAN_PURCHASE_ROUTE)
  @MoneyErrors(
    ...DEBIT_GATE_ERRORS,
    'device_approval_refused',
    'daily_limit_exceeded',
    'target_not_found',
    'target_not_payable',
    'tier_required',
    'pack_not_allowed',
    'payment_in_progress',
  )
  // Right after FeesSetGuard, before the wallet gate (R-100).
  @UseGuards(ExtraProductsEligibilityGuard)
  @RequireFeesSet()
  buy(
    @CurrentWallet() wallet: OpenWallet,
    @CurrentIdempotencyScope() scope: IdempotencyScope,
    @Body() dto: PlanPurchaseDto,
  ): Promise<PurchaseAnswer> {
    return this.purchases.buy(wallet, scope, dto);
  }

  /**
   * The purchase still going through for the caller, or `purchase: null`
   * (ME-13, M15): a payment still confirming, or confirmed and not yet
   * opened, the same ones that make a second purchase `payment_in_progress`.
   * Declared before the id, so the word `pending` is not taken for an id. It
   * needs no wallet: a person with none has nothing going through.
   */
  @Get('pending')
  @Header('Cache-Control', 'no-store')
  pending(
    @CurrentUser() user: WawuJwtClaims,
  ): Promise<PendingPlanPurchaseView> {
    return this.purchases.pending(user.sub);
  }

  /**
   * One purchase as it stands now: what the app polls after `pending`, and
   * while it waits for a bank transfer (`awaiting_transfer`, with the amount
   * still needed read from the provider's balance; `null` when the provider
   * does not answer). Only the buyer reads it; another person's purchase and
   * an id nobody holds are the same `404 not_found`.
   */
  @Get(':id')
  @Header('Cache-Control', 'no-store')
  @MoneyErrors('not_found')
  read(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PurchaseAnswer> {
    return this.purchases.read(user.sub, id);
  }
}
