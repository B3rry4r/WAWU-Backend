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
 * ── NO LONGER USED BY ANY ROUTE ──────────────────────────────────────────
 * As of feat/ops-admin-auth every controller that referenced this guard —
 * legal/ops, services/ops/applications, bills/ops, care/ops, PATCH
 * /learn/playbook and the LearnGuide writes — sits behind AdminAuthGuard +
 * AdminRolesGuard instead, so an operator action is attributable to a named
 * admin with a role. `WAWU_ADMIN_KEY` grants access to nothing.
 *
 * The file is KEPT rather than deleted for two reasons, neither of them
 * "someone might want it back": another in-flight branch may still reference
 * the symbol, and WAWUAfrica-Dashboard's `scripts/generate-ops-contract.mjs`
 * parses THIS FILE to emit its `OPS_KEY_HEADER` constant, so deleting it
 * fails that repo's `npm run check` at parse time rather than at runtime.
 * It is dead code, not a fallback — nothing wires it into a route, and
 * re-adding it to one would reopen the hole this change closed.
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
