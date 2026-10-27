import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { StorePlatform } from '../../generated/prisma/enums';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { PriceListService, type PriceListView } from './price-list.service';
import { StorePriceService } from './store-price.service';

/** GET /prices?platform= */
export class PriceListQueryDto {
  /** Whose store prices to show. Without it, the higher of the two stores'. */
  @ApiPropertyOptional({ enum: StorePlatform })
  @IsOptional()
  @IsEnum(StorePlatform, { message: 'platform must be android or ios' })
  platform?: StorePlatform;
}

/**
 * GET /prices (PRICE-LIST, R-101): the price list and the tip list, for every
 * picker in the app. Any signed-in person may read it: a fan picking a tip is
 * not a creator, so `GET /content/sale-terms` (creators only) cannot carry it.
 * Read only; the lists are admin settings. Each price carries `storePriceNaira`
 * (STORE-BUY-HUB): what the store charges in Nigeria for it, or null.
 */
@UseGuards(WawuAuthGuard)
@Controller('prices')
export class PriceListController {
  constructor(
    private readonly prices: PriceListService,
    private readonly storePrices: StorePriceService,
  ) {}

  @Get()
  async read(@Query() query: PriceListQueryDto): Promise<PriceListView> {
    const view = this.prices.view();
    const store = await this.storePrices.byListPrice(query.platform);
    for (const item of [...view.prices, ...view.tips])
      item.storePriceNaira = store.get(item.priceNaira) ?? null;
    return view;
  }
}
