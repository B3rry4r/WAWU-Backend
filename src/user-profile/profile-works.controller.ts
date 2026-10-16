import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import {
  CreateProfileWorkDto,
  ListProfileWorksQueryDto,
  ReorderProfileWorksDto,
  UpdateProfileWorkDto,
} from './dto/profile-work.dto';
import {
  CreateProfileEducationDto,
  UpdateProfileEducationDto,
} from './dto/profile-education.dto';
import { ProfileWorkService } from './profile-work.service';
import { ProfileEducationService } from './profile-education.service';

/**
 * Featured works and education (ME-16). New routes, none in the protected
 * list: `GET`/`PATCH /users/me` and the public profile answer exactly as
 * before, and these are read from their own routes.
 *
 * The `me/...` routes are declared FIRST, for the reason `me/profile-stats`
 * gives on UserProfileController: Nest matches in declaration order, and
 * `:wawuId/featured-works` would read "me" as a wawuId. Every `me/...` route
 * takes the owner from the token and has no parameter that could point it at
 * another account, which is what makes it owner-only. The `:wawuId/...`
 * routes are the visitor's: a hidden or missing person is one 404.
 */
@UseGuards(WawuAuthGuard)
@Controller('users')
export class ProfileWorksController {
  constructor(
    private readonly works: ProfileWorkService,
    private readonly education: ProfileEducationService,
  ) {}

  // ── featured works, the owner's ───────────────────────────────────────────

  @Get('me/featured-works')
  myWorks(
    @CurrentUser() user: WawuJwtClaims,
    @Query() query: ListProfileWorksQueryDto,
  ) {
    return this.works.list(user.sub, query);
  }

  @Post('me/featured-works')
  addWork(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: CreateProfileWorkDto,
  ) {
    return this.works.create(user.sub, dto);
  }

  /** Declared above `me/featured-works/:id` so that route does not take "order" for an id. */
  @Put('me/featured-works/order')
  reorderWorks(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: ReorderProfileWorksDto,
  ) {
    return this.works.reorder(user.sub, dto);
  }

  @Patch('me/featured-works/:id')
  editWork(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id') id: string,
    @Body() dto: UpdateProfileWorkDto,
  ) {
    return this.works.update(user.sub, id, dto);
  }

  @Delete('me/featured-works/:id')
  removeWork(@CurrentUser() user: WawuJwtClaims, @Param('id') id: string) {
    return this.works.remove(user.sub, id);
  }

  // ── education, the owner's ────────────────────────────────────────────────

  @Get('me/education')
  myEducation(@CurrentUser() user: WawuJwtClaims) {
    return this.education.list(user.sub);
  }

  @Post('me/education')
  addEducation(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: CreateProfileEducationDto,
  ) {
    return this.education.create(user.sub, dto);
  }

  @Patch('me/education/:id')
  editEducation(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id') id: string,
    @Body() dto: UpdateProfileEducationDto,
  ) {
    return this.education.update(user.sub, id, dto);
  }

  @Delete('me/education/:id')
  removeEducation(@CurrentUser() user: WawuJwtClaims, @Param('id') id: string) {
    return this.education.remove(user.sub, id);
  }

  // ── what a visitor reads ──────────────────────────────────────────────────

  /** M33 and M34: somebody's works, newest-chosen first, with the category chips. */
  @Get(':wawuId/featured-works')
  worksOf(
    @Param('wawuId') wawuId: string,
    @CurrentUser() user: WawuJwtClaims,
    @Query() query: ListProfileWorksQueryDto,
  ) {
    return this.works.listFor(wawuId, user.sub, query);
  }

  /** M35: one work. */
  @Get(':wawuId/featured-works/:workId')
  workOf(
    @Param('wawuId') wawuId: string,
    @Param('workId') workId: string,
    @CurrentUser() user: WawuJwtClaims,
  ) {
    return this.works.getFor(wawuId, workId, user.sub);
  }

  /** M33: somebody's education. */
  @Get(':wawuId/education')
  educationOf(
    @Param('wawuId') wawuId: string,
    @CurrentUser() user: WawuJwtClaims,
  ) {
    return this.education.listFor(wawuId, user.sub);
  }
}
