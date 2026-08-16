import { Module } from '@nestjs/common';
import { CreditSpendService } from './credit-spend.service';

/**
 * No controller: registry.json's CreditSpend contract has an empty
 * `endpoints` array (it's an internal ledger, not a routed resource — see
 * credit-spend.service.ts doc comment). This module exists purely to
 * export CreditSpendService for the CommunityMessage module (a separate
 * wave-0 resource) to inject once app.module.ts is wired centrally.
 */
@Module({
  providers: [CreditSpendService],
  exports: [CreditSpendService],
})
export class CreditSpendModule {}
