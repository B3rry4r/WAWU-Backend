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
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { WawuJwtClaims } from '../../common/auth/wawu-jwt-claims.interface';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { WawuAuthGuard } from '../../common/guards/wawu-auth.guard';
import { RequireOpenWallet } from '../gate/wallet-gate';
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
  AddMoneyDto,
  AddMoneyListQueryDto,
  AddMoneyQuoteQueryDto,
} from './add-money.dto';
import { AddMoneyPrecheckGuard } from './add-money-precheck.guard';
import { ADD_MONEY_ROUTE, AddMoneyService } from './add-money.service';
import { returnPage } from './add-money-return-page';
import type {
  AddMoneyOptionsView,
  AddMoneyPage,
  AddMoneyQuoteView,
  AddMoneyView,
} from './add-money-view.type';

/**
 * Add money by card, Apple Pay, USSD or a bank checkout (WALLET-25,
 * WALLET-26; R-84), into the caller's own wallet. The fixed words
 * (`options`, `quote`, `return`) come before the id route, so none is taken
 * for an id.
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('money/add-money')
export class MoneyAddMoneyController {
  constructor(private readonly addMoney: AddMoneyService) {}

  /**
   * The ways to add money and whether each can be used now, with the reason in
   * plain words when it cannot (switched off, not set up, or not switched on
   * for naira at the provider yet). `cardPublicKey` is what the phone encrypts
   * a card with. Reads our own settings only; it never calls the provider.
   */
  @Get('options')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('WALLET-25')
  @RequireOpenWallet()
  @MoneyErrors(...WALLET_GATE_ERRORS)
  options(): AddMoneyOptionsView {
    return this.addMoney.options();
  }

  /**
   * What the person pays and what the wallet gets for one amount by one way:
   * the provider's charge plus WAWU's (R-10, both from config). `409
   * add_money_unavailable` when the way cannot be used; `503 fees_not_set`
   * while the provider's charge for it is not set.
   */
  @Get('quote')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('WALLET-25')
  @RequireOpenWallet()
  @MoneyErrors(...WALLET_GATE_ERRORS, 'add_money_unavailable', 'fees_not_set')
  quote(@Query() q: AddMoneyQuoteQueryDto): AddMoneyQuoteView {
    return this.addMoney.quote(q.rail, q.amountKobo);
  }

  /**
   * Starts adding money. Answers 201 with the attempt: `awaiting_user` with a
   * `checkoutUrl` to open in the browser (3-D Secure, Apple Pay, the bank
   * checkout) or a prompt to answer on the phone (USSD), `processing` (paid,
   * being added to the wallet), or `failed` with the reason in plain words
   * (a declined card, or a way the provider has not switched on for naira).
   * The wallet is credited by the provider's inflow, once; poll `GET
   * /money/add-money/{id}`. The same Idempotency-Key and body answer the first
   * result again (`Idempotent-Replayed: true`) without checking the PIN.
   * Before the PIN, changing nothing: `409 add_money_unavailable`, `503
   * fees_not_set`, `422 below_minimum`, `403 limit_reached`, `409
   * quote_changed`, `409 wallet_not_open`. A card is sent already encrypted on
   * the phone; the Hub passes it on and never keeps it.
   */
  @Post()
  @HttpCode(201)
  @BuiltBy('WALLET-25')
  @RequireIdempotentApproval(ADD_MONEY_ROUTE, AddMoneyPrecheckGuard)
  @MoneyErrors(
    ...DEBIT_GATE_ERRORS,
    'device_approval_refused',
    'add_money_unavailable',
    'fees_not_set',
    'below_minimum',
    'limit_reached',
    'quote_changed',
    'email_not_verified',
  )
  start(
    @CurrentUser() user: WawuJwtClaims,
    @CurrentIdempotencyScope() scope: IdempotencyScope,
    @Body() dto: AddMoneyDto,
    @Req() req: Request,
  ): Promise<AddMoneyView> {
    return this.addMoney.create(
      {
        sub: user.sub,
        email: user.email,
        phone: user.phone,
        firstName: user.firstName,
        lastName: user.lastName,
        country: user.country,
      },
      dto,
      scope,
      { ip: req.ip ?? '0.0.0.0', userAgent: req.get('user-agent') ?? '' },
    );
  }

  /** The caller's attempts, newest first, in cursor pages. */
  @Get()
  @Header('Cache-Control', 'no-store')
  @BuiltBy('WALLET-25')
  @RequireOpenWallet()
  @MoneyErrors(...WALLET_GATE_ERRORS)
  list(
    @CurrentUser() user: WawuJwtClaims,
    @Query() q: AddMoneyListQueryDto,
  ): Promise<AddMoneyPage> {
    return this.addMoney.list(user.sub, q);
  }

  /**
   * One attempt as it stands, asked of the provider when it is still open. Only
   * its owner reads it; another person's and an id nobody holds are the same
   * `404 not_found`.
   */
  @Get(':id')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('WALLET-25')
  @RequireOpenWallet()
  @MoneyErrors(...WALLET_GATE_ERRORS, 'not_found')
  read(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AddMoneyView> {
    return this.addMoney.read(user.sub, id);
  }

  /**
   * Cancels an attempt that is not paid yet. One the provider has taken, or
   * that is already credited, is `409 add_money_unavailable`.
   */
  @Post(':id/cancel')
  @HttpCode(200)
  @BuiltBy('WALLET-25')
  @RequireOpenWallet()
  @MoneyErrors(...WALLET_GATE_ERRORS, 'not_found', 'add_money_unavailable')
  cancel(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AddMoneyView> {
    return this.addMoney.cancel(user.sub, id);
  }
}

/**
 * Where the provider's hosted pages (3-D Secure, Apple Pay, the bank
 * checkout) send the person back (WALLET-25, WALLET-26). Public: the person
 * arrives from a browser with no token. A plain page with a button into the
 * app; it reads and shows nothing about the payment, and the app learns the
 * result from `GET /money/add-money/{id}`, never from this page. Mounted
 * before MoneyAddMoneyController, so the word `return` is not taken for an id.
 */
@Controller('money/add-money/return')
export class AddMoneyReturnController {
  @Get()
  @ApiOkResponse({
    description: 'A page that opens the app.',
    content: { 'text/html': { schema: { type: 'string' } } },
  })
  @Header('Cache-Control', 'no-store')
  page(@Query('id') id: string | undefined, @Res() res: Response): void {
    res
      .status(200)
      .set({
        'Content-Type': 'text/html; charset=utf-8',
        'X-Robots-Tag': 'noindex, nofollow',
        'Referrer-Policy': 'no-referrer',
      })
      .send(returnPage(id));
  }
}
