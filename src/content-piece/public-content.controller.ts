import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ContentPieceService } from './content-piece.service';
import { PaginationQueryDto } from '../common/dto/pagination.dto';

/**
 * Genuinely unauthenticated read for the signed-out marketing landing page's
 * "Creators to watch" section. ContentPieceController is guarded at the
 * class level (@UseGuards(WawuAuthGuard)) with no per-route bypass, and
 * every other route on it needs a real signed-in caller — this is the one
 * exception, kept in its own ungated controller rather than weakening the
 * shared guard. list()'s requesterWawuId is already optional and
 * resolveUnlockedSet() already returns an empty set for `undefined`, so
 * every piece correctly comes back locked (never unlocked) for an
 * anonymous caller — nothing here that isn't already public-safe.
 */
@Controller('content/public')
export class PublicContentController {
  constructor(private readonly contentPieceService: ContentPieceService) {}

  @Get('featured')
  featured() {
    return this.contentPieceService.list(undefined, 'feed', undefined, 1, 3);
  }

  /**
   * One creator's live content, to ANYBODY.
   *
   * WHY IT HAD TO EXIST. A shared store link (build brief C3) opens a
   * creator's shop with no session. The only per-creator content read was
   * GET /users/:wawuId/content, which sits on a guarded controller and 401s
   * an anonymous caller, so the store rendered identity and cross-sell over
   * an empty shelf: the page whose entire job is to sell somebody's work
   * could not show any of it. The alternative considered and rejected was
   * filling the shelf from /content/public/featured, which is
   * platform-wide - that would present an arbitrary subset of the platform
   * as one person's shop.
   *
   * WHY IT IS SAFE. `listByCreator` already takes an OPTIONAL requester and
   * `resolveUnlockedSet(undefined, ...)` returns an empty set, so every
   * piece comes back locked and `fullAssetUrl` is withheld from all of them.
   * An anonymous caller therefore sees exactly what a signed-in stranger
   * sees: titles, covers, prices, and nothing behind the paywall. It also
   * filters `status: 'live'`, so a pending or rejected piece is never
   * exposed.
   *
   * It lives on this ungated controller rather than as a bypass on the
   * guarded one, which is the same call this file's header comment makes
   * about `featured`: weakening a class-level guard for one route is how a
   * guard stops meaning anything.
   */
  /**
   * One piece, to ANYBODY, with no session.
   *
   * WHY IT HAD TO EXIST. Build brief C3: on a shared store link
   * "registration is required ONLY at checkout." It was required far earlier
   * than that - tapping any piece on a public store bounced the visitor to
   * /sign-in, because the only single-piece read sits on the guarded
   * controller. So somebody who followed a creator's link could see that
   * work existed and never look at it.
   *
   * WHY IT IS SAFE. `findOne` already takes an OPTIONAL requester, and with
   * `undefined` the unlocked set is empty: a paid piece comes back locked
   * with no `fullAssetUrl`. Its own status check also refuses anything that
   * is not `live` to a non-owner, and an anonymous caller is never the
   * owner, so a draft, a pending submission or a removed piece stays
   * invisible. An anonymous visitor sees exactly what a signed-in stranger
   * sees: the title, the preview, the price, and a locked body.
   */
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.contentPieceService.findOne(id, undefined);
  }

  @Get('creator/:wawuId/content')
  creatorContent(
    @Param('wawuId') wawuId: string,
    @Query() query: PaginationQueryDto,
  ) {
    return this.contentPieceService.listByCreator(
      wawuId,
      undefined,
      query.page,
      query.perPage,
    );
  }
}
