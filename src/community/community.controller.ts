import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { PaginationQueryDto } from '../common/dto/pagination.dto';
import { CommunityService } from './community.service';
import { CreatorAccountGuard } from './guards/creator-account-guard';
import { CreateCommunityDto } from './dto/create-community.dto';
import { UpdateCommunityDto } from './dto/update-community.dto';
import type { Paginated } from '../common/interceptors/response.interceptor';
import type { CommunityMembership, CommunityResponse } from '../common/types';

/**
 * registry.json "Community": GET /communities, GET /communities/:id,
 * POST /communities/:id/join. All three `roles: ["any"]` — read as "any
 * authenticated WAWU user" (conventions.md § Roles & permissions guard idiom
 * — mirrors Mentor's directory-style GET endpoints, which also gate on
 * WawuAuthGuard despite being read-only browsing, not user-scoped data).
 *
 * POST /communities and PATCH /communities/:id are the hosting endpoints —
 * creator-only (CreatorAccountGuard, layered on the controller-wide
 * WawuAuthGuard). Community hosting is a sold subscription feature that had
 * no write path at all: nothing in this backend could create a Community
 * row. The entitlement gates (paid subscription; Pro tier for a private
 * community; host-only editing) live in CommunityService, not here.
 */
@UseGuards(WawuAuthGuard)
@Controller('communities')
export class CommunityController {
  constructor(private readonly communityService: CommunityService) {}

  @Get()
  list(
    @Query() { page, perPage }: PaginationQueryDto,
  ): Promise<Paginated<CommunityResponse>> {
    return this.communityService.list(page, perPage);
  }

  /**
   * Opens a community hosted by the calling creator. Declared before
   * `POST /:id/join` for readability only — the two paths cannot collide.
   */
  @Post()
  @UseGuards(CreatorAccountGuard)
  create(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: CreateCommunityDto,
  ): Promise<CommunityResponse> {
    return this.communityService.create(user.sub, dto);
  }

  /** Host-only edit of name/description. `kind` is immutable — see the DTO. */
  @Patch(':id')
  @UseGuards(CreatorAccountGuard)
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: UpdateCommunityDto,
  ): Promise<CommunityResponse> {
    return this.communityService.update(id, user.sub, dto);
  }

  @Get(':id')
  findOne(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<CommunityResponse> {
    return this.communityService.findOne(id);
  }

  @Get(':id/membership')
  myMembership(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: WawuJwtClaims,
  ) {
    return this.communityService.myMembership(id, user.sub);
  }

  @Delete(':id/join')
  leave(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: WawuJwtClaims,
  ) {
    return this.communityService.leave(id, user.sub);
  }

  @Post(':id/join')
  @HttpCode(HttpStatus.OK)
  join(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: WawuJwtClaims,
  ): Promise<CommunityMembership> {
    return this.communityService.join(id, user.sub);
  }
}
