import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AdminRole } from '../../../generated/prisma/enums';
import { AdminAuthService, type AdminSession } from './admin-auth.service';
import { AdminLoginDto } from './dto/admin-login.dto';
import { AdminRefreshDto } from './dto/admin-refresh.dto';
import { AdminAuthGuard } from './guards/admin-auth.guard';
import { AdminRolesGuard } from './guards/admin-roles.guard';
import { AdminRoles } from './decorators/admin-roles.decorator';
import { CurrentAdmin } from './decorators/current-admin.decorator';
import type { AdminUserView } from './admin-user-view.type';

/**
 * The admin dashboard's own front door. Mounted at `/admin/auth` under the
 * app's global prefix, i.e. `/api/hub/admin/auth/*` in a running server.
 *
 * No route here shares a path segment with any existing controller: nothing
 * else in this backend declares an `admin` prefix, and the only catch-all in
 * the app is PartnerServiceController's `@Controller('services')` +
 * `@Get(':id')`, which can only ever swallow `/services/*`.
 *
 * Login and refresh are `@HttpCode(200)`: they create no resource, and the
 * ResponseInterceptor stamps `statusCode: 200` into the body regardless — a
 * 201 here would ship the same status mismatch the protected registry records
 * as hazard H-3 on the app surface, into a brand-new surface that has no
 * reason to inherit it.
 */
@Controller('admin/auth')
export class AdminAuthController {
  constructor(private readonly service: AdminAuthService) {}

  /**
   * Tightened past the global 20/s + 200/min (app.module.ts): a password
   * endpoint is the one place in this backend where an attacker gets
   * unlimited free guesses, and 5/min is generous for a human typing.
   */
  @Throttle({ short: { limit: 5, ttl: 60_000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: AdminLoginDto): Promise<AdminSession> {
    return this.service.login(dto);
  }

  @Throttle({ short: { limit: 20, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Body() dto: AdminRefreshDto): Promise<AdminSession> {
    return this.service.refresh(dto);
  }

  /** Who the dashboard is signed in as. Any active admin, any role. */
  @UseGuards(AdminAuthGuard)
  @Get('me')
  me(@CurrentAdmin() admin: AdminUserView): AdminUserView {
    return admin;
  }

  /**
   * The admin roster. Superadmin only — the one live enforcement point for
   * AdminRolesGuard, so the role matrix is exercised by a real route rather
   * than existing only in a test.
   */
  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @AdminRoles(AdminRole.superadmin)
  @Get('admins')
  listAdmins(): Promise<AdminUserView[]> {
    return this.service.listAdmins();
  }
}
