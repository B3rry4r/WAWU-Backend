import { Module } from '@nestjs/common';
import { AdminOpsAuditModule } from '../../common/audit/admin-ops-audit.module';
import { MoneyModule } from '../../money/money.module';
import { AdminAuthModule } from '../auth/admin-auth.module';
import { AdminIdentityHoldsController } from './admin-identity-holds.controller';
import { AdminIdentityHoldsService } from './admin-identity-holds.service';

/**
 * Support letting go of one person's BVN hold (NUV-02 round 3, N3).
 *
 * Imports AdminAuthModule for the guards, AdminOpsAuditModule for the audit
 * row, and MoneyModule for `WalletOpeningService`, which already exports
 * itself: the release is the opening's own marking (the same one the idle
 * sweep makes), not a second path to the table.
 */
@Module({
  imports: [AdminAuthModule, AdminOpsAuditModule, MoneyModule],
  controllers: [AdminIdentityHoldsController],
  providers: [AdminIdentityHoldsService],
})
export class AdminIdentityHoldsModule {}
