import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
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
import { OpsApplicationQueueQueryDto } from './dto/ops-application-queue-query.dto';

/**
 * Operator progression for ServiceApplication.
 *
 * A separate controller, not extra routes on ServiceApplicationController,
 * because that class carries a class-level `@UseGuards(WawuAuthGuard)`: an
 * admin token is HS256 and would be rejected by that guard before it was ever
 * read. Route paths are new (`/services/ops/...`), so nothing existing moves.
 *
 * ── ROLE MATRIX (documented, and enforced per handler) ────────────────────
 *   queue, detail              — superadmin, support
 *   progress, reject, approve  — superadmin, support
 *   reviewer, finance          — refused entirely
 *
 * The two reads match the writes exactly, and that is the decision rather
 * than the default. A read-only role would be a third party holding the URLs
 * of somebody's ID, signature and passport photograph with no action to take
 * on them — a disclosure with no job attached. The inverse is worse: `support`
 * can already move, refuse and approve these applications, so withholding the
 * queue from them would leave the three writes needing an id that nothing
 * they can reach supplies, which is the exact hole these reads close.
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

  /**
   * The operator queue. Every applicant's applications, not the caller's —
   * oldest first, filterable by `status` and by `kind`, paginated with the
   * app's own PaginationQueryDto so `total` is a real count.
   *
   * Declared BEFORE `:id`, because Nest matches in declaration order and this
   * controller now owns both. The route itself is exact (`GET
   * /services/ops/applications`) so `:id` could not have shadowed it anyway,
   * but relying on that is not the same as the order being right.
   *
   * Not audited: a queue row carries no document URL and no intake answers.
   * The detail below is the read that discloses, and it is the read that is
   * recorded.
   */
  @AdminRoles(AdminRole.superadmin, AdminRole.support)
  @Get()
  queue(@Query() query: OpsApplicationQueueQueryDto) {
    return this.applications.opsQueue(query);
  }

  /**
   * One application in full — the applicant's own answers, their uploaded
   * documents, the timeline, the rejection reason, the expected-certificate
   * date and the amount paid.
   *
   * Writes an `application_documents_viewed` audit row. See
   * ServiceApplicationService.opsDetail for why this read is audited when the
   * queue is not.
   *
   * `ParseUUIDPipe` is version-UNPINNED, matching the three writes below on
   * the same id and the app's own `GET /services/applications/:id`: pinning v4
   * here and not there would mean one id shape the operator surface rejects
   * and the app accepts.
   */
  @AdminRoles(AdminRole.superadmin, AdminRole.support)
  @Get(':id')
  detail(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AdminUserView,
  ) {
    return this.applications.opsDetail(id, admin);
  }

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
