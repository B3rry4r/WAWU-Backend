import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import type { Response } from 'express';
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
import { AbroadSendGuard } from './abroad-send.guard';
import { ABROAD_SEND_ROUTE, AbroadSendService } from './abroad-send.service';
import { AbroadService } from './abroad.service';
import {
  AbroadPageQueryDto,
  AbroadQuoteDto,
  AbroadRecipientDto,
  AbroadSendDto,
} from './dto/abroad-request.dto';
import type {
  AbroadBankListView,
  AbroadCorridorsView,
  AbroadQuoteView,
  AbroadRecipientListView,
  AbroadRecipientView,
  AbroadSendPage,
  AbroadSendView,
  AbroadSourcesView,
} from './abroad-view.type';

/**
 * Sending money abroad (task NUV-11, R-84): to a bank account or a mobile
 * money wallet in another country, from any of the person's accounts, with a
 * conversion quote when the currencies differ. Every route needs an open
 * naira wallet (R-6) and reaches the provider only through WALLET_PROVIDER;
 * a provider that cannot pay abroad (Fintava) answers `409
 * currency_not_supported`. The quote and the send run FeesSetGuard first
 * (`503 fees_not_set` while the running provider's fees are not set, NUV-07).
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('money/abroad')
export class AbroadController {
  constructor(
    private readonly abroad: AbroadService,
    private readonly sendService: AbroadSendService,
  ) {}

  /**
   * The product switch and the countries the app can draw: for each, the ways
   * to arrive and the exact fields Nuvion asks for that country and way, and
   * what an admin has set for the fee. Reads settings only; no provider call.
   */
  @Get('corridors')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('NUV-11')
  @RequireOpenWallet()
  @MoneyErrors(...WALLET_GATE_ERRORS, 'currency_not_supported')
  corridors(): AbroadCorridorsView {
    return this.abroad.corridors();
  }

  /** Nuvion's bank directory for one country, for a `bank` picker; asked once an hour. */
  @Get('banks/:country')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('NUV-11')
  @RequireOpenWallet()
  @MoneyErrors(
    ...WALLET_GATE_ERRORS,
    'currency_not_supported',
    'corridor_not_supported',
    'provider_unreachable',
  )
  banks(@Param('country') country: string): Promise<AbroadBankListView> {
    return this.abroad.banks(country.toUpperCase());
  }

  /** The accounts the person can send from, each with the provider's balance read now. */
  @Get('sources')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('NUV-11')
  @RequireOpenWallet()
  @MoneyErrors(
    ...WALLET_GATE_ERRORS,
    'currency_not_supported',
    'provider_unreachable',
  )
  sources(@CurrentWallet() wallet: OpenWallet): Promise<AbroadSourcesView> {
    return this.abroad.sources(wallet);
  }

  /** The person's saved recipients abroad, newest first. */
  @Get('recipients')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('NUV-11')
  @RequireOpenWallet()
  @MoneyErrors(...WALLET_GATE_ERRORS)
  recipients(
    @CurrentWallet() wallet: OpenWallet,
  ): Promise<AbroadRecipientListView> {
    return this.abroad.listRecipients(wallet.wawuUserId);
  }

  /**
   * Saves a recipient: the country, the way it arrives and exactly the
   * fields the corridor asks. Only the last four characters of the account
   * stay with WAWU; the rest is held by the provider. Saving the same
   * account again returns the saved one (201 first, 200 after). Refused with
   * `fx_switched_off` when sending abroad is off, `corridor_not_supported`
   * for a country or way the provider does not pay, and
   * `recipient_details_invalid` (the refused fields in `fields`) when the
   * provider will not take the details.
   */
  @Post('recipients')
  @HttpCode(201)
  @BuiltBy('NUV-11')
  @RequireOpenWallet()
  @MoneyErrors(
    ...WALLET_GATE_ERRORS,
    'currency_not_supported',
    'fx_switched_off',
    'account_frozen',
    'corridor_not_supported',
    'recipient_details_invalid',
    'provider_declined',
    'provider_unreachable',
  )
  async saveRecipient(
    @CurrentWallet() wallet: OpenWallet,
    @Body() dto: AbroadRecipientDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AbroadRecipientView> {
    const { view, created } = await this.abroad.saveRecipient(wallet, dto);
    res.status(created ? 201 : 200);
    return view;
  }

  /** Removes a saved recipient from the list. Sends already made keep their record. */
  @Delete('recipients/:id')
  @HttpCode(204)
  @BuiltBy('NUV-11')
  @RequireOpenWallet()
  @MoneyErrors(...WALLET_GATE_ERRORS, 'not_found')
  removeRecipient(
    @CurrentWallet() wallet: OpenWallet,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.abroad.removeRecipient(wallet.wawuUserId, id);
  }

  /**
   * What a send would deliver and cost: the provider's rate and real hold
   * when the currencies differ (about three minutes on dev), both amounts,
   * WAWU's fee from config. The quote is kept for this person and used once.
   * `amount_out_of_range` carries the least and most the corridor takes,
   * `rate_unavailable` says the provider cannot price the pair now,
   * `402 insufficient_funds` (amount, the partner's fee and WAWU's fee) that
   * the account holds less. Like the other quotes it moves nothing and runs
   * FeesSetGuard first: `503 fees_not_set` before anything else.
   */
  @Post('quotes')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @BuiltBy('NUV-11')
  @RequireOpenWallet()
  @MoneyErrors(
    ...WALLET_GATE_ERRORS,
    'currency_not_supported',
    'fx_switched_off',
    'account_frozen',
    'not_found',
    'fx_account_not_open',
    'amount_out_of_range',
    'daily_limit_exceeded',
    'corridor_not_supported',
    'rate_unavailable',
    'provider_declined',
    'provider_unreachable',
    'fees_not_set',
  )
  @RequireFeesSet()
  quote(
    @CurrentWallet() wallet: OpenWallet,
    @Body() dto: AbroadQuoteDto,
  ): Promise<AbroadQuoteView> {
    return this.abroad.quote(wallet, dto);
  }

  /**
   * Sends at a held quote: the Idempotency-Key and the PIN (or the device
   * approval) are required, the quote is used once, and the recipient and the
   * amounts are the quote's. Answers 201 with the send: `sending` or `pending`
   * until the provider delivers (poll `GET /money/abroad/sends/{id}`),
   * `failed` when the provider refused and nothing moved. An expired or used
   * quote is `409 quote_expired`; a frozen person `423 account_frozen`. The
   * same key and body answer the first result again
   * (`Idempotent-Replayed: true`) without checking the PIN. WAWU's fee, when
   * set, is taken from the naira wallet after the provider takes the send.
   */
  @Post('sends')
  @HttpCode(201)
  @BuiltBy('NUV-11')
  @RequireIdempotentApproval(ABROAD_SEND_ROUTE, AbroadSendGuard)
  @MoneyErrors(
    ...DEBIT_GATE_ERRORS,
    'device_approval_refused',
    'currency_not_supported',
    'fx_switched_off',
    'quote_expired',
    'account_frozen',
    'not_found',
    'corridor_not_supported',
    'recipient_details_invalid',
    'rate_unavailable',
    'daily_limit_exceeded',
    'provider_declined',
  )
  @RequireFeesSet()
  send(
    @CurrentWallet() wallet: OpenWallet,
    @CurrentIdempotencyScope() scope: IdempotencyScope,
    @Body() dto: AbroadSendDto,
  ): Promise<AbroadSendView> {
    return this.sendService.send(wallet, scope, dto);
  }

  /** The person's sends abroad, newest first (cursor page). */
  @Get('sends')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('NUV-11')
  @RequireOpenWallet()
  @MoneyErrors(...WALLET_GATE_ERRORS)
  sends(
    @CurrentWallet() wallet: OpenWallet,
    @Query() query: AbroadPageQueryDto,
  ): Promise<AbroadSendPage> {
    return this.sendService.list(wallet.wawuUserId, query.cursor, query.limit);
  }

  /** One send as it stands now; what the app polls after `sending` or `pending`. Only its sender reads it. */
  @Get('sends/:id')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('NUV-11')
  @RequireOpenWallet()
  @MoneyErrors(...WALLET_GATE_ERRORS, 'not_found')
  sendById(
    @CurrentWallet() wallet: OpenWallet,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AbroadSendView> {
    return this.sendService.read(wallet.wawuUserId, id);
  }
}
