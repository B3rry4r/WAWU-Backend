import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AdminAuthController } from './admin-auth.controller';
import { AdminAuthService } from './admin-auth.service';
import { AdminTokenService } from './admin-token.service';
import { AdminAuthGuard } from './guards/admin-auth.guard';
import { AdminRolesGuard } from './guards/admin-roles.guard';

/**
 * Admin identity for the WAWU admin dashboard — a separate identity space
 * from the WAWU ID SSO users this backend serves.
 *
 * Imports NOTHING from src/common/auth/. WawuAuthModule is not imported and
 * PassportModule is not touched: an admin never becomes a passport principal,
 * so no existing strategy, guard, or `req.user` consumer can observe one.
 * PrismaService arrives from the global PrismaModule, same as every resource
 * module.
 *
 * Exports the two guards and the token service so later admin resource
 * modules can gate their own routes without re-implementing (or hoisting)
 * either.
 */
@Module({
  imports: [ConfigModule],
  controllers: [AdminAuthController],
  providers: [AdminAuthService, AdminTokenService, AdminAuthGuard, AdminRolesGuard],
  exports: [AdminTokenService, AdminAuthGuard, AdminRolesGuard],
})
export class AdminAuthModule {}
