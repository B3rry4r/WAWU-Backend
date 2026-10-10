import {
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AdminRole } from '../../../generated/prisma/enums';
import { AdminRoles } from '../auth/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../auth/decorators/current-admin.decorator';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { AdminRolesGuard } from '../auth/guards/admin-roles.guard';
import type { AdminUserView } from '../auth/admin-user-view.type';
import {
  AdminIdentityHoldsService,
  type IdentityHoldReleaseView,
} from './admin-identity-holds.service';

/**
 * A person's hold on a BVN during a Nuvion wallet opening —
 * `/api/hub/admin/identity-holds/*` once the global prefix is applied.
 *
 * ── ROLE MATRIX (documented, and enforced per handler) ────────────────────
 *   release                   — superadmin, support
 *   reviewer, finance         — refused entirely
 *
 * Support is the role the blocked person is sent to ("contact support"), so
 * it is the one that can act. The route takes no BVN and returns none: it
 * names the HOLDER's WAWU account and lets go of that account's hold at once.
 * AdminRolesGuard does not treat superadmin as implicitly allowed, so the
 * handler names both roles.
 *
 * `ParseUUIDPipe` is version-unpinned, as every admin id pipe here is: the
 * ids present in the data do not all carry the v4 nibble.
 */
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Controller('admin/identity-holds')
export class AdminIdentityHoldsController {
  constructor(private readonly service: AdminIdentityHoldsService) {}

  /**
   * Lets go of one account's hold on its BVN at once. The opening is marked
   * expired and the person is told once; nothing is deleted at Nuvion.
   * Refused (409) while Nuvion is still reviewing the person, or when the
   * account has a wallet. Safe to repeat: a second call changes nothing.
   *
   * `@HttpCode(200)`: nothing is created, and the ResponseInterceptor stamps
   * `statusCode: 200` into the body regardless (hazard H-3).
   */
  @AdminRoles(AdminRole.superadmin, AdminRole.support)
  @Post(':wawuUserId/release')
  @HttpCode(HttpStatus.OK)
  release(
    @CurrentAdmin() admin: AdminUserView,
    @Param('wawuUserId', ParseUUIDPipe) wawuUserId: string,
  ): Promise<IdentityHoldReleaseView> {
    return this.service.release(admin, wawuUserId);
  }
}
