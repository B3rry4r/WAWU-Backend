import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import type { WawuJwtClaims } from '../../common/auth/wawu-jwt-claims.interface';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { WawuAuthGuard } from '../../common/guards/wawu-auth.guard';
import { RequireFeesSet } from '../../money/fees/fees-set.guard';
import { CurrentWallet, type OpenWallet } from '../../money/gate/wallet-gate';
import {
  BuiltBy,
  DEBIT_GATE_ERRORS,
  MoneyErrors,
} from '../../money/money-contract';
import {
  CurrentIdempotencyScope,
  type IdempotencyScope,
  RequireIdempotentApproval,
} from '../../money/payments/idempotency';
import { PointsQuoteService } from './points-quote.service';
import {
  PointsShortfallService,
  SHORTFALL_ROUTE,
} from './points-shortfall.service';
import {
  PointsQuoteDto,
  PointsSettingsDto,
  PointsShortfallDto,
} from './points-spend.dto';
import { PointsSpendService } from './points-spend.service';
import type {
  PointsQuoteView,
  PointsSettingsView,
  PointsShortfallView,
} from './points-spend-view.type';

/**
 * Spending points on AI tools (task POINTS-03, PT1 to PT3 and PT7). `points`
 * is a first segment `PointsConvertController` shares only with its
 * `convert/...` routes; `quote` and `shortfall` collide with none of them.
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('points')
export class PointsSpendController {
  constructor(
    private readonly quotes: PointsQuoteService,
    private readonly shortfall: PointsShortfallService,
  ) {}

  /**
   * What an AI job costs before it runs (PT1, PT2): the points from the
   * settings, the balance, the shortfall, the cap that stops it (PT7: `cap`
   * names itself and, for the day's, when it resets) and, with a shortfall and
   * "Use wallet" on, the wallet money for exactly the shortfall (PT3) with
   * the signed quote `POST /points/shortfall` sends back. Holds nothing and
   * takes nothing: a 200, whatever it says. A tool that is not in the plan,
   * or a count that is not a whole number above zero, is a 400.
   */
  @Post('quote')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @BuiltBy('POINTS-03')
  quote(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: PointsQuoteDto,
  ): Promise<PointsQuoteView> {
    return this.quotes.quote(user.sub, dto);
  }

  /**
   * Buys exactly the shortfall of one job from the wallet, once (PT3). The
   * body is the job as it was quoted plus `wallet.payment.totalKobo` and
   * `wallet.payment.quoteToken`; the PIN is in `X-Transaction-Pin`. One
   * lot of the shortfall's points is added when the provider confirms the
   * debit, and it never ends (bought points never expire, R-101 point 7). Answers 201 with the
   * purchase: `paid`, `pending` while the provider has not confirmed (poll
   * `GET /points/shortfall/{id}`; it is never sent again) or `failed` when
   * nothing moved. The same Idempotency-Key and body answer the first result
   * again (`Idempotent-Replayed: true`) without checking the PIN. Refused with
   * nothing taken and the key given back: `422 points_cap_reached` (buying points would not
   * let the job run), `409 points_not_short` (the person has enough now),
   * `409 quote_changed` with the new quote (the balance, the rate or the
   * expiry moved), `409 wallet_not_open`.
   */
  @Post('shortfall')
  @HttpCode(201)
  @BuiltBy('POINTS-03')
  @RequireIdempotentApproval(SHORTFALL_ROUTE)
  @MoneyErrors(
    ...DEBIT_GATE_ERRORS,
    'device_approval_refused',
    'daily_limit_exceeded',
    'quote_changed',
    'target_not_payable',
    'payment_in_progress',
    'points_cap_reached',
    'points_not_short',
  )
  @RequireFeesSet()
  buyShortfall(
    @CurrentWallet() wallet: OpenWallet,
    @CurrentIdempotencyScope() scope: IdempotencyScope,
    @Body() dto: PointsShortfallDto,
  ): Promise<PointsShortfallView> {
    return this.shortfall.buy(wallet, scope, dto);
  }

  /**
   * One shortfall purchase as it stands now: what the app polls after
   * `pending`. Only the buyer reads it; another person's and an id nobody
   * holds are the same `404 not_found`.
   */
  @Get('shortfall/:id')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('POINTS-03')
  @MoneyErrors('not_found')
  readShortfall(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PointsShortfallView> {
    return this.shortfall.read(user.sub, id);
  }
}

/**
 * The person's choice about points, `me/points/settings` (PT3). Declared
 * beside `me/points` (PointsController): two segments after `me`, so no
 * parameter route of MeController can take it.
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('me/points/settings')
export class PointsSettingsController {
  constructor(private readonly spend: PointsSpendService) {}

  /** "Use wallet", off until the person turns it on. */
  @Get()
  @Header('Cache-Control', 'no-store')
  @BuiltBy('POINTS-03')
  async read(@CurrentUser() user: WawuJwtClaims): Promise<PointsSettingsView> {
    return { useWallet: await this.spend.useWalletOf(user.sub) };
  }

  /**
   * Turns "Use wallet" on or off. Moves nothing: it only decides whether a
   * points quote shows the wallet money for a shortfall.
   */
  @Put()
  @Header('Cache-Control', 'no-store')
  @BuiltBy('POINTS-03')
  set(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: PointsSettingsDto,
  ): Promise<PointsSettingsView> {
    return this.spend.setUseWallet(user.sub, dto.useWallet);
  }
}
