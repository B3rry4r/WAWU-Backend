import { Controller, Get, Header, Query, UseGuards } from '@nestjs/common';
import { AdminRole } from '../../../generated/prisma/enums';
import { AdminRoles } from '../auth/decorators/admin-roles.decorator';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { AdminRolesGuard } from '../auth/guards/admin-roles.guard';
import { AdminOpeningListQueryDto } from './admin-opening-lists.dto';
import { AdminOpeningListsService } from './admin-opening-lists.service';
import type { StuckOpeningsPage } from './admin-opening-lists.type';

/**
 * Wallet openings that are stuck (OPS-26, lead ruling 24 Oct 2026, the owner
 * may override) -- `/api/hub/admin/wallet-openings/*` once the global prefix
 * is applied.
 *
 * Read only: it moves no money, calls no provider and changes no row. It
 * answers by WAWU account id and our own words, never a BVN, a hash, a phone
 * number or a name. superadmin and support, as the release route beside it:
 * support is who a blocked person is sent to.
 */
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Controller('admin/wallet-openings')
export class AdminWalletOpeningsController {
  constructor(private readonly lists: AdminOpeningListsService) {}

  /** Openings with no wallet that are waiting on the provider or on a person, oldest first. */
  @AdminRoles(AdminRole.superadmin, AdminRole.support)
  @Get('stuck')
  @Header('Cache-Control', 'no-store')
  stuck(@Query() query: AdminOpeningListQueryDto): Promise<StuckOpeningsPage> {
    return this.lists.stuck({ limit: query.limit, cursor: query.cursor });
  }
}
