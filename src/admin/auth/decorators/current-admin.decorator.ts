import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { Request } from 'express';
import type { AdminUserView } from '../admin-user-view.type';

/**
 * `@CurrentAdmin()` — the admin-side counterpart of `@CurrentUser()`
 * (src/common/decorators/current-user.decorator.ts), reading a DIFFERENT
 * request property.
 *
 * `req.user` belongs to the SSO flow and is written only by the wawu-jwt
 * passport strategy. AdminAuthGuard writes `req.admin` and never touches
 * `req.user`, so an admin request is structurally invisible to every
 * existing `@CurrentUser()` call site rather than merely failing its checks.
 */
export const CurrentAdmin = createParamDecorator((_data: unknown, ctx: ExecutionContext): AdminUserView => {
  const request = ctx.switchToHttp().getRequest<Request & { admin: AdminUserView }>();
  return request.admin;
});
