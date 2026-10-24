import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminRole } from '../../../generated/prisma/enums';
import { AdminRoles } from '../../admin/auth/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../../admin/auth/decorators/current-admin.decorator';
import type { AdminUserView } from '../../admin/auth/admin-user-view.type';
import { AdminAuthGuard } from '../../admin/auth/guards/admin-auth.guard';
import { AdminRolesGuard } from '../../admin/auth/guards/admin-roles.guard';
import { BuiltBy } from '../money-contract';
import { AbroadAdminService } from './abroad-admin.service';
import {
  AdminAbroadReasonDto,
  AdminAbroadSendsQueryDto,
  AdminAbroadSettleFeeDto,
} from './dto/abroad-request.dto';
import type {
  AdminAbroadCancelView,
  AdminAbroadFreezeView,
  AdminAbroadSendPage,
  AdminAbroadSendView,
  AdminAbroadSettleFeeView,
} from './abroad-view.type';

const SuperadminOrFinance = () =>
  AdminRoles(AdminRole.superadmin, AdminRole.finance);

/**
 * What the admin dashboard sees of sends abroad (task NUV-11, R-84): every
 * send with its provider state, one person frozen or let go, and a send that
 * never reached the provider cancelled. Superadmin and finance only;
 * reviewer and support are refused on every route. The four writes leave an
 * audit row each (who, what, why, when) and none of them moves money.
 */
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Controller('admin/money/abroad')
export class AbroadAdminController {
  constructor(private readonly admin: AbroadAdminService) {}

  /** Sends, newest first, for one person or everyone; filter by status. */
  @Get('sends')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('NUV-11')
  @SuperadminOrFinance()
  sends(
    @Query() query: AdminAbroadSendsQueryDto,
  ): Promise<AdminAbroadSendPage> {
    return this.admin.list(query);
  }

  /** One send. */
  @Get('sends/:id')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('NUV-11')
  @SuperadminOrFinance()
  send(@Param('id') id: string): Promise<AdminAbroadSendView> {
    return this.admin.get(id);
  }

  /**
   * Cancels a send the provider never received (`sending` that stayed
   * `sending`, or `needs_review` after a search of the provider's records
   * found nothing). The provider has no way to stop a payout it holds, so a
   * send it accepted is `409 send_not_cancellable`. Needs a reason; one audit
   * row; cancelling a cancelled send changes nothing.
   */
  @Post('sends/:id/cancel')
  @HttpCode(200)
  @BuiltBy('NUV-11')
  @SuperadminOrFinance()
  cancel(
    @CurrentAdmin() admin: AdminUserView,
    @Param('id') id: string,
    @Body() dto: AdminAbroadReasonDto,
  ): Promise<AdminAbroadCancelView> {
    return this.admin.cancel(admin, id, dto.reason);
  }

  /**
   * Closes the question of WAWU's fee on one decided send: `not_taken` writes
   * off a fee that was never taken, `paid_back` closes a give-back owed to the
   * person (the provider's record of it, or paid outside the system, which the
   * reason says). The list's `feeOpen=true` finds them. Needs a reason; one
   * audit row; settling a settled fee changes nothing. A fee the provider's
   * record shows was taken cannot be written off (409). Moves no money.
   */
  @Post('sends/:id/settle-fee')
  @HttpCode(200)
  @BuiltBy('NUV-11')
  @SuperadminOrFinance()
  settleFee(
    @CurrentAdmin() admin: AdminUserView,
    @Param('id') id: string,
    @Body() dto: AdminAbroadSettleFeeDto,
  ): Promise<AdminAbroadSettleFeeView> {
    return this.admin.settleFee(admin, id, dto.outcome, dto.reason);
  }

  /**
   * Freezes one person's sending abroad: from then on no new recipient or send
   * leaves, and a send already with the provider carries on. Needs a reason;
   * freezing a frozen person changes nothing and writes no second audit row.
   */
  @Post('people/:wawuUserId/freeze')
  @HttpCode(200)
  @BuiltBy('NUV-11')
  @SuperadminOrFinance()
  freeze(
    @CurrentAdmin() admin: AdminUserView,
    @Param('wawuUserId') wawuUserId: string,
    @Body() dto: AdminAbroadReasonDto,
  ): Promise<AdminAbroadFreezeView> {
    return this.admin.freeze(admin, wawuUserId, dto.reason);
  }

  /** Lets go of a frozen person. Needs a reason; one audit row. */
  @Post('people/:wawuUserId/unfreeze')
  @HttpCode(200)
  @BuiltBy('NUV-11')
  @SuperadminOrFinance()
  unfreeze(
    @CurrentAdmin() admin: AdminUserView,
    @Param('wawuUserId') wawuUserId: string,
    @Body() dto: AdminAbroadReasonDto,
  ): Promise<AdminAbroadFreezeView> {
    return this.admin.unfreeze(admin, wawuUserId, dto.reason);
  }
}
