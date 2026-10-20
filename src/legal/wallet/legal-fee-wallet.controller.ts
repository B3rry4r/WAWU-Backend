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
import { LegalFeeWalletDto } from './legal-fee-wallet.dto';
import {
  LEGAL_FEE_WALLET_ROUTE,
  LegalFeeWalletService,
} from './legal-fee-wallet.service';
import type {
  LegalFeeWalletQuoteView,
  LegalFeeWalletView,
} from './legal-fee-wallet-view.type';

/**
 * Pay a legal fee from the wallet (task LEGAL-05, S19, S22, S26). The web's
 * Flutterwave routes under `legal/requests/:id` (`consultation`,
 * `consultation/verify`, `payment/init`, `payment/verify`) are unchanged;
 * every path here is a literal under `pay/wallet` that they do not declare.
 * The quote route comes ahead of the one that takes a payment id.
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('legal/requests')
export class LegalFeeWalletController {
  constructor(private readonly fees: LegalFeeWalletService) {}

  /**
   * The pay sheet before the PIN: the fee that is due on the request (the
   * consultation fee once an hour is booked, the quoted fee once the
   * engagement letter is signed), the wallet provider's charge on top, the
   * total, the wallet's balance and the shortfall, and the signed quote
   * `POST /legal/requests/{id}/pay/wallet` sends back. Nothing is reserved.
   */
  @Get(':id/pay/wallet/quote')
  @Header('Cache-Control', 'no-store')
  @RequireOpenWallet()
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
  ): Promise<LegalFeeWalletQuoteView> {
    return this.fees.quote(wallet, id);
  }

  /**
   * Pays the fee that is due, once: the request moves on when the payment is
   * confirmed. Answers 201 with the payment: `paid`, `pending` while the
   * provider has not confirmed the debit yet (poll
   * `GET /legal/requests/{id}/pay/wallet/{paymentId}`; it is never sent
   * again), or `failed` when the provider refused it and nothing moved. The
   * same Idempotency-Key and body answer the first result again
   * (`Idempotent-Replayed: true`) without checking the PIN. Not enough money
   * is `402 insufficient_funds` with the shortfall; no wallet is `409
   * wallet_not_open`.
   */
  @Post(':id/pay/wallet')
  @HttpCode(201)
  @RequireIdempotentApproval(LEGAL_FEE_WALLET_ROUTE)
  @MoneyErrors(
    ...DEBIT_GATE_ERRORS,
    'device_approval_refused',
    'daily_limit_exceeded',
    'target_not_found',
    'target_not_payable',
    'payment_in_progress',
  )
  @RequireFeesSet()
  pay(
    @CurrentWallet() wallet: OpenWallet,
    @CurrentIdempotencyScope() scope: IdempotencyScope,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LegalFeeWalletDto,
  ): Promise<LegalFeeWalletView> {
    return this.fees.pay(wallet, scope, id, dto);
  }

  /** One payment as it stands now: what the app polls after `pending`. Only the payer reads it. */
  @Get(':id/pay/wallet/:paymentId')
  @Header('Cache-Control', 'no-store')
  @MoneyErrors('not_found')
  read(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
  ): Promise<LegalFeeWalletView> {
    return this.fees.read(user.sub, id, paymentId);
  }
}
