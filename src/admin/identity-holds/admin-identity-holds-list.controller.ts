import { Controller, Get, Header, Query, UseGuards } from '@nestjs/common';
import { AdminRole } from '../../../generated/prisma/enums';
import { AdminRoles } from '../auth/decorators/admin-roles.decorator';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { AdminRolesGuard } from '../auth/guards/admin-roles.guard';
import { AdminOpeningListQueryDto } from './admin-opening-lists.dto';
import { AdminOpeningListsService } from './admin-opening-lists.service';
import type { IdentityHoldsPage } from './admin-opening-lists.type';

/**
 * The identity holds support can let go of (OPS-26, lead ruling 24 Oct 2026,
 * the owner may override) -- `GET /api/hub/admin/identity-holds`, beside the
 * release route of `AdminIdentityHoldsController`.
 *
 * Read only: openings in `review` or `stopped` that still hold a BVN and have
 * no wallet, longest held first. It names the HOLDER's WAWU account (the id
 * `release` takes), never a BVN, a hash, a phone number or a name.
 *
 * ── ROLE MATRIX ───────────────────────────────────────────────────────────
 *   list                      — superadmin, support (as the release is)
 *   reviewer, finance         — refused entirely
 */
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Controller('admin/identity-holds')
export class AdminIdentityHoldsListController {
  constructor(private readonly lists: AdminOpeningListsService) {}

  @AdminRoles(AdminRole.superadmin, AdminRole.support)
  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Query() query: AdminOpeningListQueryDto): Promise<IdentityHoldsPage> {
    return this.lists.holds({ limit: query.limit, cursor: query.cursor });
  }
}
