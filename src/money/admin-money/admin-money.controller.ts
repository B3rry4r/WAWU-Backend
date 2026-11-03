import {
  Controller,
  Get,
  Header,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminRole } from '../../../generated/prisma/enums';
import { AdminRoles } from '../../admin/auth/decorators/admin-roles.decorator';
import { AdminAuthGuard } from '../../admin/auth/guards/admin-auth.guard';
import { AdminRolesGuard } from '../../admin/auth/guards/admin-roles.guard';
import { BuiltBy } from '../money-contract';
import {
  AdminMoneyPageQueryDto,
  AdminMoneyRevenueQueryDto,
  AdminMoneyWalletsQueryDto,
  type AdminMoneyMerchantView,
  type AdminMoneyRevenueView,
  type AdminMoneyWalletDetailView,
  type AdminMoneyWalletPage,
} from './admin-money.dto';
import { AdminMoneyRevenueService } from './admin-money-revenue.service';
import { AdminMoneyWalletsService } from './admin-money-wallets.service';

const SuperadminOrFinance = () =>
  AdminRoles(AdminRole.superadmin, AdminRole.finance);

/**
 * The app's real money, for the dashboard (DASH-B-HUB): the wallets of the
 * provider the server runs, WAWU's merchant wallet, and revenue by stream.
 * `/api/hub/admin/money/wallets`, `/merchant`, `/revenue`. Superadmin and
 * finance only; support and reviewer are refused on every route. All reads.
 *
 * A balance here is the wallet provider's own answer, never a sum of our rows;
 * when the provider does not answer, a row says why and shows no figure.
 * These routes do not touch the website's `/admin/finance/*`.
 */
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Controller('admin/money')
export class AdminMoneyController {
  constructor(
    private readonly wallets: AdminMoneyWalletsService,
    private readonly revenue: AdminMoneyRevenueService,
  ) {}

  /** The app's wallets, newest first. Balances only with `withBalance=true` (a page of at most 25). */
  @Get('wallets')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('DASH-B-HUB')
  @SuperadminOrFinance()
  list(
    @Query() query: AdminMoneyWalletsQueryDto,
  ): Promise<AdminMoneyWalletPage> {
    return this.wallets.list(query);
  }

  /** One wallet with the provider's balance and the person's recent ledger rows (our records). */
  @Get('wallets/:wawuId')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('DASH-B-HUB')
  @SuperadminOrFinance()
  one(
    @Param('wawuId') wawuId: string,
    @Query() query: AdminMoneyPageQueryDto,
  ): Promise<AdminMoneyWalletDetailView> {
    return this.wallets.one(wawuId, query);
  }

  /** WAWU's merchant wallet: the provider's balance, and what our records say is held for whom. */
  @Get('merchant')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('DASH-B-HUB')
  @SuperadminOrFinance()
  merchant(
    @Query() query: AdminMoneyPageQueryDto,
  ): Promise<AdminMoneyMerchantView> {
    return this.wallets.merchant(query);
  }

  /** The app's money by stream over `[from, to)`, each with its source table, statuses and rail. */
  @Get('revenue')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('DASH-B-HUB')
  @SuperadminOrFinance()
  revenueByStream(
    @Query() query: AdminMoneyRevenueQueryDto,
  ): Promise<AdminMoneyRevenueView> {
    return this.revenue.revenue(query);
  }
}
