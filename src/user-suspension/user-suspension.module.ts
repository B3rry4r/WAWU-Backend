import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { WawuAuthModule } from '../common/auth/wawu-auth.module';
import { AdminOpsAuditModule } from '../common/audit/admin-ops-audit.module';
import { SuspensionWriteInterceptor } from '../common/suspension/suspension-write.interceptor';
import { AdminAuthModule } from '../admin/auth/admin-auth.module';
import { AdminUserSuspensionController } from './admin-user-suspension.controller';
import { MeSuspensionController } from './me-suspension.controller';
import { UserSuspensionService } from './user-suspension.service';

/**
 * USER-SUSPEND (R-121): a moderator suspends a person and lifts it; the person reads their own state. What a
 * suspension does (hides them, refuses their writes) is in `src/common/suspension` and `BlockedAccountService`.
 */
@Module({
  imports: [WawuAuthModule, AdminAuthModule, AdminOpsAuditModule],
  controllers: [AdminUserSuspensionController, MeSuspensionController],
  providers: [
    UserSuspensionService,
    // The write guard: a global interceptor (it runs after the route's own auth guard has put the person on the request).
    // Registered here, not in AppModule's providers, which a spec pins to the throttler pair. Nothing changes for anyone else.
    { provide: APP_INTERCEPTOR, useClass: SuspensionWriteInterceptor },
  ],
  exports: [UserSuspensionService],
})
export class UserSuspensionModule {}
