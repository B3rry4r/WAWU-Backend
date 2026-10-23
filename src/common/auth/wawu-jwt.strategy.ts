import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import * as jwksRsa from 'jwks-rsa';
import type { WawuJwtClaims } from './wawu-jwt-claims.interface';

/**
 * Whether verified claims are a WAWU ID ACCESS token (FIX-99, H3). WAWU ID
 * signs its refresh tokens with the same key and the same JWKS, and marks them
 * with `type: 'refresh'` (its tokens.service.ts: the refresh token's payload is
 * `{ sub, jti, type }`); an access token carries no `type` at all. So a token
 * with a `type` other than 'access' is not a session. 'access' is accepted in
 * case WAWU ID ever names its access tokens. A leaked 30-day refresh token
 * must not be a Hub session that WAWU ID's rotation cannot end.
 */
export function isAccessToken(claims: object): boolean {
  const type = (claims as { type?: unknown }).type;
  return type === undefined || type === 'access';
}

/**
 * Verifies WAWU-ID-issued RS256 access tokens against WAWU ID's JWKS
 * endpoint (conventions.md § Auth model). jwks-rsa caches keys for 24h by
 * default (rateLimit + cache options below make that explicit), matching
 * the proven pattern from the legacy WawuIdAuth Laravel middleware — no
 * per-request network call to WAWU ID.
 *
 * This backend never issues, refreshes, or stores these tokens. It is a
 * pure resource server.
 */
@Injectable()
export class WawuJwtStrategy extends PassportStrategy(Strategy, 'wawu-jwt') {
  constructor(config: ConfigService) {
    const jwksUri = config.get<string>('WAWU_ID_JWKS_URL') ?? 'http://localhost:4001/.well-known/jwks.json';

    // WAWU ID signs for several products (Basket, Beauty, this hub). Without
    // an issuer/audience check ANY valid RS256 token from that JWKS is
    // accepted here, including one minted for a different product entirely.
    // Both are optional so existing environments keep working, but each is
    // enforced when configured.
    const issuer = config.get<string>('WAWU_ID_JWT_ISSUER');
    const audience = config.get<string>('WAWU_ID_JWT_AUDIENCE');

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      algorithms: ['RS256'],
      ...(issuer ? { issuer } : {}),
      ...(audience ? { audience } : {}),
      secretOrKeyProvider: jwksRsa.passportJwtSecret({
        cache: true,
        cacheMaxAge: 24 * 60 * 60 * 1000, // 24h, per conventions.md
        rateLimit: true,
        jwksRequestsPerMinute: 5,
        jwksUri,
      }),
    });
  }

  // Called after signature+expiry verification succeeds. Whatever this
  // returns becomes `req.user`.
  //
  // Only an ACCESS token is a session here (FIX-99, H3): see isAccessToken.
  // Anything else gets the same bare 401 as a bad signature.
  validate(payload: WawuJwtClaims & { type?: unknown }): WawuJwtClaims {
    if (!isAccessToken(payload)) throw new UnauthorizedException();
    return payload;
  }
}
