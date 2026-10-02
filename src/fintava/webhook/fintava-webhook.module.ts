import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../common/prisma/prisma.module';
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
 */
@Module({
  imports: [ConfigModule, PrismaModule],
  controllers: [FintavaWebhookController],
  providers: [FintavaWebhookService, FintavaSignatureGuard],
})
export class FintavaWebhookModule {}
