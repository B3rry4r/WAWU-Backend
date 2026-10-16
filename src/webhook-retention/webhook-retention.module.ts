import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../common/prisma/prisma.module';
import { WebhookRetentionService } from './webhook-retention.service';

/**
 * The daily job that clears old provider delivery bodies (task FIX-20).
 *
 * Not imported by AppModule (a fenced file): both webhook modules import it,
 * FintavaWebhookModule and NuvionWebhookModule, which AppModule mounts under
 * every WALLET_PROVIDER. Nest builds a module once, so there is one service
 * and one cron job whichever of the two loads first. The job's @Cron runs only
 * where ScheduleModule.forRoot() is loaded (AppModule).
 */
@Module({
  imports: [ConfigModule, PrismaModule],
  providers: [WebhookRetentionService],
  exports: [WebhookRetentionService],
})
export class WebhookRetentionModule {}
