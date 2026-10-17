import { Controller, Get, Header, Query, UseGuards } from '@nestjs/common';
import { AdminRole } from '../../../generated/prisma/enums';
import { AdminRoles } from '../../admin/auth/decorators/admin-roles.decorator';
import { AdminAuthGuard } from '../../admin/auth/guards/admin-auth.guard';
import { AdminRolesGuard } from '../../admin/auth/guards/admin-roles.guard';
import { AdminUnsweptQueryDto } from './admin-earnings-query.dto';
import type { UnsweptSalesPage } from './earning-review.type';
import { EarningSettlementService } from './earning-settlement.service';

/**
 * Sales the earnings sweep will never pay (WALLET-16, lead ruling 17 Oct
 * 2026) -- `/api/hub/admin/money/earnings/*` once the global prefix is
 * applied. Read only: it moves nothing and offers no way to mark a sale paid.
 *
 * The sweep that lands a creator's 85% pays only sales made on or after a
 * start time, so a sale that was never settled before this code ran is not
 * paid by surprise. Those older sales are listed here for a person to decide.
 * superadmin and finance, as the payment reconciliation routes are.
 */
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Controller('admin/money/earnings')
export class AdminEarningsController {
  constructor(private readonly earnings: EarningSettlementService) {}

  /** Finished sales with a payee made before the sweep's start, oldest first. */
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  @Get('before-start')
  @Header('Cache-Control', 'no-store')
  beforeStart(@Query() query: AdminUnsweptQueryDto): Promise<UnsweptSalesPage> {
    return this.earnings.unsweptBeforeStart({
      limit: query.limit,
      cursor: query.cursor,
    });
  }
}
