import {
  Body,
  Controller,
  Get,
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
import { HealthPlanService } from './health-plan.service';
import { RecordCareRefundDto } from './dto/health-plan.dto';

/**
 * WAWUCare — the operator half.
 *
 * The buyer is told "our team will sort this out or refund you" when
 * enrolment fails after payment. Neither half of that sentence had an
 * implementation: nothing could re-attempt the enrolment and
 * `FulfilmentStatus.refunded` had no writer.
 *
 * ── ROLE MATRIX (documented, and enforced per handler) ────────────────────
 *   subscriptions/stuck (read)            — superadmin, finance, support
 *   retry-enrolment, record-refund        — superadmin, finance
 *   reviewer                              — refused entirely
 *
 * This controller previously sat behind AdminKeyGuard: one shared static
 * secret, no identity, no roles.
 *
 * The split matches WAWUPay's for the same reasons — "I paid for cover and
 * have no policy" is a support ticket, and the stuck rows carry the buyer's
 * own phone number and plan, not an identity document or a bank account.
 *
 * `retry-enrolment` is a WRITE to a third party, not an internal one: it calls
 * WellaHealth and, on failure, moves the row to `failed` with the partner's
 * error. It is safe to repeat by design, but it is still WAWU asking a partner
 * to enrol a named person against a payment — a finance action, not a
 * ticket-answering one. `record-refund` is money by definition.
 *
 * `reviewer` is refused throughout: it is the MODERATION role, and nothing
 * here is moderation. AdminRolesGuard does not treat superadmin as implicitly
 * allowed, so every handler names its roles.
 */
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Controller('care/ops')
export class HealthPlanOpsController {
  constructor(private readonly care: HealthPlanService) {}

  /** Everyone who has paid for cover and does not have it. */
  @AdminRoles(AdminRole.superadmin, AdminRole.finance, AdminRole.support)
  @Get('subscriptions/stuck')
  stuck() {
    return this.care.listStuck();
  }

  /** "Sort this out": ask WellaHealth for the same enrolment again. */
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  @Post('subscriptions/:id/retry-enrolment')
  @HttpCode(HttpStatus.OK)
  retry(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AdminUserView,
  ) {
    return this.care.retryEnrolment(id, admin);
  }

  /** "Or refund you": record a refund a human has already sent. */
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  @Post('subscriptions/:id/record-refund')
  @HttpCode(HttpStatus.OK)
  recordRefund(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RecordCareRefundDto,
    @CurrentAdmin() admin: AdminUserView,
  ) {
    return this.care.recordRefund(id, dto, admin);
  }
}
