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
import { RequireOpenWallet } from '../../money/gate/wallet-gate';
import {
  BuiltBy,
  DEBIT_GATE_ERRORS,
  MoneyErrors,
  WALLET_GATE_ERRORS,
} from '../../money/money-contract';
import {
  CurrentIdempotencyScope,
  type IdempotencyScope,
  RequireIdempotentApproval,
} from '../../money/payments/idempotency';
import { CONVERT_ROUTE } from './points-cash-out.service';
import { ConvertPrecheckGuard } from './points-convert-precheck.guard';
import {
  PointsConvertDto,
  PointsConvertQuoteQueryDto,
} from './points-convert.dto';
import { PointsConvertService } from './points-convert.service';
import type {
  PointsConversionView,
  PointsConvertQuoteView,
} from './points-convert-view.type';

/**
 * Convert points to cash (task POINTS-04, PT6, R-43). `points/convert` is a
 * path nothing else uses (`GET /me/points` is the points view); the quote
 * route comes before the id route, so `quote` cannot be taken for an id.
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('points/convert')
export class PointsConvertController {
  constructor(private readonly convert: PointsConvertService) {}

  /**
   * PT6 before the PIN: the rate (1,000 points for so many kobo, from the
   * config), the fewest points one conversion takes, the balance, and the
   * cash for `points` (all the cashable points when none is asked; points the
   * person bought are never cashable, `cashablePoints`). WAWU pays the
   * provider's charge, so the person pays nothing to convert (R-31).
   * `canConvert` and `blockedBy` say when the points asked cannot be
   * converted as they are (below the minimum, more than the balance, more
   * than one move carries), with the figures, instead of refusing. Nothing is
   * held. A person billed in dollars is `409 currency_not_supported`; with no
   * wallet, `409 wallet_not_open`.
   */
  @Get('quote')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('POINTS-04')
  @RequireOpenWallet()
  @MoneyErrors(...WALLET_GATE_ERRORS, 'currency_not_supported', 'fees_not_set')
  @RequireFeesSet()
  quote(
    @CurrentUser() user: WawuJwtClaims,
    @Query() query: PointsConvertQuoteQueryDto,
  ): Promise<PointsConvertQuoteView> {
    return this.convert.quote(
      user.sub,
      { phone: user.phone, country: user.country },
      query.points,
    );
  }

  /**
   * Turns points into cash in the wallet, once. The cash is worked out at the
   * config's rate and rounded down; the points are held (soonest-ending lots
   * first) and the cash is paid from WAWU's own account into the person's
   * wallet; the points are spent only when the provider has confirmed it, and
   * go back to their lots if it did not move. Answers 201 with the
   * conversion: `completed`, `pending` while the provider has not confirmed
   * the cash yet (the points stay on hold; poll `GET /points/convert/{id}`;
   * it is never sent again), or `failed` when the cash did not move and the
   * points are back. The same Idempotency-Key and body answer the first
   * result again (`Idempotent-Replayed: true`) without checking the PIN.
   * The body carries the `quoteToken` of the quote the person was shown: the
   * conversion is paid at that quote or not at all. If the rate, the
   * minimum, the cap or the cash changed since (or the token is not this
   * person's, not for these points, or past its end), it is `409
   * quote_changed` with the new quote in `reason.pointsQuote`, and nothing
   * is paid. A body with no token is a plain 400.
   * Before the PIN, and changing nothing: `422 below_minimum`, `402
   * insufficient_points`, `422 points_not_cashable` (more than the person's
   * earned and bonus points: points they bought cannot be cashed out),
   * `400 amount_out_of_range` (more than one move
   * carries), `409 quote_changed`, `409 currency_not_supported`, `409
   * wallet_not_open`, `503 fees_not_set`.
   */
  @Post()
  @HttpCode(201)
  @BuiltBy('POINTS-04')
  @RequireIdempotentApproval(CONVERT_ROUTE, ConvertPrecheckGuard)
  @MoneyErrors(
    ...DEBIT_GATE_ERRORS,
    'device_approval_refused',
    'below_minimum',
    'insufficient_points',
    'points_not_cashable',
    'quote_changed',
    'currency_not_supported',
  )
  @RequireFeesSet()
  convertPoints(
    @CurrentUser() user: WawuJwtClaims,
    @CurrentIdempotencyScope() scope: IdempotencyScope,
    @Body() dto: PointsConvertDto,
  ): Promise<PointsConversionView> {
    return this.convert.convert(
      user.sub,
      { phone: user.phone, country: user.country },
      dto.points,
      dto.quoteToken,
      scope,
    );
  }

  /**
   * One conversion as it stands now: what the app polls after `pending`.
   * Only its owner reads it; another person's conversion and an id nobody
   * holds are the same `404 not_found`. It reads our own records only and
   * never asks the provider.
   */
  @Get(':id')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('POINTS-04')
  @MoneyErrors('not_found')
  read(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PointsConversionView> {
    return this.convert.read(user.sub, id);
  }
}
