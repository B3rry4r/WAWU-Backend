import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { WawuJwtClaims } from '../../common/auth/wawu-jwt-claims.interface';

/**
 * Search is genuinely public (registry.json roles: ["any"] here reads as
 * "any caller, logged in or not" — unlike e.g. LearnEntitlement's "any
 * *authenticated*" reading, a search result set doesn't require knowing who
 * is asking). But when a valid bearer token IS present we still want
 * `req.user` populated, because two of the three SearchResponse endpoints
 * personalize when a caller is known:
 *   - GET /search: ContentPieceResponse.fullAssetLocked is per-requester
 *     (mirrors ContentPieceService's own derivation — never a stored column).
 *   - GET /search/suggestions: recentSearches is documented as per-caller.
 *
 * This runs the same 'wawu-jwt' passport strategy as WawuAuthGuard (already
 * registered process-wide by WawuAuthModule — see ContentPieceModule's own
 * guard for the precedent of not re-importing WawuAuthModule locally) but
 * overrides handleRequest so a missing/invalid/expired token degrades to an
 * anonymous request instead of 401ing. Deliberately local to this
 * resource's directory (task brief § SCOPE) — no other resource currently
 * needs optional auth, so there is nothing shared to reuse.
 */
@Injectable()
export class OptionalWawuAuthGuard extends AuthGuard('wawu-jwt') {
  handleRequest<TUser = WawuJwtClaims>(
    _err: unknown,
    user: TUser | false,
  ): TUser | undefined {
    return user ? user : undefined;
  }
}
