import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import type { Request } from 'express';

/**
 * Interim protection for operator-only endpoints.
 *
 * There is no admin dashboard and no admin role yet, so these routes are held
 * behind a shared key sent as `x-wawu-admin-key`. That is deliberately modest:
 * it is server-to-server only, never given to a browser, and it exists so
 * publishing endpoints can be built and used before the real admin auth lands.
 *
 * Fails closed. If WAWU_ADMIN_KEY is not configured the route is unreachable
 * rather than open, because an unset secret must never mean "let everyone in".
 *
 * Replace with a proper role check when the dashboard has real accounts.
 */
@Injectable()
export class AdminKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.WAWU_ADMIN_KEY;
    if (!expected) {
      throw new UnauthorizedException('Operator access is not configured on this server.');
    }
    const request = context.switchToHttp().getRequest<Request>();
    const provided = request.header('x-wawu-admin-key');
    if (!provided) throw new UnauthorizedException('Operator key required.');

    // Compare in constant time so a wrong key cannot be found byte by byte.
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException('Operator key rejected.');
    }
    return true;
  }
}
