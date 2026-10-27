import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';
import { AdminRole } from '../../../generated/prisma/enums';
import type { AdminUserView } from '../../admin/auth/admin-user-view.type';
import { AdminRoles } from '../../admin/auth/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../../admin/auth/decorators/current-admin.decorator';
import { AdminAuthGuard } from '../../admin/auth/guards/admin-auth.guard';
import { AdminRolesGuard } from '../../admin/auth/guards/admin-roles.guard';
import {
  type StoreAdminNoticePageView,
  StoreAdminNoticeService,
  type StoreAdminNoticeView,
} from './store-admin-notice.service';

/** GET /admin/store/notices?unread=&limit= */
export class StoreAdminNoticeQueryDto {
  /** Only notices nobody has marked read. */
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' || value === '1'
      ? true
      : value === 'false'
        ? false
        : value,
  )
  @IsBoolean()
  unread?: boolean;

  @ApiPropertyOptional({ minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/**
 * The owner's notices about the store money (STORE-PAYOUT, STORE-CUT30): WAWU's
 * account short of what creators are owed (once a day), a store's cut moved to
 * 30% (once). They name no person.
 *
 * ROLE MATRIX: superadmin and finance read and mark read; reviewer and support
 * are refused (the notices carry money figures).
 */
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Controller('admin/store/notices')
export class AdminStoreNoticesController {
  constructor(private readonly notices: StoreAdminNoticeService) {}

  /** Newest first, with how many are unread. */
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  @Get()
  list(
    @Query() q: StoreAdminNoticeQueryDto,
  ): Promise<StoreAdminNoticePageView> {
    return this.notices.list({ unreadOnly: q.unread === true, limit: q.limit });
  }

  /** Marks one read. Marking it again changes nothing. */
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  @Patch(':id/read')
  @HttpCode(HttpStatus.OK)
  read(
    @CurrentAdmin() admin: AdminUserView,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<StoreAdminNoticeView> {
    return this.notices.markRead(id, admin.id);
  }
}
