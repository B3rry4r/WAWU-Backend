import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { WebhookRetentionModule } from '../../webhook-retention/webhook-retention.module';
import { FintavaSignatureGuard } from './fintava-signature.guard';
import { FintavaWebhookController } from './fintava-webhook.controller';
import { FintavaWebhookService } from './fintava-webhook.service';

/**
 * Fintava's webhooks (task MONEY-07): `POST /api/hub/webhooks/fintava`,
 * signature-checked, recorded once in `FintavaWebhookEvent`. It moves no
 * money and calls nothing at Fintava, so it does not need the client
 * (FintavaModule); the consuming tasks (MONEY-08, MONEY-10) read the rows.
 *
 * Needs the app built with `rawBody: true` (src/hub-app-options.ts, used by
 * src/main.ts): the signature covers the exact bytes Fintava sent.
 *
 * FIX-20: imports WebhookRetentionModule, the daily job that clears the body
 * and the parsed copy of old deliveries (it is mounted here and by
 * NuvionWebhookModule, not by AppModule).
 */
@Module({
  imports: [ConfigModule, PrismaModule, WebhookRetentionModule],
  controllers: [FintavaWebhookController],
  providers: [FintavaWebhookService, FintavaSignatureGuard],
})
export class FintavaWebhookModule {}
