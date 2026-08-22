import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { AdminRole } from '../../generated/prisma/enums';
import {
  MAX_PAGE,
  MAX_PER_PAGE,
  paginateArray,
  wantsPagination,
} from '../common/dto/pagination.dto';
import type { Paginated } from '../common/interceptors/response.interceptor';
import type { LearnGuideResponse } from '../common/types';
import { ListLearnGuidesQueryDto } from './dto/list-learn-guides-query.dto';
import { LearnGuideService } from './learn-guide.service';
import { AdminAuthGuard } from '../admin/auth/guards/admin-auth.guard';
import { AdminRolesGuard } from '../admin/auth/guards/admin-roles.guard';
import { AdminRoles } from '../admin/auth/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../admin/auth/decorators/current-admin.decorator';
import type { AdminUserView } from '../admin/auth/admin-user-view.type';
import { UpsertLearnGuideDto } from './dto/upsert-learn-guide.dto';

/**
 * `kind`/`country` filters + opt-in `page`/`perPage`. One class because the
 * global ValidationPipe runs `forbidNonWhitelisted` — two separate @Query()
 * DTOs on one handler would each reject the other's properties.
 */
class ListLearnGuidesPagedQueryDto extends ListLearnGuidesQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PER_PAGE)
  perPage?: number;
}

/**
 * Registry resource: LearnGuide. Both READ endpoints are `roles: ["any"]`
 * (public, no `WawuAuthGuard`) — the "Learn" hub's country/article/template
 * guides are readable by anyone, matching the frontend's SEAM comment
 * (`getMockGuides()` takes no auth/token).
 *
 * ── WRITE ROLE: superadmin ONLY ──────────────────────────────────────────
 * `POST /learn/guides` and `PATCH /learn/guides/:id` used to sit behind
 * AdminKeyGuard — one shared static secret, no identity, no roles — so anyone
 * holding the key could publish or rewrite a guide that this controller then
 * serves to the PUBLIC, unauthenticated, with a document link attached.
 *
 * Same reasoning as the playbook next door: authoring is neither a support
 * function nor a moderation one. `reviewer` judges other people's uploads,
 * `support` answers tickets, `finance` handles money; none of them has a claim
 * on WAWU's own published words, and no content-author role exists to give it
 * to. superadmin is the narrowest correct answer and the one that can be
 * widened later without a migration.
 *
 * There is no class-level guard: the two reads must stay public, so the admin
 * pair is declared per write handler. AdminRolesGuard does not treat
 * superadmin as implicitly allowed, so it is named explicitly.
 */
@Controller('learn/guides')
export class LearnGuideController {
  constructor(private readonly learnGuideService: LearnGuideService) {}

  /** Opt-in pagination — no `page`/`perPage` returns the full array as before. */
  @Get()
  async list(
    @Query() query: ListLearnGuidesPagedQueryDto,
  ): Promise<LearnGuideResponse[] | Paginated<LearnGuideResponse>> {
    const guides = await this.learnGuideService.findAll(query);
    return wantsPagination(query) ? paginateArray(guides, query) : guides;
  }

  /**
   * Operator upload. Guides were seeded text with no document behind them.
   * Publishing a guide is not a user action.
   */
  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @AdminRoles(AdminRole.superadmin)
  @Post()
  create(
    @Body() dto: UpsertLearnGuideDto,
    @CurrentAdmin() admin: AdminUserView,
  ) {
    return this.learnGuideService.createGuide(dto, admin);
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @AdminRoles(AdminRole.superadmin)
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpsertLearnGuideDto,
    @CurrentAdmin() admin: AdminUserView,
  ) {
    return this.learnGuideService.updateGuide(id, dto, admin);
  }

  @Get(':id')
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<LearnGuideResponse> {
    const guide = await this.learnGuideService.findOne(id);
    if (!guide) {
      throw new NotFoundException('Learn guide not found.');
    }
    return guide;
  }
}
