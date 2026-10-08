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
import { ApiResponse } from '@nestjs/swagger';
import { AdminRole } from '../../../generated/prisma/enums';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { AdminRolesGuard } from '../auth/guards/admin-roles.guard';
import { AdminRoles } from '../auth/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../auth/decorators/current-admin.decorator';
import type { AdminUserView } from '../auth/admin-user-view.type';
import type { AdminProfessionalDecisionView } from './admin-professional-view.type';
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
 *   unlist, relist       — superadmin, reviewer
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

  /**
   * Pull an approved listing without erasing that it was approved. It stays
   * out until an admin lists it again: the owner's Show is refused (FIX-06).
   */
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Post(':id/unlist')
  @HttpCode(HttpStatus.OK)
  unlist(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AdminUserView,
  ) {
    return this.service.unlist(id, admin);
  }

  /**
   * List again a listing an admin took down (FIX-06). It goes back to what
   * its owner had chosen, and the owner hides and shows it as before.
   */
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Post(':id/relist')
  @HttpCode(HttpStatus.OK)
  @ApiResponse({
    status: 409,
    description:
      'Refused (reason.code listing_not_taken_down): no admin takedown stands on this listing, so its owner shows or hides it.',
  })
  relist(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AdminUserView,
  ): Promise<AdminProfessionalDecisionView> {
    return this.service.relist(id, admin);
  }
}
