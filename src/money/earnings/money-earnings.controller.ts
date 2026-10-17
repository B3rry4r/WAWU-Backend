import { Controller, Get, Header, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import type { WawuJwtClaims } from '../../common/auth/wawu-jwt-claims.interface';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { WawuAuthGuard } from '../../common/guards/wawu-auth.guard';
import {
  EarningContentQueryDto,
  MoneyEarningsQueryDto,
} from '../dto/money-request.dto';
import { BuiltBy, PlainBadRequest } from '../money-contract';
import type { EarningContentPage, EarningsView } from '../money-view.type';
import { EarningsViewService } from './earnings-view.service';

/**
 * What the caller has earned (task WALLET-16, W39, R-11). Served here
 * (docs/contract/CONVENTIONS.md section 26).
 *
 * Nothing lands in the wallet because a client asks: a sale's 85% moves by
 * itself (`EarningSettlementService`), and these routes only read our own
 * records of the sales. They never call the wallet provider, so none answers
 * `provider_unreachable`, and they are NOT behind the wallet gate: a creator
 * with no wallet keeps earning and has to see the money waiting for them.
 * `no-store`, because an earning lands within a minute of the sale.
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('money/earnings')
export class MoneyEarningsController {
  constructor(private readonly earnings: EarningsViewService) {}

  /** Earned all time and in a month, by kind of sale, with what is still waiting to reach the wallet. */
  @Get()
  @Header('Cache-Control', 'no-store')
  @BuiltBy('WALLET-16')
  @PlainBadRequest('month is not YYYY-MM.')
  summary(
    @CurrentUser() user: WawuJwtClaims,
    @Query() query: MoneyEarningsQueryDto,
  ): Promise<EarningsView> {
    return this.earnings.summary(user.sub, query.month);
  }

  /** One month's earnings piece by piece, largest first. */
  @Get('content')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('WALLET-16')
  @PlainBadRequest(
    'month is not YYYY-MM, or the cursor is not one this list gave.',
  )
  content(
    @CurrentUser() user: WawuJwtClaims,
    @Query() query: EarningContentQueryDto,
  ): Promise<EarningContentPage> {
    return this.earnings.contentPage(user.sub, query);
  }
}
