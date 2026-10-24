import { Module } from '@nestjs/common';
import { AdminOpsAuditModule } from '../../common/audit/admin-ops-audit.module';
import { MoneyModule } from '../../money/money.module';
import { AdminAuthModule } from '../auth/admin-auth.module';
import { AdminIdentityHoldsController } from './admin-identity-holds.controller';
import { AdminIdentityHoldsListController } from './admin-identity-holds-list.controller';
import { AdminIdentityHoldsService } from './admin-identity-holds.service';
import { AdminOpeningListsService } from './admin-opening-lists.service';
import { AdminWalletOpeningsController } from './admin-wallet-openings.controller';

/**
 * Support letting go of one person's BVN hold (NUV-02 round 3, N3).
 *
 * Imports AdminAuthModule for the guards, AdminOpsAuditModule for the audit
 * row, and MoneyModule for `WalletOpeningService`, which already exports
 * itself: the release is the opening's own marking (the same one the idle
 * sweep makes), not a second path to the table.
 *
 * OPS-26 adds two read-only lists beside the release: the identity holds
 * (`GET admin/identity-holds`) and the stuck wallet openings
 * (`GET admin/wallet-openings/stuck`). They read `FintavaWalletOpening` and
 * change nothing; PrismaService comes from the global PrismaModule.
 */
@Module({
  imports: [AdminAuthModule, AdminOpsAuditModule, MoneyModule],
  controllers: [
    AdminIdentityHoldsController,
    AdminIdentityHoldsListController,
    AdminWalletOpeningsController,
  ],
  providers: [AdminIdentityHoldsService, AdminOpeningListsService],
})
export class AdminIdentityHoldsModule {}
