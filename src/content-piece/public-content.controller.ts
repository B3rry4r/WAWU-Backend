import { Controller, Get } from '@nestjs/common';
import { ContentPieceService } from './content-piece.service';

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
}
