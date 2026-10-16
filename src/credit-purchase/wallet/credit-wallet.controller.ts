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
  CreditWalletPurchaseDto,
  CreditWalletQuoteQueryDto,
} from './credit-wallet.dto';
import {
  CREDIT_WALLET_ROUTE,
  CreditWalletService,
} from './credit-wallet.service';
import type {
  CreditPackListView,
  CreditWalletPurchaseView,
  CreditWalletQuoteView,
} from './credit-wallet-view.type';

/**
 * Buy WAWU Credits from the wallet (task INBOX-16, I28 and I29). The web's
 * Flutterwave routes (`POST /credits/purchase` and `/verify`) are unchanged;
 * every path here is a literal they do not declare. The quote route comes
 * ahead of the one that takes an id, so the word `quote` is not read as an id.
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('credits')
export class CreditWalletController {
  constructor(private readonly credits: CreditWalletService) {}

  /**
   * The packs on sale, from the server's table: how many credits each gives
   * and its price in kobo. Needs no wallet, so the sheet can open before one
   * exists. Credits are a count, never naira (R-5).
   */
  @Get('packs')
  @Header('Cache-Control', 'no-store')
  packs(): CreditPackListView {
    return this.credits.packs();
  }

  /**
   * The pay sheet (I28) before the PIN: the pack's price, the wallet
   * provider's charge on top, the total, the wallet's balance and the
   * shortfall, and the signed quote `POST /credits/purchase/wallet` sends
   * back. Nothing is reserved.
   */
  @Get('purchase/wallet/quote')
  @Header('Cache-Control', 'no-store')
  @RequireOpenWallet()
  @MoneyErrors(...WALLET_GATE_ERRORS, 'target_not_found', 'fees_not_set')
  @RequireFeesSet()
  quote(
    @CurrentWallet() wallet: OpenWallet,
    @Query() query: CreditWalletQuoteQueryDto,
  ): Promise<CreditWalletQuoteView> {
    return this.credits.quote(wallet, query);
  }

  /**
   * Pays for a pack from the wallet, once: the credits are added when the
   * payment is confirmed. Answers 201 with the purchase: `paid`, `pending`
   * while the provider has not confirmed the debit yet (poll
   * `GET /credits/purchase/wallet/{id}`; it is never sent again), or `failed`
   * when the provider refused it and nothing moved. The same Idempotency-Key
   * and body answer the first result again (`Idempotent-Replayed: true`)
   * without checking the PIN. Not enough money is `402 insufficient_funds`
   * with the shortfall; no wallet is `409 wallet_not_open`.
   */
  @Post('purchase/wallet')
  @HttpCode(201)
  @RequireIdempotentApproval(CREDIT_WALLET_ROUTE)
  @MoneyErrors(
    ...DEBIT_GATE_ERRORS,
    'device_approval_refused',
    'daily_limit_exceeded',
    'target_not_found',
    'payment_in_progress',
  )
  @RequireFeesSet()
  buy(
    @CurrentWallet() wallet: OpenWallet,
    @CurrentIdempotencyScope() scope: IdempotencyScope,
    @Body() dto: CreditWalletPurchaseDto,
  ): Promise<CreditWalletPurchaseView> {
    return this.credits.buy(wallet, scope, dto);
  }

  /**
   * One purchase as it stands now: what the app polls after `pending`. Only
   * the buyer reads it; another person's purchase and an id nobody holds are
   * the same `404 not_found`. It reads our own records only.
   */
  @Get('purchase/wallet/:id')
  @Header('Cache-Control', 'no-store')
  @MoneyErrors('not_found')
  read(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CreditWalletPurchaseView> {
    return this.credits.read(user.sub, id);
  }
}
