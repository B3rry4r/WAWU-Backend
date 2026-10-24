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
  AdminAbroadReasonDto,
  AdminAbroadSendsQueryDto,
} from './dto/abroad-request.dto';
import type {
  AdminAbroadCancelView,
  AdminAbroadFreezeView,
  AdminAbroadSendPage,
  AdminAbroadSendView,
} from './abroad-view.type';

/**
 * Declared without the guards (this module has no providers): the served
 * handler carries `@UseGuards(AdminAuthGuard, AdminRolesGuard)` on its class
 * and `@AdminRoles('superadmin', 'finance')` on each route.
 */
const SuperadminOrFinance = (): MethodDecorator => applyDecorators();

/**
 * What the admin dashboard sees of sends abroad (task NUV-11, R-84): every
 * send with its provider state, one person frozen or let go, and a send that
 * never reached the provider cancelled. Superadmin and finance only;
 * reviewer and support are refused on every route. The three writes leave an
 * audit row each (who, what, why, when) and none of them moves money.
 */
@Controller('admin/money/abroad')
export class AbroadAdminContractController {
  /** Sends, newest first, for one person or everyone; filter by status. */
  @Get('sends')
  @BuiltBy('NUV-11')
  @SuperadminOrFinance()
  sends(
    @Query() query: AdminAbroadSendsQueryDto,
  ): Promise<AdminAbroadSendPage> {
    return declaredOnly('NUV-11', query);
  }

  /** One send. */
  @Get('sends/:id')
  @BuiltBy('NUV-11')
  @SuperadminOrFinance()
  send(@Param('id') id: string): Promise<AdminAbroadSendView> {
    return declaredOnly('NUV-11', id);
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
    @Param('id') id: string,
    @Body() dto: AdminAbroadReasonDto,
  ): Promise<AdminAbroadCancelView> {
    return declaredOnly('NUV-11', id, dto);
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
    @Param('wawuUserId') wawuUserId: string,
    @Body() dto: AdminAbroadReasonDto,
  ): Promise<AdminAbroadFreezeView> {
    return declaredOnly('NUV-11', wawuUserId, dto);
  }

  /** Lets go of a frozen person. Needs a reason; one audit row. */
  @Post('people/:wawuUserId/unfreeze')
  @HttpCode(200)
  @BuiltBy('NUV-11')
  @SuperadminOrFinance()
  unfreeze(
    @Param('wawuUserId') wawuUserId: string,
    @Body() dto: AdminAbroadReasonDto,
  ): Promise<AdminAbroadFreezeView> {
    return declaredOnly('NUV-11', wawuUserId, dto);
  }
}
