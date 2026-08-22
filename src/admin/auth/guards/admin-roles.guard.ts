import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { AdminRole } from '../../../../generated/prisma/enums';
import { ADMIN_ROLES_KEY } from '../decorators/admin-roles.decorator';
import type { AdminUserView } from '../admin-user-view.type';

/**
 * Role gate for admin handlers. Runs AFTER AdminAuthGuard, which is what puts
 * the verified admin on `req.admin`; on its own this guard authenticates
 * nothing and fails closed if the request was never authenticated.
 *
 * A handler with no `@AdminRoles(...)` is open to every ACTIVE admin — the
 * authentication decision has already been made by AdminAuthGuard. `superadmin`
 * is NOT implicitly allowed everywhere: a handler that superadmin should reach
 * must say so, so the matrix is readable at each handler rather than implied
 * here.
 *
 * Local to this resource directory, per the same convention as
 * ../guards/admin-auth.guard.ts.
 */
@Injectable()
export class AdminRolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<AdminRole[] | undefined>(ADMIN_ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<Request & { admin?: AdminUserView }>();
    const admin = request.admin;

    if (!admin || !required.includes(admin.role)) {
      throw new ForbiddenException('This action is not available to your admin role.');
    }
    return true;
  }
}
