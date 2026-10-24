import {
  applyDecorators,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import {
  ApprovalHeaders,
  BuiltBy,
  DEBIT_GATE_ERRORS,
  declaredOnly,
  IdempotencyKeyHeader,
  MoneyErrors,
  WALLET_GATE_ERRORS,
} from '../money-contract';
import {
  FxPageQueryDto,
  FxQuoteDto,
  FxSendDto,
  FxSendQuoteQueryDto,
  FxSwapDto,
  OpenFxAccountDto,
} from './dto/fx-request.dto';
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

/** The routes a swap's and a send's Idempotency-Key are scoped to. */
export const FX_SWAP_ROUTE = 'POST money/fx/swaps';
export const FX_SEND_ROUTE = 'POST money/fx/sends';

/**
 * A declared route carries the documentation of the guards its server will
 * have (this module has no providers, so a guard cannot sit here): the
 * Idempotency-Key and the two approval headers on a debit. Serving the route
 * puts `@RequireOpenWallet()`, `@RequireIdempotentApproval(route)` and
 * `@RequireFeesSet()` on the handler in their place.
 */
const RequireOpenWallet = (): MethodDecorator => applyDecorators();
const RequireIdempotentApproval = (route: string): MethodDecorator => {
  void route;
  return applyDecorators(IdempotencyKeyHeader(), ApprovalHeaders());
};
const RequireFeesSet = (): MethodDecorator => applyDecorators();

/**
 * Dollar, other-currency and stablecoin accounts, swaps and crypto sends on
 * Nuvion (task WALLET-21, R-83, R-84). Declared by WALLET-21's first
 * milestone, served by its second (docs/contract/CONVENTIONS.md section 0):
 * until a handler is filled in it answers nothing and the contract marks the
 * route `x-wawu-served: false`.
 *
 * Every route needs an open naira wallet (R-6: the identity checks happen
 * once, when it is opened) and goes to the provider only through
 * WALLET_PROVIDER; a provider without foreign accounts (Fintava) answers
 * `currency_not_supported`.
 */
@ApiBearerAuth('wawu-id')
@Controller('money/fx')
export class FxContractController {
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
    return declaredOnly('WALLET-21');
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
  accounts(): Promise<FxAccountListView> {
    return declaredOnly('WALLET-21');
  }

  /**
   * Opens an account in one currency on the person's Nuvion entity. Asking
   * again for an account the person has returns it (201 first, 200 after).
   * A stablecoin needs its `chain`. Refused with `fx_switched_off` when an
   * admin switched the currency or "open account" off, and with
   * `provider_declined` (the provider's plain words) when Nuvion will not
   * open it for this person.
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
  open(@Body() dto: OpenFxAccountDto): Promise<FxAccountView> {
    return declaredOnly('WALLET-21', dto);
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
  account(@Param('id', ParseUUIDPipe) id: string): Promise<FxAccountView> {
    return declaredOnly('WALLET-21', id);
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
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: FxPageQueryDto,
  ): Promise<FxTransactionPage> {
    return declaredOnly('WALLET-21', id, query);
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
    'amount_out_of_range',
    'provider_declined',
    'provider_unreachable',
  )
  quote(@Body() dto: FxQuoteDto): Promise<FxQuoteView> {
    return declaredOnly('WALLET-21', dto);
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
    'provider_declined',
  )
  @RequireFeesSet()
  swap(@Body() dto: FxSwapDto): Promise<FxSwapView> {
    return declaredOnly('WALLET-21', dto);
  }

  /** One swap as it stands now; what the app polls after `pending`. Only the owner reads it. */
  @Get('swaps/:id')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('WALLET-21')
  @RequireOpenWallet()
  @MoneyErrors(...WALLET_GATE_ERRORS, 'currency_not_supported', 'not_found')
  swapById(@Param('id', ParseUUIDPipe) id: string): Promise<FxSwapView> {
    return declaredOnly('WALLET-21', id);
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
    'chain_mismatch',
    'amount_out_of_range',
    'provider_unreachable',
  )
  sendQuote(@Query() query: FxSendQuoteQueryDto): Promise<FxSendQuoteView> {
    return declaredOnly('WALLET-21', query);
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
    'provider_declined',
  )
  @RequireFeesSet()
  send(@Body() dto: FxSendDto): Promise<FxSendView> {
    return declaredOnly('WALLET-21', dto);
  }

  /** One send as it stands now. Only the owner reads it. */
  @Get('sends/:id')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('WALLET-21')
  @RequireOpenWallet()
  @MoneyErrors(...WALLET_GATE_ERRORS, 'currency_not_supported', 'not_found')
  sendById(@Param('id', ParseUUIDPipe) id: string): Promise<FxSendView> {
    return declaredOnly('WALLET-21', id);
  }
}
