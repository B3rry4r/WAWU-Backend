import {
  applyDecorators,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { BuiltBy, declaredOnly } from '../money-contract';
import {
  AdminFxFreezeDto,
  AdminFxOperationsQueryDto,
} from './dto/fx-request.dto';
import type {
  AdminFxAccountListView,
  AdminFxFreezeView,
  AdminFxOperationPage,
  AdminFxOperationView,
} from './fx-view.type';

/**
 * Declared here without the guards (this module has no providers): the served
 * handler carries `@UseGuards(AdminAuthGuard, AdminRolesGuard)` on its class
 * and `@AdminRoles('superadmin', 'finance')` on each route.
 */
const SuperadminOrFinance = (): MethodDecorator => applyDecorators();

/**
 * What the admin dashboard sees of foreign accounts, swaps and crypto sends
 * (task WALLET-21, R-84): a person's accounts, every swap and send, and one
 * account frozen or let go. Superadmin and finance only; reviewer and
 * support are refused on every route. The two writes (freeze, unfreeze)
 * only change WAWU's own record of the account and leave an audit row each
 * (who, what, why, when); nothing here moves money.
 */
@Controller('admin/money/fx')
export class FxAdminContractController {
  /** A person's foreign accounts with the provider's balances and details. */
  @Get('people/:wawuUserId/accounts')
  @BuiltBy('WALLET-21')
  @SuperadminOrFinance()
  personAccounts(
    @Param('wawuUserId') wawuUserId: string,
  ): Promise<AdminFxAccountListView> {
    return declaredOnly('WALLET-21', wawuUserId);
  }

  /** Swaps and sends, newest first, for one person or for everyone. */
  @Get('operations')
  @BuiltBy('WALLET-21')
  @SuperadminOrFinance()
  operations(
    @Query() query: AdminFxOperationsQueryDto,
  ): Promise<AdminFxOperationPage> {
    return declaredOnly('WALLET-21', query);
  }

  /** One swap or send. */
  @Get('operations/:id')
  @BuiltBy('WALLET-21')
  @SuperadminOrFinance()
  operation(@Param('id') id: string): Promise<AdminFxOperationView> {
    return declaredOnly('WALLET-21', id);
  }

  /**
   * Freezes one account: from then on nothing leaves it (a swap from it, a
   * crypto send) and nothing is swapped into it; money can still arrive.
   * Needs a reason. Freezing a frozen account changes nothing and writes no
   * second audit row.
   */
  @Post('accounts/:id/freeze')
  @HttpCode(200)
  @BuiltBy('WALLET-21')
  @SuperadminOrFinance()
  freeze(
    @Param('id') id: string,
    @Body() dto: AdminFxFreezeDto,
  ): Promise<AdminFxFreezeView> {
    return declaredOnly('WALLET-21', id, dto);
  }

  /** Lets go of a frozen account. Needs a reason; one audit row. */
  @Post('accounts/:id/unfreeze')
  @HttpCode(200)
  @BuiltBy('WALLET-21')
  @SuperadminOrFinance()
  unfreeze(
    @Param('id') id: string,
    @Body() dto: AdminFxFreezeDto,
  ): Promise<AdminFxFreezeView> {
    return declaredOnly('WALLET-21', id, dto);
  }
}
