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
import {
  PLAN_PURCHASE_ROUTE,
  PlanPurchaseService,
} from './plan-purchase.service';
import type {
  PlanPurchaseQuoteView,
  PlanPurchaseView,
} from './plan-purchase-view.type';

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
    'payment_in_progress',
    'amount_out_of_range',
    'fees_not_set',
  )
  @RequireFeesSet()
  quote(
    @CurrentWallet() wallet: OpenWallet,
    @Query() query: PlanPurchaseQuoteQueryDto,
  ): Promise<PlanPurchaseQuoteView> {
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
    'payment_in_progress',
  )
  @RequireFeesSet()
  buy(
    @CurrentWallet() wallet: OpenWallet,
    @CurrentIdempotencyScope() scope: IdempotencyScope,
    @Body() dto: PlanPurchaseDto,
  ): Promise<PlanPurchaseView> {
    return this.purchases.buy(wallet, scope, dto);
  }

  /**
   * One purchase as it stands now: what the app polls after `pending`.
   * Only the buyer reads it; another person's purchase and an id nobody
   * holds are the same `404 not_found`. It reads our own records only.
   */
  @Get(':id')
  @Header('Cache-Control', 'no-store')
  @MoneyErrors('not_found')
  read(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PlanPurchaseView> {
    return this.purchases.read(user.sub, id);
  }
}
