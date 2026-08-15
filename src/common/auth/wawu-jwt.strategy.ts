import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import * as jwksRsa from 'jwks-rsa';
import type { WawuJwtClaims } from './wawu-jwt-claims.interface';

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

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      algorithms: ['RS256'],
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
  validate(payload: WawuJwtClaims): WawuJwtClaims {
    return payload;
  }
}
