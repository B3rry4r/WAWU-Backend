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
import { IsString, MaxLength } from 'class-validator';
import { AdminRole } from '../../../generated/prisma/enums';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { AdminRolesGuard } from '../auth/guards/admin-roles.guard';
import { AdminRoles } from '../auth/decorators/admin-roles.decorator';
import { AdminProfessionalReviewService } from './admin-professional-review.service';
import {
  AdminProfessionalQueueQueryDto,
  RejectProfessionalDto,
} from './dto/professional-review.dto';

class ProfessionalDocumentUrlDto {
  @IsString()
  @MaxLength(1024)
  documentUrl!: string;
}

/**
 * Professional application review — `/api/hub/admin/professionals/*`.
 *
 * ── ROLE MATRIX (documented, and enforced per handler) ─────────────────────
 *   queue, detail        — superadmin, reviewer, support
 *   document-url         — superadmin, reviewer
 *   approve, reject      — superadmin, reviewer
 *   unlist               — superadmin, reviewer
 *   finance              — refused entirely; nothing here is a money decision
 *
 * Support can READ the queue, because "where is my application" is a support
 * question, but cannot open a practising certificate or make a decision.
 * AdminRolesGuard does not treat superadmin as implicitly allowed, so every
 * handler names its roles and the matrix is readable here.
 *
 * Route order: the literal `queue` is declared before `:id`, and Nest matches
 * in declaration order.
 */
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Controller('admin/professionals')
export class AdminProfessionalReviewController {
  constructor(private readonly service: AdminProfessionalReviewService) {}

  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer, AdminRole.support)
  @Get('queue')
  queue(@Query() query: AdminProfessionalQueueQueryDto) {
    return this.service.queue(query);
  }

  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer, AdminRole.support)
  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.detail(id);
  }

  /** A short-lived signed URL for one document on this application. */
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Post(':id/document-url')
  @HttpCode(HttpStatus.OK)
  documentUrl(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ProfessionalDocumentUrlDto,
  ) {
    return this.service.documentUrl(id, dto.documentUrl);
  }

  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  approve(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.approve(id);
  }

  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectProfessionalDto,
  ) {
    return this.service.reject(id, dto.reason);
  }

  /** Pull an approved listing without erasing that it was approved. */
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Post(':id/unlist')
  @HttpCode(HttpStatus.OK)
  unlist(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.unlist(id);
  }
}
