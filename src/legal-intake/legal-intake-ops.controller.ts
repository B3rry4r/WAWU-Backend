import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminRole } from '../../generated/prisma/enums';
import { AdminAuthGuard } from '../admin/auth/guards/admin-auth.guard';
import { AdminRolesGuard } from '../admin/auth/guards/admin-roles.guard';
import { AdminRoles } from '../admin/auth/decorators/admin-roles.decorator';
import { LegalIntakeOpsService } from './legal-intake-ops.service';
import { IntakeQueueQueryDto } from './dto/legal-intake.dto';

/**
 * WAWU Legal's side of profiling — `/api/hub/legal/ops/intakes`.
 *
 * This is the screen a consultant opens before saying anything to a client:
 * the brief, and under it the client's own answers, so nobody has to ask
 * somebody to explain their problem twice.
 *
 * ── ROLE MATRIX (documented, and enforced per handler) ────────────────────
 *   queue, detail — superadmin, support
 *   finance       — refused
 *   reviewer      — refused
 *
 * Narrower than the legal-requests queue next door, and deliberately. That
 * queue returns a redacted list for pricing and closing, so `finance` belongs
 * on it. An intake is the unredacted account of somebody's legal problem —
 * the debt they are chasing, the dispute they are in, the notice they
 * received. Reading it is for the people who will actually work the matter.
 * `finance` prices what a consultant has already scoped and does not need it.
 *
 * `reviewer` is this codebase's MODERATION role — creator content and creator
 * KYC. Nothing here is moderation, and it has no claim on a client's legal
 * problem. AdminRolesGuard does not treat superadmin as implicitly allowed,
 * so every handler names its roles.
 *
 * Route order: the literal `queue` is declared before `:id`.
 */
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Controller('legal/ops/intakes')
export class LegalIntakeOpsController {
  constructor(private readonly service: LegalIntakeOpsService) {}

  /** Completed intakes waiting for a consultant, longest wait first. */
  @AdminRoles(AdminRole.superadmin, AdminRole.support)
  @Get('queue')
  queue(@Query() query: IntakeQueueQueryDto) {
    return this.service.queue(query.status);
  }

  /** The brief, and the client's own answers under it. */
  @AdminRoles(AdminRole.superadmin, AdminRole.support)
  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.detail(id);
  }
}
