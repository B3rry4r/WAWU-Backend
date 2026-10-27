import { Controller, Get, UseGuards } from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { PriceListService, type PriceListView } from './price-list.service';

/**
 * GET /prices (PRICE-LIST, R-101): the price list and the tip list, for every
 * picker in the app. Any signed-in person may read it: a fan picking a tip is
 * not a creator, so `GET /content/sale-terms` (creators only) cannot carry it.
 * Read only; the lists are admin settings.
 */
@UseGuards(WawuAuthGuard)
@Controller('prices')
export class PriceListController {
  constructor(private readonly prices: PriceListService) {}

  @Get()
  read(): PriceListView {
    return this.prices.view();
  }
}
