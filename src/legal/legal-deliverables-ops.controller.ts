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
import { LegalDeliverablesService } from './legal-deliverables.service';
import { DeliverFilesDto } from './dto/legal-consultation.dto';
import type { DeliverFilesResultView } from './legal-consultation.types';

/**
 * Delivering several files on one legal request (LEGAL-03, S23). Beside
 * `POST /legal/ops/requests/:id/deliver`, which still delivers one file and
 * answers as it always did.
 *
 * Same roles as that route: delivering records that agreed work happened, and
 * invents no amount and strands no payer. `finance` and `reviewer` are refused.
 */
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Controller('legal/ops/requests')
export class LegalDeliverablesOpsController {
  constructor(private readonly deliverables: LegalDeliverablesService) {}

  /** Each file is posted into the client's chat and the client is notified. */
  @AdminRoles(AdminRole.superadmin, AdminRole.support)
  @Post(':id/deliverables')
  @HttpCode(HttpStatus.OK)
  deliver(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeliverFilesDto,
    @CurrentAdmin() admin: AdminUserView,
  ): Promise<DeliverFilesResultView> {
    return this.deliverables.deliver(admin, id, dto);
  }
}
