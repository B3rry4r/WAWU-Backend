import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { NuvionAccountsHandler } from '../handlers/accounts.handler';
import { NuvionBookHandler } from '../handlers/book.handler';
import { NuvionDocumentsHandler } from '../handlers/documents.handler';
import { NuvionHandlerRegistry } from '../handlers/nuvion-handler-registry';
import { NuvionOpeningHandler } from '../handlers/opening.handler';
import { NuvionPayoutsHandler } from '../handlers/payouts.handler';
import { NuvionReconcileHandler } from '../handlers/reconcile.handler';
import { NuvionSignatureGuard } from './nuvion-signature.guard';
import { NuvionWebhookController } from './nuvion-webhook.controller';
import { NuvionWebhookDispatcher } from './nuvion-webhook-dispatcher.service';
import { NuvionWebhookStore } from './nuvion-webhook.service';

/**
 * Nuvion's webhooks (task NUV-01): `POST /api/hub/webhooks/nuvion`,
 * signature-checked, stored once in NuvionWebhookEvent, then handed by
 * NuvionWebhookDispatcher to the handlers of its event
 * (src/nuvion/handlers/, one file per task NUV-02 to NUV-08). AppModule
 * imports it under every WALLET_PROVIDER (mobile repo SHARED-CHANGES
 * NUV-01 #1: app.module.ts is fenced).
 *
 * Needs the app built with `rawBody: true` (src/hub-app-options.ts): the
 * signature covers the exact bytes Nuvion sent. The dispatcher's @Cron runs
 * only where ScheduleModule.forRoot() is loaded (AppModule).
 */
@Module({
  imports: [ConfigModule, PrismaModule],
  controllers: [NuvionWebhookController],
  providers: [
    NuvionSignatureGuard,
    NuvionWebhookStore,
    NuvionWebhookDispatcher,
    NuvionHandlerRegistry,
    NuvionOpeningHandler,
    NuvionDocumentsHandler,
    NuvionAccountsHandler,
    NuvionBookHandler,
    NuvionPayoutsHandler,
    NuvionReconcileHandler,
  ],
  exports: [NuvionWebhookDispatcher, NuvionHandlerRegistry],
})
export class NuvionWebhookModule {}
