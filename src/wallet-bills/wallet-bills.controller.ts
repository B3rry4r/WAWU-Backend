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
import { ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { RequireFeesSet } from '../money/fees/fees-set.guard';
import {
  CurrentWallet,
  type OpenWallet,
  RequireOpenWallet,
} from '../money/gate/wallet-gate';
import {
  DEBIT_GATE_ERRORS,
  MoneyErrors,
  WALLET_GATE_ERRORS,
} from '../money/money-contract';
import {
  CurrentIdempotencyScope,
  type IdempotencyScope,
  RequireIdempotentApproval,
} from '../money/payments/idempotency';
import { CreateWalletBillDto, PayWalletBillDto } from './wallet-bill.dto';
import { BILL_PAY_ROUTE, WalletBillService } from './wallet-bill.service';
import type {
  WalletBillQuoteView,
  WalletBillView,
} from './wallet-bill-view.type';

/**
 * Pay a bill from the wallet (task BILLS-04, S5 to S7, S11, S12). The web's
 * Flutterwave bills keep `POST bills/init` and `POST bills/:id/verify`
 * untouched; these routes sit under `bills/wallet`, a path no other controller
 * uses. `pay` comes before the id routes, so a request to it is never taken
 * for an id.
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('bills/wallet')
export class WalletBillsController {
  constructor(private readonly bills: WalletBillService) {}

  /**
   * Starts a bill from what S4 collected and answers S5: the bill priced by
   * the server, what it costs line by line (Fintava's bill charge, WAWU's fee
   * and the balance-transfer charge), and the wallet payment's quote with the
   * balance and any shortfall (S11). Nothing is reserved and nothing is
   * debited. A bill below the company's own minimum or above its maximum is
   * `400 amount_out_of_range` with both limits, a meter Fintava does not know
   * is `422 meter_not_found`, a company or bundle that is gone is `404`, and
   * bills that are switched off are `503 bills_unavailable` (or `503
   * provider_unreachable` with `retryAfterSeconds` when Fintava does not
   * answer; a running Fintava-less provider answers `409 target_not_payable`).
   * A person with no wallet gets `409 wallet_not_open`.
   */
  @Post()
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @RequireOpenWallet()
  @MoneyErrors(
    ...WALLET_GATE_ERRORS,
    'target_not_found',
    'target_not_payable',
    'amount_out_of_range',
    'fees_not_set',
  )
  @RequireFeesSet()
  @ApiResponse({
    status: 404,
    description:
      'reason.code biller_not_found, or target_not_found for a bundle or plan that is not offered now.',
  })
  @ApiResponse({
    status: 422,
    description:
      'reason.code meter_not_found: Fintava does not know this meter.',
  })
  create(
    @CurrentWallet() wallet: OpenWallet,
    @Body() dto: CreateWalletBillDto,
  ): Promise<WalletBillQuoteView> {
    return this.bills.create(wallet, dto);
  }

  /**
   * Pays the bill from the wallet, once: the bill, Fintava's charge and
   * WAWU's fee move into WAWU's own account, then the biller is paid out of
   * it. Answers 201 with the bill. `processing` while the payment is not
   * confirmed or the biller has not answered (poll `GET /bills/wallet/{id}`;
   * nothing is ever sent again), `delivered` with the token and units, or
   * `failed` with the money on its way back. The same Idempotency-Key and body
   * answer the first result again (`Idempotent-Replayed: true`) without
   * checking the PIN.
   */
  @Post('pay')
  @HttpCode(201)
  @RequireIdempotentApproval(BILL_PAY_ROUTE)
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
    @Body() dto: PayWalletBillDto,
  ): Promise<WalletBillView> {
    return this.bills.pay(wallet, scope, dto);
  }

  /** The bill's quote again: S5 reopened, or a quote past its `expiresAt`. */
  @Get(':id/quote')
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
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<WalletBillQuoteView> {
    return this.bills.quote(wallet, id);
  }

  /**
   * One bill as it stands now: what the app polls after `processing`, and
   * S7's receipt (token, units, reference) or S12's failure with the money
   * coming back. Only the buyer reads it; another person's bill and an id
   * nobody holds are the same `404 target_not_found`. It reads our own records
   * only and never asks Fintava.
   */
  @Get(':id')
  @Header('Cache-Control', 'no-store')
  @MoneyErrors('target_not_found')
  read(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<WalletBillView> {
    return this.bills.read(user.sub, id);
  }
}
