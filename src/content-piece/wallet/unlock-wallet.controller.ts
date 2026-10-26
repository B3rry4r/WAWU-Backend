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
import { UnlockWalletDto } from './unlock-wallet.dto';
import {
  UNLOCK_WALLET_ROUTE,
  UnlockWalletService,
} from './unlock-wallet.service';
import type {
  UnlockWalletQuoteView,
  UnlockWalletView,
} from './unlock-wallet-view.type';

/**
 * Unlock a piece of content from the wallet (task HOME-15, H14 to H18). The
 * web's Flutterwave routes (`POST /content/:id/unlock` and `/unlock/verify`)
 * are unchanged; every path here is a longer literal under
 * `content/:id/unlock/wallet` that they do not declare. The quote route comes
 * ahead of the one that takes a payment id.
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('content')
export class UnlockWalletController {
  constructor(private readonly unlocks: UnlockWalletService) {}

  /**
   * The pay sheet (H14) before the PIN: the piece, its price, the wallet
   * provider's charge on top, the total, the wallet's balance and the
   * shortfall, and the signed quote `POST /content/:id/unlock/wallet` sends
   * back. Nothing is reserved.
   */
  @Get(':id/unlock/wallet/quote')
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
  ): Promise<UnlockWalletQuoteView> {
    return this.unlocks.quote(wallet, id);
  }

  /**
   * Unlocks the piece from the wallet, once: access is given when the payment
   * is confirmed. Answers 201 with the unlock: `paid` (with `fullAssetUrl`),
   * `pending` while the provider has not confirmed the debit yet (poll
   * `GET /content/{id}/unlock/wallet/{paymentId}`; it is never sent again),
   * or `failed` when the provider refused it and nothing moved. The same
   * Idempotency-Key and body answer the first result again
   * (`Idempotent-Replayed: true`) without checking the PIN. Not enough money
   * is `402 insufficient_funds` with the shortfall; no wallet is `409
   * wallet_not_open`.
   */
  @Post(':id/unlock/wallet')
  @HttpCode(201)
  @RequireIdempotentApproval(UNLOCK_WALLET_ROUTE)
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
  unlock(
    @CurrentWallet() wallet: OpenWallet,
    @CurrentIdempotencyScope() scope: IdempotencyScope,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UnlockWalletDto,
  ): Promise<UnlockWalletView> {
    return this.unlocks.unlock(wallet, scope, id, dto);
  }

  /** One unlock as it stands now: what the app polls after `pending`. Only the payer reads it. */
  @Get(':id/unlock/wallet/:paymentId')
  @Header('Cache-Control', 'no-store')
  @MoneyErrors('not_found')
  read(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
  ): Promise<UnlockWalletView> {
    return this.unlocks.read(user.sub, id, paymentId);
  }
}
