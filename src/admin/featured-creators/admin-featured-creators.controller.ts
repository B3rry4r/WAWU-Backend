import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import { AccountType, ContentStatus } from '../../../generated/prisma/enums';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AdminRoles } from '../auth/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../auth/decorators/current-admin.decorator';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { AdminRolesGuard } from '../auth/guards/admin-roles.guard';
import type { AdminUserView } from '../auth/admin-user-view.type';
import { AdminRole } from '../../../generated/prisma/enums';
import { PutFeaturedCreatorDto } from './put-featured-creator.dto';

/** A WAWU id is a plain token; anything else cannot name a creator. */
const ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * `/api/hub/admin/featured-creators/:wawuId` (EXPLORE-03): choose who appears
 * in Explore's Featured creators rail. Superadmin only, the same guards as
 * PUT /admin/policies/:slug. The row's key is the creator's id, so featuring
 * twice, or from two tabs at once, leaves one row (upsert on the key).
 */
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Controller('admin/featured-creators')
export class AdminFeaturedCreatorsController {
  constructor(private readonly prisma: PrismaService) {}

  @AdminRoles(AdminRole.superadmin)
  @Put(':wawuId')
  @HttpCode(HttpStatus.OK)
  async put(
    @Param('wawuId') wawuId: string,
    @Body() dto: PutFeaturedCreatorDto,
    @CurrentAdmin() admin: AdminUserView,
  ) {
    const profile = ID_SHAPE.test(wawuId)
      ? await this.prisma.userProfile.findUnique({
          where: { wawuUserId: wawuId },
          select: { accountType: true },
        })
      : null;
    if (!profile || profile.accountType !== AccountType.creator) {
      throw new NotFoundException('Creator not found');
    }
    // Featuring someone nobody can be shown is refused, so the admin is told
    // why the rail would stay short instead of getting a silent 200.
    const [live, privacy] = await Promise.all([
      this.prisma.contentPiece.count({
        where: { creatorWawuId: wawuId, status: ContentStatus.live },
      }),
      this.prisma.privacySettings.findUnique({
        where: { userWawuId: wawuId },
        select: { showInMemberLists: true },
      }),
    ]);
    if (live === 0) {
      throw new BadRequestException(
        'This creator has nothing published yet, so Explore cannot show them',
      );
    }
    if (privacy && !privacy.showInMemberLists) {
      throw new BadRequestException(
        'This creator has turned off being shown in member lists',
      );
    }
    const position = dto.position ?? 0;
    const row = await this.prisma.featuredCreator.upsert({
      where: { wawuUserId: wawuId },
      create: { wawuUserId: wawuId, position, featuredByAdminId: admin.id },
      update: { position, featuredByAdminId: admin.id },
    });
    return { wawuId: row.wawuUserId, featured: true, position: row.position };
  }

  /** Idempotent: un-featuring a creator who is not featured is still 200. */
  @AdminRoles(AdminRole.superadmin)
  @Delete(':wawuId')
  @HttpCode(HttpStatus.OK)
  async remove(@Param('wawuId') wawuId: string) {
    if (ID_SHAPE.test(wawuId)) {
      await this.prisma.featuredCreator.deleteMany({
        where: { wawuUserId: wawuId },
      });
    }
    return { wawuId, featured: false };
  }
}
