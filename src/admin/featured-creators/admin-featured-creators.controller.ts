import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { AccountType, ContentStatus } from '../../../generated/prisma/enums';
import { WawuIdClient } from '../../common/auth/wawu-id.client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AdminRoles } from '../auth/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../auth/decorators/current-admin.decorator';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { AdminRolesGuard } from '../auth/guards/admin-roles.guard';
import type { AdminUserView } from '../auth/admin-user-view.type';
import { AdminRole } from '../../../generated/prisma/enums';
import type {
  FeaturedCreatorAdminView,
  FeaturedHiddenReason,
  FeaturedOrderView,
} from './featured-creator-admin-view.type';
import { PutFeaturedCreatorDto } from './put-featured-creator.dto';
import { ReorderFeaturedCreatorsDto } from './reorder-featured-creators.dto';

/** A WAWU id is a plain token; anything else cannot name a creator. */
const ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * `/api/hub/admin/featured-creators/:wawuId` (EXPLORE-03): choose who appears
 * in Explore's Featured creators rail. Superadmin only, the same guards as
 * PUT /admin/policies/:slug. The row's key is the creator's id, so featuring
 * twice, or from two tabs at once, leaves one row (upsert on the key).
 *
 * OPS-20 adds the two routes the dashboard's Featured creators screen needs
 * and the app never did: `GET` (the rail as an admin sees it, with who is
 * hidden today and why) and `POST /order` (every featured creator once, in
 * order, saved in one transaction). Both are superadmin only, like the rest.
 */
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Controller('admin/featured-creators')
export class AdminFeaturedCreatorsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wawuId: WawuIdClient,
  ) {}

  /** The rail in the order Explore shows it, hidden creators included. */
  @AdminRoles(AdminRole.superadmin)
  @Get()
  async list(): Promise<FeaturedCreatorAdminView[]> {
    return this.rail();
  }

  /**
   * Saves the rail order. The body must name every creator who is featured
   * now, once each: a list that misses someone, or names someone who is not
   * featured, is refused so a screen that is out of date cannot quietly drop
   * or re-add anyone. The places become 0, 1, 2 and so on in one save.
   */
  @AdminRoles(AdminRole.superadmin)
  @Post('order')
  @HttpCode(HttpStatus.OK)
  async reorder(
    @Body() dto: ReorderFeaturedCreatorsDto,
  ): Promise<FeaturedOrderView> {
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.featuredCreator.findMany({
        select: { wawuUserId: true },
      });
      const current = new Set(rows.map((r) => r.wawuUserId));
      const asked = new Set(dto.order);
      const same =
        current.size === asked.size &&
        [...asked].every((id) => current.has(id));
      if (!same) {
        throw new BadRequestException(
          'The featured list has changed. Reload it and set the order again',
        );
      }
      for (const [position, id] of dto.order.entries()) {
        await tx.featuredCreator.update({
          where: { wawuUserId: id },
          data: { position },
        });
      }
    });
    return { items: await this.rail() };
  }

  private async rail(): Promise<FeaturedCreatorAdminView[]> {
    const rows = await this.prisma.featuredCreator.findMany({
      orderBy: [
        { position: 'asc' },
        { createdAt: 'asc' },
        { wawuUserId: 'asc' },
      ],
    });
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.wawuUserId);
    const [profiles, live, privacy, identities] = await Promise.all([
      this.prisma.userProfile.findMany({
        where: { wawuUserId: { in: ids } },
        select: { wawuUserId: true, handle: true, accountType: true },
      }),
      this.prisma.contentPiece.groupBy({
        by: ['creatorWawuId'],
        where: { status: ContentStatus.live, creatorWawuId: { in: ids } },
        _count: { _all: true },
      }),
      this.prisma.privacySettings.findMany({
        where: { userWawuId: { in: ids } },
        select: { userWawuId: true, showInMemberLists: true },
      }),
      this.wawuId.lookupPublicIdentities(ids),
    ]);
    const profileOf = new Map(profiles.map((p) => [p.wawuUserId, p]));
    const pieces = new Map(live.map((l) => [l.creatorWawuId, l._count._all]));
    const listed = new Map(
      privacy.map((s) => [s.userWawuId, s.showInMemberLists]),
    );
    return rows.map((r) => {
      const profile = profileOf.get(r.wawuUserId);
      const identity = identities.get(r.wawuUserId);
      const fullName = [identity?.firstName, identity?.lastName]
        .filter(Boolean)
        .join(' ')
        .trim();
      const pieceCount = pieces.get(r.wawuUserId) ?? 0;
      let hiddenReason: FeaturedHiddenReason | null = null;
      if (!profile || profile.accountType !== AccountType.creator) {
        hiddenReason = 'not_a_creator';
      } else if (pieceCount === 0) {
        hiddenReason = 'no_live_content';
      } else if (listed.get(r.wawuUserId) === false) {
        hiddenReason = 'hidden_from_member_lists';
      }
      return {
        wawuId: r.wawuUserId,
        name: fullName || profile?.handle || '',
        handle: profile?.handle ?? null,
        position: r.position,
        featuredAt: r.createdAt.toISOString(),
        pieceCount,
        shownInExplore: hiddenReason === null,
        hiddenReason,
      };
    });
  }

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
