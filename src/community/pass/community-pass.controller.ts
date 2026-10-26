import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
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
  AllowWorldWallet,
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
import { CommunityPassDto } from './community-pass.dto';
import {
  COMMUNITY_PASS_ROUTE,
  CommunityPassService,
} from './community-pass.service';
import type {
  CommunityPassPurchaseView,
  CommunityPassQuoteView,
  CommunityPassView,
} from './community-pass-view.type';

/**
 * A private community's monthly pass (task INBOX-24, R-63; I30, I31). Every
 * path here is a literal the web does not declare. The quote route comes ahead
 * of the one that takes a payment id, so the word `quote` is not read as an id.
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('communities')
export class CommunityPassController {
  constructor(private readonly passes: CommunityPassService) {}

  /**
   * Where the caller stands with this room's pass: the host's price, when
   * their pass ends, and whether they can buy or renew. Needs no wallet, so
   * the landing (I30) can open before one exists.
   */
  @Get(':id/pass')
  @Header('Cache-Control', 'no-store')
  pass(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: WawuJwtClaims,
  ): Promise<CommunityPassView> {
    return this.passes.pass(id, user.sub);
  }

  /**
   * The pay sheet before the PIN: the host's price, the wallet provider's
   * charge and WAWU's fee on top, the total, the wallet's balance and the
   * shortfall, when the pass would end, and the signed quote
   * `POST /communities/{id}/pass` sends back. Nothing is reserved.
   */
  @Get(':id/pass/quote')
  @Header('Cache-Control', 'no-store')
  @RequireOpenWallet({ world: true })
  @MoneyErrors(
    ...WALLET_GATE_ERRORS,
    'target_not_found',
    'target_not_payable',
    'fees_not_set',
  )
  @RequireFeesSet()
  quote(
    @CurrentWallet() wallet: OpenWallet,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CommunityPassQuoteView> {
    return this.passes.quote(wallet, id);
  }

  /**
   * Pays for 30 days from the wallet, once: the person is in when the payment
   * is confirmed. Paying before the end extends from the current end date.
   * Answers 201 with the purchase: `paid`, `pending` while the provider has
   * not confirmed the debit yet (poll `GET /communities/{id}/pass/{paymentId}`;
   * it is never sent again), `failed` when the provider refused it and nothing
   * moved, or `refunded` when the pass could not be given and everything paid
   * is going back. The same Idempotency-Key and body answer the first result
   * again (`Idempotent-Replayed: true`) without checking the PIN. Not enough
   * money is `402 insufficient_funds` with the shortfall; no wallet is `409
   * wallet_not_open`. Nothing is ever debited without this request.
   */
  @Post(':id/pass')
  @HttpCode(201)
  @RequireIdempotentApproval(COMMUNITY_PASS_ROUTE)
  @AllowWorldWallet()
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
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CommunityPassDto,
  ): Promise<CommunityPassPurchaseView> {
    return this.passes.buy(wallet, scope, id, dto);
  }

  /**
   * One purchase as it stands now: what the app polls after `pending`. Only
   * the payer reads it, for the room in the path; another person's purchase
   * and an id nobody holds are the same `404 not_found`.
   */
  @Get(':id/pass/:paymentId')
  @Header('Cache-Control', 'no-store')
  @MoneyErrors('not_found')
  read(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
  ): Promise<CommunityPassPurchaseView> {
    return this.passes.read(user.sub, id, paymentId);
  }
}
