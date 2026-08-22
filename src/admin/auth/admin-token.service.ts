import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import type { AdminJwtClaims, AdminTokenType } from './admin-jwt-claims.interface';
// Prisma 7 exports model types with a `Model` suffix; aliased so this file
// reads as the entity it is about (same barrel every src/common/types/*.type.ts uses).
import type { AdminUserModel as AdminUser } from '../../../generated/prisma/models';

/**
 * Admin token minting and verification.
 *
 * ── WHY THIS IS SEPARATE FROM USER AUTH, STRUCTURALLY ────────────────────
 * User tokens on this backend are RS256, verified against WAWU ID's JWKS
 * with `algorithms: ['RS256']` pinned (src/common/auth/wawu-jwt.strategy.ts).
 * The Hub enforces NEITHER `iss` NOR `aud` on them — both checks are
 * optional and unconfigured, and WAWU ID never emits an `aud` claim at all
 * (.pipeline/protected-registry.json § auth.sso). That is a protected-surface
 * defect this module must not attempt to repair, and it means a claim-based
 * separation would be worth nothing: the Hub does not read the claims that
 * would carry it, and WAWU ID signs refresh tokens with the same key as
 * access tokens.
 *
 * So the separation here is CRYPTOGRAPHIC, not declarative. Admin tokens are
 * HS256 signed with a local secret this backend owns; user tokens are RS256
 * signed by a private key this backend has never held. Neither verifier can
 * be satisfied by the other's token no matter what claims it carries:
 *
 *   admin token -> WawuJwtStrategy : rejected on `algorithms: ['RS256']`
 *                                    before a key is ever fetched.
 *   user token  -> AdminAuthGuard  : rejected on `algorithms: ['HS256']`
 *                                    below, and would fail the HMAC anyway.
 *
 * `iss`/`aud` are also set and enforced, but as defence in depth. The
 * algorithm-plus-key split is the part that holds if every claim is ignored.
 *
 * Access and refresh tokens use SEPARATE secrets for the same reason: the
 * registry records that a WAWU ID refresh token currently satisfies every
 * Hub user guard because only the signature and expiry are checked. Two
 * secrets make that class of confusion impossible here rather than merely
 * unlikely — an admin refresh token cannot verify against the access secret.
 */

/** Stamped as `iss` on every admin token and required on every verify. */
export const ADMIN_TOKEN_ISSUER = 'wawu-hub-admin';
/** Stamped as `aud` on admin ACCESS tokens. */
export const ADMIN_ACCESS_AUDIENCE = 'wawu-admin-dashboard';
/** Stamped as `aud` on admin REFRESH tokens. */
export const ADMIN_REFRESH_AUDIENCE = 'wawu-admin-dashboard-refresh';

const ADMIN_TOKEN_ALGORITHM: jwt.Algorithm = 'HS256';
const DEFAULT_ACCESS_TTL = '30m';
const DEFAULT_REFRESH_TTL = '7d';
/** Short enough to type, long enough that a leaked value is not brute-forceable. */
const MIN_SECRET_LENGTH = 32;

export interface AdminTokenPair {
  accessToken: string;
  refreshToken: string;
  /** Seconds until `accessToken` expires — what the dashboard schedules its refresh off. */
  expiresIn: number;
}

@Injectable()
export class AdminTokenService {
  private readonly logger = new Logger(AdminTokenService.name);

  constructor(private readonly config: ConfigService) {}

  issuePair(admin: Pick<AdminUser, 'id' | 'email' | 'role' | 'tokenVersion'>): AdminTokenPair {
    const accessToken = this.sign(admin, 'admin_access');
    const refreshToken = this.sign(admin, 'admin_refresh');
    return { accessToken, refreshToken, expiresIn: this.accessTtlSeconds() };
  }

  verifyAccessToken(token: string): AdminJwtClaims {
    return this.verify(token, 'admin_access');
  }

  verifyRefreshToken(token: string): AdminJwtClaims {
    return this.verify(token, 'admin_refresh');
  }

  private sign(
    admin: Pick<AdminUser, 'id' | 'email' | 'role' | 'tokenVersion'>,
    typ: AdminTokenType,
  ): string {
    return jwt.sign(
      { email: admin.email, role: admin.role, tokenVersion: admin.tokenVersion, typ },
      this.secretFor(typ),
      {
        algorithm: ADMIN_TOKEN_ALGORITHM,
        subject: admin.id,
        issuer: ADMIN_TOKEN_ISSUER,
        audience: this.audienceFor(typ),
        expiresIn: this.ttlFor(typ),
      } as jwt.SignOptions,
    );
  }

  private verify(token: string, typ: AdminTokenType): AdminJwtClaims {
    let claims: AdminJwtClaims;
    try {
      claims = jwt.verify(token, this.secretFor(typ), {
        // Pinned. Without this, a token with `"alg": "none"` or an RS256
        // token whose public key happened to be guessable would be handed
        // to the wrong verifier.
        algorithms: [ADMIN_TOKEN_ALGORITHM],
        issuer: ADMIN_TOKEN_ISSUER,
        audience: this.audienceFor(typ),
      }) as AdminJwtClaims;
    } catch {
      // Deliberately opaque: expired, wrong signature, wrong issuer and
      // "that is a user token" are all one answer to the caller.
      throw new UnauthorizedException('Admin session is invalid or has expired.');
    }

    // The audience already separates the two token types, but `typ` is
    // asserted too so a future change to the audience strings cannot
    // silently make a refresh token usable as an access token.
    if (claims.typ !== typ) {
      throw new UnauthorizedException('Admin session is invalid or has expired.');
    }
    return claims;
  }

  /**
   * Fails CLOSED, matching src/common/guards/admin-key.guard.ts: an unset
   * secret makes the admin surface unreachable rather than open.
   */
  private secretFor(typ: AdminTokenType): string {
    const name = typ === 'admin_access' ? 'ADMIN_JWT_SECRET' : 'ADMIN_JWT_REFRESH_SECRET';
    const secret = this.config.get<string>(name);
    if (!secret || secret.length < MIN_SECRET_LENGTH) {
      this.logger.error(
        `${name} is unset or shorter than ${MIN_SECRET_LENGTH} characters — the admin surface is unreachable until it is configured.`,
      );
      throw new UnauthorizedException('Admin access is not configured on this server.');
    }
    return secret;
  }

  private audienceFor(typ: AdminTokenType): string {
    return typ === 'admin_access' ? ADMIN_ACCESS_AUDIENCE : ADMIN_REFRESH_AUDIENCE;
  }

  private ttlFor(typ: AdminTokenType): string {
    return typ === 'admin_access'
      ? (this.config.get<string>('ADMIN_JWT_ACCESS_TTL') ?? DEFAULT_ACCESS_TTL)
      : (this.config.get<string>('ADMIN_JWT_REFRESH_TTL') ?? DEFAULT_REFRESH_TTL);
  }

  /** `expiresIn` for the wire — derived from the same TTL string used to sign. */
  private accessTtlSeconds(): number {
    const ttl = this.ttlFor('admin_access');
    const match = /^(\d+)([smhd])?$/.exec(ttl.trim());
    if (!match) return 30 * 60;
    const value = Number(match[1]);
    const multiplier = { s: 1, m: 60, h: 3600, d: 86400 }[match[2] ?? 's'] ?? 1;
    return value * multiplier;
  }
}
