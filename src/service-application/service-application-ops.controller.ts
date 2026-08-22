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
import { AdminKeyGuard } from '../common/guards/admin-key.guard';
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
 * because that class carries a class-level `@UseGuards(WawuAuthGuard)`: these
 * are server-to-server ops calls authenticated by the shared operator key, not
 * by a user's token. Route paths are new (`/services/ops/...`), so nothing
 * existing moves.
 *
 * FOLLOW-UP: AdminKeyGuard is the interim shared-key idiom (see the guard's
 * own comment). A real admin identity exists on another branch; when it lands,
 * these three routes should move onto it and the key can go.
 */
@UseGuards(AdminKeyGuard)
@Controller('services/ops/applications')
export class ServiceApplicationOpsController {
  constructor(private readonly applications: ServiceApplicationService) {}

  /** Appends a timeline step, and optionally moves the status or the date. */
  @Post(':id/progress')
  @HttpCode(HttpStatus.OK)
  progress(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ProgressApplicationDto,
  ) {
    return this.applications.progress(id, dto);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectApplicationDto,
  ) {
    return this.applications.reject(id, dto);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveApplicationDto,
  ) {
    return this.applications.approve(id, dto);
  }
}
