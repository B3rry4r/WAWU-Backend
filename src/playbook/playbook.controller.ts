import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { AdminRole } from '../../generated/prisma/enums';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { AdminAuthGuard } from '../admin/auth/guards/admin-auth.guard';
import { AdminRolesGuard } from '../admin/auth/guards/admin-roles.guard';
import { AdminRoles } from '../admin/auth/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../admin/auth/decorators/current-admin.decorator';
import type { AdminUserView } from '../admin/auth/admin-user-view.type';
import { PlaybookService } from './playbook.service';
import type { PlaybookResponse } from '../common/types';
import { UpdatePlaybookDto } from './dto/update-playbook.dto';

/**
 * registry.json § Playbook — one READ endpoint:
 *   GET /learn/playbook  roles: ["any"]
 * (global prefix `api/hub` set in main.ts, so the wire route is
 * `GET /api/hub/learn/playbook`).
 *
 * `@UseGuards(WawuAuthGuard)` is on the GET HANDLER, not on the class, and
 * that move is behaviour-identical for the read: this controller has exactly
 * two handlers, and the other one is now admin-authenticated. Nest MERGES
 * class-level and handler-level guards rather than letting the handler
 * override, so leaving WawuAuthGuard at class level would require the PATCH to
 * satisfy BOTH — and it cannot: a WAWU ID token is RS256 and an admin token is
 * HS256, so no single request could ever hold a credential that passes both.
 * The PATCH would have been unreachable.
 */
@Controller('learn/playbook')
export class PlaybookController {
  constructor(private readonly playbookService: PlaybookService) {}

  @UseGuards(WawuAuthGuard)
  @Get()
  getPlaybook(): Promise<PlaybookResponse> {
    return this.playbookService.getPlaybook();
  }

  /**
   * Operator upload. The playbook was seeded text with no file behind it, so
   * there was no way to publish an actual document.
   *
   * ── ROLE: superadmin ONLY ────────────────────────────────────────────────
   * This used to sit behind AdminKeyGuard — one shared static secret, no
   * identity, no roles — so anyone holding the key could replace the document
   * every WAWU user downloads.
   *
   * Authorship is not a support function and it is not a moderation function.
   * `reviewer` exists to judge OTHER people's uploads (creator content, creator
   * KYC); granting it here would let a moderator swap the file behind WAWU's
   * own flagship resource. `support` answers tickets. `finance` handles money.
   * None of the three has a claim on publishing WAWU's own words, and there is
   * no content-author role in this backend to give it to — so the narrowest
   * correct answer is superadmin, which is also the one that can be widened
   * later without a migration.
   *
   * AdminRolesGuard does not treat superadmin as implicitly allowed, so it is
   * named explicitly.
   */
  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @AdminRoles(AdminRole.superadmin)
  @Patch()
  updatePlaybook(
    @Body() dto: UpdatePlaybookDto,
    @CurrentAdmin() admin: AdminUserView,
  ) {
    return this.playbookService.updatePlaybook(dto, admin);
  }
}
