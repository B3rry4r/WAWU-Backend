import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
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
    return this.userProfileService.upsertMe(user.sub, dto);
  }

  @Get(':wawuId/public-profile')
  getPublicProfile(@Param('wawuId') wawuId: string) {
    return this.userProfileService.getPublicProfile(wawuId);
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
