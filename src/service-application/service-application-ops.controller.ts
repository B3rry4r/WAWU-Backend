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
import { CurrentAdmin } from '../admin/auth/decorators/current-admin.decorator';
import type { AdminUserView } from '../admin/auth/admin-user-view.type';
import { ServiceApplicationService } from './service-application.service';
import {
  ApproveApplicationDto,
  ProgressApplicationDto,
  RejectApplicationDto,
} from './dto/progress-application.dto';

/**
 * Operator progression for ServiceApplication.
 *
 * A separate controller, not extra routes on ServiceApplicationController,
 * because that class carries a class-level `@UseGuards(WawuAuthGuard)`: an
 * admin token is HS256 and would be rejected by that guard before it was ever
 * read. Route paths are new (`/services/ops/...`), so nothing existing moves.
 *
 * ── ROLE MATRIX (documented, and enforced per handler) ────────────────────
 *   progress, reject, approve  — superadmin, support
 *   reviewer, finance          — refused entirely
 *
 * This controller previously sat behind AdminKeyGuard: one shared static
 * secret, no identity, no roles.
 *
 * `support` owns all three because all three ARE the queue — a CAC or NEPC
 * application is worked by relaying what the registry did, and `approve`,
 * `reject` and `progress` are the three things the registry can come back
 * with. None of them invents a naira figure: `amountPaid` is written at intake
 * by the payment leg and no handler here touches it. A rejection strands the
 * ₦25,000 a CAC applicant already paid, which is why the DTO makes the reason
 * mandatory — but the refusal itself is CAC's answer being written down, not a
 * discretionary decision about the applicant's money.
 *
 * `finance` is refused, and that is the deliberate mirror of the legal
 * controller next door: there, finance prices and closes because those
 * handlers write money; here nothing does, so a finance login has no business
 * moving somebody's export registration along. `reviewer` is refused because
 * it is the MODERATION role (creator content, creator KYC) and this is not
 * moderation.
 *
 * AdminRolesGuard does not treat superadmin as implicitly allowed, so every
 * handler names its roles.
 */
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Controller('services/ops/applications')
export class ServiceApplicationOpsController {
  constructor(private readonly applications: ServiceApplicationService) {}

  /** Appends a timeline step, and optionally moves the status or the date. */
  @AdminRoles(AdminRole.superadmin, AdminRole.support)
  @Post(':id/progress')
  @HttpCode(HttpStatus.OK)
  progress(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ProgressApplicationDto,
    @CurrentAdmin() admin: AdminUserView,
  ) {
    return this.applications.progress(id, dto, admin);
  }

  @AdminRoles(AdminRole.superadmin, AdminRole.support)
  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectApplicationDto,
    @CurrentAdmin() admin: AdminUserView,
  ) {
    return this.applications.reject(id, dto, admin);
  }

  @AdminRoles(AdminRole.superadmin, AdminRole.support)
  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveApplicationDto,
    @CurrentAdmin() admin: AdminUserView,
  ) {
    return this.applications.approve(id, dto, admin);
  }
}
