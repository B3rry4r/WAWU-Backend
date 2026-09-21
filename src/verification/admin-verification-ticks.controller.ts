import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AdminRole } from '../../generated/prisma/enums';
import { AdminAuthGuard } from '../admin/auth/guards/admin-auth.guard';
import { AdminRolesGuard } from '../admin/auth/guards/admin-roles.guard';
import { AdminRoles } from '../admin/auth/decorators/admin-roles.decorator';
import { VerificationService } from './verification.service';
import { AdminTickDto } from './dto/admin-tick.dto';

/**
 * Granting and revoking a tick by hand -
 * `/api/hub/admin/verification/ticks/*` once the global prefix is applied.
 *
 * ── WHY IT IS NOT ON AdminVerificationReviewController ───────────────────
 * That controller is the ladder SUBMISSION queue, and its routes take a
 * submission id in the `:id` position. These take a WAWU USER id. Two
 * different kinds of id at the same path depth on the same controller is how
 * somebody eventually decides the wrong row, so these sit one segment deeper
 * under a literal `ticks/` and are unambiguous by construction. Nothing here
 * can shadow that controller either: its parameter routes are two segments
 * under `admin/verification` and these are three.
 *
 * ── ROLES ────────────────────────────────────────────────────────────────
 * superadmin and reviewer, matching the approve/reject decisions on the
 * ladder queue. Support can read that surface but decides nothing, and
 * finance has no claim on a badge.
 */
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Controller('admin/verification/ticks')
export class AdminVerificationTicksController {
  constructor(private readonly ticks: VerificationService) {}

  /**
   * Grant a tick with no payment behind it.
   *
   * Omitting `until` grants a PERPETUAL tick, which is deliberate: it is what
   * the accounts grandfathered off the old ladder carry. Pass a date for a
   * comped annual term instead.
   */
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Post(':wawuUserId/grant')
  @HttpCode(HttpStatus.OK)
  grant(
    @Param('wawuUserId', ParseUUIDPipe) wawuUserId: string,
    @Body() dto: AdminTickDto,
  ) {
    return this.ticks.grant(
      wawuUserId,
      dto.kind,
      dto.until ? new Date(dto.until) : null,
    );
  }

  /**
   * Take a tick away.
   *
   * WAWU ID is written first, as on a grant. The VerificationPurchase rows
   * are left alone: they record a payment that really happened, and revoking
   * the tick does not un-happen it.
   */
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Post(':wawuUserId/revoke')
  @HttpCode(HttpStatus.OK)
  revoke(
    @Param('wawuUserId', ParseUUIDPipe) wawuUserId: string,
    @Body() dto: AdminTickDto,
  ) {
    return this.ticks.revoke(wawuUserId, dto.kind);
  }
}
