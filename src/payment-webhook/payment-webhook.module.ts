import { Module } from '@nestjs/common';
import { PrismaModule } from '../common/prisma/prisma.module';
import { PurchaseModule } from '../purchase/purchase.module';
import { ContentPieceModule } from '../content-piece/content-piece.module';
import { CreditPurchaseModule } from '../credit-purchase/credit-purchase.module';
import { DirectMessageModule } from '../direct-message/direct-message.module';
import { ServiceApplicationModule } from '../service-application/service-application.module';
import { BillPaymentModule } from '../bill-payment/bill-payment.module';
import { HealthPlanModule } from '../health-plan/health-plan.module';
import { ShopModule } from '../shop/shop.module';
import { EventTicketingModule } from '../event-ticketing/event-ticketing.module';
import { LegalModule } from '../legal/legal.module';
import { WaitlistCoreModule } from '../waitlist/waitlist-core.module';
import { PaymentWebhookController } from './payment-webhook.controller';
import { PaymentWebhookService } from './payment-webhook.service';
import { FlutterwaveSignatureGuard } from './guards/flutterwave-signature.guard';
import { WalletModule } from '../wallet/wallet.module';

/**
 * Inbound Flutterwave webhooks — the half of payment confirmation that does
 * not depend on the customer's browser staying open.
 *
 * It imports every money module rather than reimplementing any of them: the
 * webhook resolves a tx_ref to its owning flow and then calls that flow's own
 * `/verify` service method. Each of those modules now exports its service for
 * exactly this reason; no route, controller or response shape changed.
 *
 * Registered LAST in app.module.ts. Every module below is already registered
 * earlier there, so Nest dedupes them and the load-bearing controller order
 * (MentorModule / ServiceApplicationModule before PartnerServiceModule's
 * `@Get(':id')` catch-all) is untouched.
 */
@Module({
  imports: [
    WalletModule,
    PrismaModule,
    PurchaseModule,
    ContentPieceModule,
    CreditPurchaseModule,
    DirectMessageModule,
    ServiceApplicationModule,
    BillPaymentModule,
    HealthPlanModule,
    LegalModule,
    ShopModule,
    EventTicketingModule,
    WaitlistCoreModule,
  ],
  controllers: [PaymentWebhookController],
  providers: [PaymentWebhookService, FlutterwaveSignatureGuard],
  exports: [PaymentWebhookService],
})
export class PaymentWebhookModule {}
