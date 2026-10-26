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
import { ApiPaySourceHeader } from '../../money/payments/pay-source-context';
import { ApiBearerAuth } from '@nestjs/swagger';
import type { WawuJwtClaims } from '../../common/auth/wawu-jwt-claims.interface';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { WawuAuthGuard } from '../../common/guards/wawu-auth.guard';
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
import { RequireFeesSet } from '../../money/fees/fees-set.guard';
import { TipWalletDto, TipWalletQuoteQueryDto } from './tip-wallet.dto';
import { TIP_WALLET_ROUTE, TipWalletService } from './tip-wallet.service';
import type { TipWalletQuoteView, TipWalletView } from './tip-wallet-view.type';

/**
 * Tip a creator from the wallet (task HOME-14, H26 to H28). The web's
 * Flutterwave routes (`POST /tips` and `/tips/verify`) are unchanged; every
 * path here is a literal under `tips/wallet` that they do not declare. The
 * quote route comes ahead of the one that takes an id.
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('tips/wallet')
export class TipWalletController {
  constructor(private readonly tips: TipWalletService) {}

  /**
   * The pay sheet (H26) before the PIN: the creator, the amount, the wallet
   * provider's charge on top, the total, the wallet's balance and the
   * shortfall, and the signed quote `POST /tips/wallet` sends back. Nothing
   * is reserved.
   */
  @Get('quote')
  @ApiPaySourceHeader()
  @Header('Cache-Control', 'no-store')
  @RequireOpenWallet({ world: true })
  @MoneyErrors(
    ...WALLET_GATE_ERRORS,
    'target_not_found',
    'target_not_payable',
    'amount_out_of_range',
    'fees_not_set',
  )
  @RequireFeesSet()
  quote(
    @CurrentWallet() wallet: OpenWallet,
    @Query() query: TipWalletQuoteQueryDto,
  ): Promise<TipWalletQuoteView> {
    return this.tips.quote(wallet, query);
  }

  /**
   * Sends a tip from the wallet, once, with an optional note: answers 201
   * with the tip: `paid`, `pending` while the provider has not confirmed the
   * debit yet (poll `GET /tips/wallet/{id}`; it is never sent again), or
   * `failed` when the provider refused it and nothing moved. The same
   * Idempotency-Key and body answer the first result again
   * (`Idempotent-Replayed: true`) without checking the PIN. Not enough money
   * is `402 insufficient_funds` with the shortfall; no wallet is `409
   * wallet_not_open`.
   */
  @Post()
  @ApiPaySourceHeader()
  @HttpCode(201)
  @RequireIdempotentApproval(TIP_WALLET_ROUTE)
  @AllowWorldWallet()
  @MoneyErrors(
    ...DEBIT_GATE_ERRORS,
    'device_approval_refused',
    'daily_limit_exceeded',
    'target_not_found',
    'target_not_payable',
    'amount_out_of_range',
    'payment_in_progress',
  )
  @RequireFeesSet()
  tip(
    @CurrentWallet() wallet: OpenWallet,
    @CurrentIdempotencyScope() scope: IdempotencyScope,
    @Body() dto: TipWalletDto,
  ): Promise<TipWalletView> {
    return this.tips.tip(wallet, scope, dto);
  }

  /** One tip as it stands now: what the app polls after `pending`. Only the payer reads it. */
  @Get(':id')
  @Header('Cache-Control', 'no-store')
  @MoneyErrors('not_found')
  read(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TipWalletView> {
    return this.tips.read(user.sub, id);
  }
}
