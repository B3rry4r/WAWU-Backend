import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import * as jwksRsa from 'jwks-rsa';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';

/**
 * Checks a WAWU ID access token for the live socket. The same rules as the
 * `wawu-jwt` strategy every REST route uses (RS256, WAWU ID's JWKS, the issuer
 * and audience when configured, expiry enforced), because a socket is signed
 * in exactly as a request is. A socket cannot go through the passport guard
 * (it is not a request), so the check is made here with the same settings.
 */
@Injectable()
export class LiveTokenVerifier {
  private readonly keys: jwksRsa.JwksClient;
  private readonly issuer: string | undefined;
  private readonly audience: string | undefined;

  constructor(config: ConfigService) {
    this.keys = new jwksRsa.JwksClient({
      cache: true,
      cacheMaxAge: 24 * 60 * 60 * 1000,
      rateLimit: true,
      jwksRequestsPerMinute: 5,
      jwksUri:
        config.get<string>('WAWU_ID_JWKS_URL') ??
        'http://localhost:4001/.well-known/jwks.json',
    });
    this.issuer = config.get<string>('WAWU_ID_JWT_ISSUER');
    this.audience = config.get<string>('WAWU_ID_JWT_AUDIENCE');
  }

  /** The token's claims, or a rejection when it is not valid. */
  verify(token: string): Promise<WawuJwtClaims> {
    return new Promise((resolve, reject) => {
      jwt.verify(
        token,
        (header, done) => {
          if (!header.kid) {
            done(new Error('token has no key id'));
            return;
          }
          this.keys
            .getSigningKey(header.kid)
            .then((key) => done(null, key.getPublicKey()))
            .catch((e: unknown) =>
              done(e instanceof Error ? e : new Error(String(e))),
            );
        },
        {
          algorithms: ['RS256'],
          ...(this.issuer ? { issuer: this.issuer } : {}),
          ...(this.audience ? { audience: this.audience } : {}),
        },
        (err, payload) => {
          if (err || typeof payload !== 'object' || !payload) {
            reject(err ?? new Error('token has no claims'));
            return;
          }
          const claims = payload as unknown as WawuJwtClaims;
          if (typeof claims.sub !== 'string' || claims.sub.length === 0) {
            reject(new Error('token has no subject'));
            return;
          }
          if (typeof claims.exp !== 'number') {
            reject(new Error('token has no expiry'));
            return;
          }
          resolve(claims);
        },
      );
    });
  }
}
