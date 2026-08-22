import { Module } from '@nestjs/common';
import { CreditSpendModule } from '../credit-spend/credit-spend.module';
import { CommunityMessageController } from './community-message.controller';
import { CommunityMessageService } from './community-message.service';
import { NotificationModule } from '../notification/notification.module';

/**
 * CommunityMessage resource module. PrismaService comes from the globally
 * registered PrismaModule (not re-imported here). Imports CreditSpendModule
 * to obtain CreditSpendService — CreditSpendModule exports it specifically
 * so this module can write the paid-message ledger row (see
 * credit-spend.module.ts's own doc comment). CreditsStateModule is
 * deliberately NOT imported: it doesn't export CreditsStateService, so this
 * resource reads/writes the CreditsState table directly via PrismaService
 * instead (see community-message.service.ts's doc comment).
 */
@Module({
  imports: [NotificationModule, CreditSpendModule],
  controllers: [CommunityMessageController],
  providers: [CommunityMessageService],
})
export class CommunityMessageModule {}
