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
import type {
  CommunityJoinRequest,
  CommunityMembership,
  CommunityResponse,
} from '../common/types';

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

  /**
   * ---------------------------------------------------------------------
   * Host-side membership review — the other half of a private community.
   * ---------------------------------------------------------------------
   *
   *   GET    /communities/:id/requests                        host-only
   *   POST   /communities/:id/requests/:userWawuId/approve    host-only
   *   DELETE /communities/:id/requests/:userWawuId            host-only
   *   DELETE /communities/:id/members/:userWawuId             host-only
   *
   * `POST /:id/join` wrote `status: 'pending'` for a private community and
   * nothing could ever flip it, so a private community — the Pro tier's
   * headline feature — could be requested but never entered.
   *
   * CreatorAccountGuard here matches PATCH /:id above: managing a community
   * is a creator-account capability, and hosting one already requires a
   * creator account (POST /communities). It proves the ROLE only; that the
   * caller is THIS community's host is proved in CommunityService, exactly
   * as update()'s host check is.
   *
   * `:userWawuId` is the member/requester, validated as a v4 UUID the same
   * way FollowRelationship and EvgScore validate their own `:wawuId` params.
   * It is a path param rather than a body field because these are actions on
   * one identified request, not edits to a collection.
   */
  @Get(':id/requests')
  @UseGuards(CreatorAccountGuard)
  listJoinRequests(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: WawuJwtClaims,
    @Query() { page, perPage }: PaginationQueryDto,
  ): Promise<Paginated<CommunityJoinRequest>> {
    return this.communityService.listJoinRequests(id, user.sub, page, perPage);
  }

  /** 200, not 201: this settles an existing request, it creates nothing. */
  @Post(':id/requests/:userWawuId/approve')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CreatorAccountGuard)
  approveJoinRequest(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('userWawuId', new ParseUUIDPipe({ version: '4' }))
    userWawuId: string,
    @CurrentUser() user: WawuJwtClaims,
  ): Promise<CommunityMembership> {
    return this.communityService.approveJoinRequest(id, user.sub, userWawuId);
  }

  /** Decline. DELETE because it deletes the request row — see the service. */
  @Delete(':id/requests/:userWawuId')
  @UseGuards(CreatorAccountGuard)
  declineJoinRequest(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('userWawuId', new ParseUUIDPipe({ version: '4' }))
    userWawuId: string,
    @CurrentUser() user: WawuJwtClaims,
  ): Promise<{ declined: true }> {
    return this.communityService.declineJoinRequest(id, user.sub, userWawuId);
  }

  /**
   * Remove a settled member. Separate from decline on purpose: ejecting
   * someone who is already in must never be something a stale queue can do
   * by accident.
   */
  @Delete(':id/members/:userWawuId')
  @UseGuards(CreatorAccountGuard)
  removeMember(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('userWawuId', new ParseUUIDPipe({ version: '4' }))
    userWawuId: string,
    @CurrentUser() user: WawuJwtClaims,
  ): Promise<{ removed: true }> {
    return this.communityService.removeMember(id, user.sub, userWawuId);
  }
}
