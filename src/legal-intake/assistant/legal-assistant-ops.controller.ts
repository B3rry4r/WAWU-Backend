import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import { AdminRole } from '../../../generated/prisma/enums';
import { AdminAuthGuard } from '../../admin/auth/guards/admin-auth.guard';
import { AdminRolesGuard } from '../../admin/auth/guards/admin-roles.guard';
import { AdminRoles } from '../../admin/auth/decorators/admin-roles.decorator';
import { LegalAssistantService } from './legal-assistant.service';
import type { LegalAssistantTranscript } from './legal-assistant.types';

/**
 * The consultant's read of what the assistant and the client said before the
 * brief was sent (LEGAL-01): `GET /api/hub/legal/ops/intakes/{id}/assistant`.
 *
 * Beside the intake queue and detail (LegalIntakeOpsController), with the
 * same roles: superadmin and support; finance and reviewer are refused. The
 * brief itself is on the intake detail, and the conversation after sending
 * is the matter's thread (`/legal/ops/intakes/chat/{requestId}`), where the
 * consultant joins.
 */
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Controller('legal/ops/intakes')
export class LegalAssistantOpsController {
  constructor(private readonly service: LegalAssistantService) {}

  @AdminRoles(AdminRole.superadmin, AdminRole.support)
  @Get(':id/assistant')
  transcript(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<LegalAssistantTranscript> {
    return this.service.transcriptForOps(id);
  }
}
