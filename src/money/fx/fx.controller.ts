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
import { WawuAuthGuard } from '../../common/guards/wawu-auth.guard';
import { RequireFeesSet } from '../fees/fees-set.guard';
import {
  CurrentWallet,
  type OpenWallet,
  RequireOpenWallet,
} from '../gate/wallet-gate';
import {
  BuiltBy,
  DEBIT_GATE_ERRORS,
  MoneyErrors,
  WALLET_GATE_ERRORS,
} from '../money-contract';
import {
  CurrentIdempotencyScope,
  type IdempotencyScope,
  RequireIdempotentApproval,
} from '../payments/idempotency';
import {
  FxPageQueryDto,
  FxQuoteDto,
  FxSendDto,
  FxSendQuoteQueryDto,
  FxSwapDto,
  OpenFxAccountDto,
} from './dto/fx-request.dto';
import { FxAccountsService } from './fx-accounts.service';
import { FxOperationsService } from './fx-operations.service';
import { FX_SEND_ROUTE, FX_SWAP_ROUTE } from './fx-routes';
import type {
  FxAccountListView,
  FxAccountView,
  FxCurrenciesView,
  FxQuoteView,
  FxSendQuoteView,
  FxSendView,
  FxSwapView,
  FxTransactionPage,
} from './fx-view.type';

/**
 * Dollar, other-currency and stablecoin accounts, swaps and crypto sends on
 * Nuvion (task WALLET-21, R-83, R-84), served. Every route needs an open
 * naira wallet (R-6: the identity checks happen once, when it is opened) and
 * reaches the provider only through `WALLET_PROVIDER`; a provider without
 * foreign accounts (Fintava) answers `409 currency_not_supported`.
 * docs/contract/CONVENTIONS.md section 27.
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('money/fx')
export class FxController {
  constructor(
    private readonly accounts: FxAccountsService,
    private readonly operations: FxOperationsService,
  ) {}

  /**
   * What can be opened, in what units, and what an admin has switched off:
   * each currency's `enabled` and the three products. The app draws only
   * what is on (R-47). Reads settings only; no provider call.
   */
  @Get('currencies')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('WALLET-21')
  @RequireOpenWallet()
  @MoneyErrors(...WALLET_GATE_ERRORS, 'currency_not_supported')
  currencies(): FxCurrenciesView {
    return this.accounts.currencies();
  }

  /**
   * The person's foreign accounts, each with the provider's balance (read
   * now, never a sum of our rows) and the details payers use: a US account
   * number, routing number and SWIFT code, or a wallet address on the
   * account's chain. An account whose details are not issued yet says
   * `pending`; its balance is null if the provider cannot be asked.
   */
  @Get('accounts')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('WALLET-21')
  @RequireOpenWallet()
  @MoneyErrors(
    ...WALLET_GATE_ERRORS,
    'currency_not_supported',
    'provider_unreachable',
  )
  list(@CurrentWallet() wallet: OpenWallet): Promise<FxAccountListView> {
    return this.accounts.list(wallet);
  }

  /**
   * Opens an account in one currency on the person's Nuvion entity. Asking
   * again for an account the person has returns it. A stablecoin needs its
   * `chain`. Refused with `fx_switched_off` when an admin switched the
   * currency or "open account" off, and with `provider_declined` (the
   * provider's plain words) when Nuvion will not open it for this person.
   */
  @Post('accounts')
  @HttpCode(201)
  @BuiltBy('WALLET-21')
  @RequireOpenWallet()
  @MoneyErrors(
    ...WALLET_GATE_ERRORS,
    'currency_not_supported',
    'fx_switched_off',
    'chain_mismatch',
    'provider_declined',
    'provider_unreachable',
  )
  open(
    @CurrentWallet() wallet: OpenWallet,
    @Body() dto: OpenFxAccountDto,
  ): Promise<FxAccountView> {
    return this.accounts.open(wallet, dto);
  }

  /** One account, as the list shows it. */
  @Get('accounts/:id')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('WALLET-21')
  @RequireOpenWallet()
  @MoneyErrors(
    ...WALLET_GATE_ERRORS,
    'currency_not_supported',
    'not_found',
    'provider_unreachable',
  )
  account(
    @CurrentWallet() wallet: OpenWallet,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<FxAccountView> {
    return this.accounts.get(wallet, id);
  }

  /**
   * The account's movements, newest first, read from the provider's
   * statement (the provider is the truth). A swap shows its conversion.
   */
  @Get('accounts/:id/transactions')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('WALLET-21')
  @RequireOpenWallet()
  @MoneyErrors(
    ...WALLET_GATE_ERRORS,
    'currency_not_supported',
    'not_found',
    'provider_unreachable',
  )
  transactions(
    @CurrentWallet() wallet: OpenWallet,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: FxPageQueryDto,
  ): Promise<FxTransactionPage> {
    return this.accounts.transactions(wallet, id, query);
  }

  /**
   * A quote for converting between two of the person's accounts (a foreign
   * account, a stablecoin account or the naira wallet): the provider's rate,
   * both amounts, WAWU's fee from config, and the provider's real expiry
   * (`expiresAt`; about three minutes for a currency pair, two for a
   * stablecoin pair on dev). The quote is kept for this person and used once.
   */
  @Post('quotes')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @BuiltBy('WALLET-21')
  @RequireOpenWallet()
  @MoneyErrors(
    ...WALLET_GATE_ERRORS,
    'currency_not_supported',
    'fx_switched_off',
    'fx_account_not_open',
    'account_frozen',
    'amount_out_of_range',
    'provider_declined',
    'provider_unreachable',
  )
  quote(
    @CurrentWallet() wallet: OpenWallet,
    @Body() dto: FxQuoteDto,
  ): Promise<FxQuoteView> {
    return this.operations.quote(wallet, dto);
  }

  /**
   * Swaps at a held quote: one book transfer between the person's own
   * accounts, carrying the quote's id, so the rate is the one shown. The
   * Idempotency-Key and the PIN are required. Answers 201 with the swap
   * (`completed`, or `pending` when the provider has not finished it: poll
   * `GET /money/fx/swaps/{id}`). An expired or used quote is `409
   * quote_expired` (ask for a new one); a frozen account `423
   * account_frozen`. The same key and body answer the first result again
   * (`Idempotent-Replayed: true`) without checking the PIN.
   */
  @Post('swaps')
  @HttpCode(201)
  @BuiltBy('WALLET-21')
  @RequireIdempotentApproval(FX_SWAP_ROUTE)
  @MoneyErrors(
    ...DEBIT_GATE_ERRORS,
    'device_approval_refused',
    'currency_not_supported',
    'fx_switched_off',
    'quote_expired',
    'account_frozen',
    'fx_account_not_open',
    'daily_limit_exceeded',
    'not_found',
    'provider_declined',
  )
  @RequireFeesSet()
  swap(
    @CurrentWallet() wallet: OpenWallet,
    @CurrentIdempotencyScope() scope: IdempotencyScope,
    @Body() dto: FxSwapDto,
  ): Promise<FxSwapView> {
    return this.operations.swap(wallet, scope, dto);
  }

  /** One swap as it stands now: the app reads it while a swap is unfinished. Only the owner reads it. */
  @Get('swaps/:id')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('WALLET-21')
  @RequireOpenWallet()
  @MoneyErrors(...WALLET_GATE_ERRORS, 'currency_not_supported', 'not_found')
  swapById(
    @CurrentWallet() wallet: OpenWallet,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<FxSwapView> {
    return this.operations.readSwap(wallet, id);
  }

  /**
   * What a crypto send costs before the PIN: the chain must be the account's
   * (`chain_mismatch`), WAWU's fee from config, and the provider's network
   * fee, which the provider names only when it takes the send (null here;
   * the send's receipt carries it).
   */
  @Get('sends/quote')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('WALLET-21')
  @RequireOpenWallet()
  @MoneyErrors(
    ...WALLET_GATE_ERRORS,
    'currency_not_supported',
    'fx_switched_off',
    'fx_account_not_open',
    'account_frozen',
    'chain_mismatch',
    'not_found',
    'provider_unreachable',
  )
  sendQuote(
    @CurrentWallet() wallet: OpenWallet,
    @Query() query: FxSendQuoteQueryDto,
  ): Promise<FxSendQuoteView> {
    return this.operations.sendQuote(wallet, query);
  }

  /**
   * Sends USDT, USDC or RLUSD from a stablecoin account to an outside
   * address. The chain must match the account's and the address's
   * (`chain_mismatch`, `address_invalid`, both before the PIN). The
   * Idempotency-Key and the PIN are required; the provider's fee is charged
   * on top as it charges it. Answers 201 with the send (`pending` until the
   * chain confirms; poll `GET /money/fx/sends/{id}`). If the provider will
   * not take the send, `409 provider_declined` carries its reason in plain
   * words and nothing moved.
   */
  @Post('sends')
  @HttpCode(201)
  @BuiltBy('WALLET-21')
  @RequireIdempotentApproval(FX_SEND_ROUTE)
  @MoneyErrors(
    ...DEBIT_GATE_ERRORS,
    'device_approval_refused',
    'currency_not_supported',
    'fx_switched_off',
    'account_frozen',
    'fx_account_not_open',
    'address_invalid',
    'chain_mismatch',
    'daily_limit_exceeded',
    'not_found',
    'provider_declined',
  )
  @RequireFeesSet()
  send(
    @CurrentWallet() wallet: OpenWallet,
    @CurrentIdempotencyScope() scope: IdempotencyScope,
    @Body() dto: FxSendDto,
  ): Promise<FxSendView> {
    return this.operations.send(wallet, scope, dto);
  }

  /** One send as it stands now. Only the owner reads it. */
  @Get('sends/:id')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('WALLET-21')
  @RequireOpenWallet()
  @MoneyErrors(...WALLET_GATE_ERRORS, 'currency_not_supported', 'not_found')
  sendById(
    @CurrentWallet() wallet: OpenWallet,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<FxSendView> {
    return this.operations.readSend(wallet, id);
  }
}
