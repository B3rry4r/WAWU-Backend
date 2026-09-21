import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { PaginationQueryDto } from '../common/dto/pagination.dto';
import { ContentPieceService } from '../content-piece/content-piece.service';
import { UserProfileService } from './user-profile.service';
import { UpdateUserProfileDto } from './dto/update-user-profile.dto';
import { ProfileExperienceService } from './profile-experience.service';
import {
  CreateProfileExperienceDto,
  UpdateProfileExperienceDto,
} from './dto/profile-experience.dto';

/**
 * registry.json "UserProfile": GET/PATCH /users/me (roles: ["any"]) and
 * GET /users/:wawuId/public-profile (roles: ["any"] — public creator view,
 * still requires auth per this backend's own WawuAuthGuard convention since
 * no endpoint in this build is unauthenticated).
 *
 * GET /users/:wawuId/content is NEW (not in the frozen registry, so it is
 * additive rather than a change to an existing contract): the profile
 * screen's Content tab had nowhere to read a creator's published pieces from
 * — `public-profile` returns only `contentCount`, never the items — so it
 * rendered "Nothing published yet" for every creator regardless of what they
 * had live. Delegates to ContentPieceService rather than re-querying
 * ContentPiece here, so this reuses the exact same live-only filter and
 * per-requester paid-content gating (`fullAssetUrl` locked unless the
 * CALLER purchased it) that every other content list already applies.
 */
@UseGuards(WawuAuthGuard)
@Controller('users')
export class UserProfileController {
  constructor(
    private readonly userProfileService: UserProfileService,
    private readonly contentPieceService: ContentPieceService,
    private readonly profileExperienceService: ProfileExperienceService,
  ) {}

  @Get('me')
  getMe(@CurrentUser() user: WawuJwtClaims) {
    return this.userProfileService.getMe(user);
  }

  @Patch('me')
  upsertMe(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: UpdateUserProfileDto,
  ) {
    return this.userProfileService.upsertMe(user, dto);
  }

  /**
   * Your own profile's numbers: the three-up row, both stat cards and the
   * completeness ring.
   *
   * Declared BEFORE `:wawuId/public-profile` because Nest matches in
   * declaration order and `me` would otherwise be read as a wawuId. Owner-only
   * by construction — it takes the caller's id from the token and has no
   * parameter that could point it at anybody else, which is what keeps
   * profile views and sales off a stranger's screen.
   */
  @Get('me/profile-stats')
  getProfileStats(@CurrentUser() user: WawuJwtClaims) {
    return this.userProfileService.getProfileStats(user.sub);
  }

  /*
    ── THE EXPERIENCE LIST ──────────────────────────────────────────────────

    Declared here, ABOVE the `:wawuId` routes, for the reason
    `me/profile-stats` gives: Nest matches in declaration order, so a handler
    on `:wawuId/...` placed first would swallow "me" as a wawuId.

    Every one of these takes the owner from the token and has no parameter
    that could point it at another account. That is what makes them
    owner-only, rather than a check inside each handler that has to be
    remembered four times.

    There is no `GET me/experience`: the list already comes back on
    `GET /users/me` and on the public profile, and a second endpoint serving
    the same rows is a second thing to keep in step.
  */
  @Post('me/experience')
  addExperience(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: CreateProfileExperienceDto,
  ) {
    return this.profileExperienceService.create(user.sub, dto);
  }

  @Patch('me/experience/:id')
  editExperience(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id') id: string,
    @Body() dto: UpdateProfileExperienceDto,
  ) {
    return this.profileExperienceService.update(user.sub, id, dto);
  }

  @Delete('me/experience/:id')
  removeExperience(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id') id: string,
  ) {
    return this.profileExperienceService.remove(user.sub, id);
  }

  /**
   * Somebody else's public profile.
   *
   * The caller is passed through so the visit can be counted once per viewer
   * per day. Your own profile is never counted as a view of itself — see
   * UserProfileService.recordProfileView.
   */
  @Get(':wawuId/public-profile')
  getPublicProfile(
    @Param('wawuId') wawuId: string,
    @CurrentUser() user: WawuJwtClaims,
  ) {
    return this.userProfileService.getPublicProfile(wawuId, user.sub);
  }

  @Get(':wawuId/content')
  getContent(
    @Param('wawuId') wawuId: string,
    @CurrentUser() user: WawuJwtClaims,
    @Query() query: PaginationQueryDto,
  ) {
    return this.contentPieceService.listByCreator(
      wawuId,
      user.sub,
      query.page,
      query.perPage,
    );
  }
}
