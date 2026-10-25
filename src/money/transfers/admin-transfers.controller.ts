import { Controller, Get, Header, Query, UseGuards } from '@nestjs/common';
import { AdminRole } from '../../../generated/prisma/enums';
import { AdminRoles } from '../../admin/auth/decorators/admin-roles.decorator';
import { AdminAuthGuard } from '../../admin/auth/guards/admin-auth.guard';
import { AdminRolesGuard } from '../../admin/auth/guards/admin-roles.guard';
import { AdminTransferLookupQueryDto } from './admin-transfer-lookup.dto';
import { AdminTransferLookupService } from './admin-transfer-lookup.service';
import type { AdminTransferLookupResult } from './admin-transfer-lookup.view';

/**
 * Admin read of a send by its reference (R2-MONEY D-03): `/api/hub/admin/money/transfers`. Superadmin, finance and support: support is who
 * a person quotes a reference to. Changes nothing, calls no provider.
 */
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Controller('admin/money/transfers')
export class AdminTransfersController {
  constructor(private readonly lookup: AdminTransferLookupService) {}

  /**
   * The send a person quotes: by the short reference on their receipt ("WAW-8F2A-91C3") or by the whole stored reference. Answers every
   * send the reference fits, newest first (a short reference is derived from the send's id, so two sends can share one), or an empty list.
   */
  @AdminRoles(AdminRole.superadmin, AdminRole.finance, AdminRole.support)
  @Get('lookup')
  @Header('Cache-Control', 'no-store')
  find(
    @Query() q: AdminTransferLookupQueryDto,
  ): Promise<AdminTransferLookupResult> {
    return this.lookup.lookup(q.reference);
  }
}
