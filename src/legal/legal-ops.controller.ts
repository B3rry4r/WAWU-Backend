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
import { LegalRequestsService } from './legal.service';
import {
  CancelLegalRequestDto,
  CompleteConsultationDto,
  DeliverLegalRequestDto,
  ListLegalRequestsQueryDto,
  QuoteLegalRequestDto,
} from './dto/legal.dto';

/**
 * WAWU Legal — the operator half of the lifecycle.
 *
 * Every transition the client cannot make themselves used to have no caller
 * at all. `quote()` existed on the service and no route reached it, so an
 * `awaiting_quote` request could never be priced; `consultation_scheduled`
 * was terminal after a ₦25,000–₦45,000 fee had already been taken; and
 * `in_progress` — fully-paid legal work — had no exit, with `delivered`,
 * `cancelled`, `consultation_done` and `deliverableUrl` all unwritten by any
 * code path. These are those transitions.
 *
 * Separate controller because LegalController carries a class-level
 * `@UseGuards(WawuAuthGuard)`: an admin token is HS256 and would be rejected
 * by that guard before it was ever read. New paths only — nothing on
 * `/legal/requests/...` moves.
 *
 * ── ROLE MATRIX (documented, and enforced per handler) ────────────────────
 *   queue read                          — superadmin, support, finance
 *   consultation/complete, deliver      — superadmin, support
 *   quote, cancel                       — superadmin, finance
 *   reviewer                            — refused entirely
 *
 * This controller previously sat behind AdminKeyGuard: one shared static
 * secret, no identity, no roles. A `support` admin correctly refused the KYC
 * queue could therefore cancel a fully-paid ₦120,000 matter or set the ₦ price
 * a client is then billed, and nothing recorded who did it.
 *
 * The split above is between WORKING a matter and PRICING or CLOSING one.
 * `consultation/complete` and `deliver` record that agreed work happened —
 * they are the queue a support operator exists to clear, and neither invents
 * an amount or strands a payer. `quote` writes the naira figure the client is
 * charged, and `cancel` closes a matter money has usually already been taken
 * for, creating a manual-refund obligation that no adapter in this codebase
 * can discharge. Those two are money decisions, and `finance` is the only
 * non-superadmin role this backend already trusts with one.
 *
 * `reviewer` is refused on every route here, and that is not an oversight:
 * `reviewer` is this codebase's MODERATION role — it approves and rejects
 * creator content and creator KYC. Nothing on this controller is moderation,
 * and a role that exists to judge other people's uploads has no claim on a
 * client's legal engagement.
 *
 * The queue read is open to all three because none of them can act on a
 * matter they cannot find, and `listForOps` returns `toResponse` — which
 * carries no `wawuUserId`, no intake `details` and no `consultationNotes`.
 * AdminRolesGuard does not treat superadmin as implicitly allowed, so every
 * handler names its roles.
 */
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Controller('legal/ops')
export class LegalOpsController {
  constructor(private readonly legal: LegalRequestsService) {}

  /** The work queue. Without it an operator cannot find what needs pricing. */
  @AdminRoles(AdminRole.superadmin, AdminRole.support, AdminRole.finance)
  @Get('requests')
  list(@Query() query: ListLegalRequestsQueryDto) {
    return this.legal.listForOps(query.status);
  }

  /** Prices the work. The only writer of `quoted`, and of a ₦ figure the client pays. */
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  @Post('requests/:id/quote')
  @HttpCode(HttpStatus.OK)
  quote(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: QuoteLegalRequestDto,
    @CurrentAdmin() admin: AdminUserView,
  ) {
    return this.legal.quote(id, dto, admin);
  }

  @AdminRoles(AdminRole.superadmin, AdminRole.support)
  @Post('requests/:id/consultation/complete')
  @HttpCode(HttpStatus.OK)
  completeConsultation(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteConsultationDto,
    @CurrentAdmin() admin: AdminUserView,
  ) {
    return this.legal.completeConsultation(id, dto, admin);
  }

  @AdminRoles(AdminRole.superadmin, AdminRole.support)
  @Post('requests/:id/deliver')
  @HttpCode(HttpStatus.OK)
  deliver(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeliverLegalRequestDto,
    @CurrentAdmin() admin: AdminUserView,
  ) {
    return this.legal.deliver(id, dto, admin);
  }

  /** Closes a matter that has usually already been paid for. */
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  @Post('requests/:id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelLegalRequestDto,
    @CurrentAdmin() admin: AdminUserView,
  ) {
    return this.legal.cancel(id, dto, admin);
  }
}
