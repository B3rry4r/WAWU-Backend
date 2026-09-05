import { Module } from '@nestjs/common';
import { PrismaModule } from '../common/prisma/prisma.module';
import { AdminAuthModule } from '../admin/auth/admin-auth.module';
import { AdminOpsAuditModule } from '../common/audit/admin-ops-audit.module';
import { FlutterwaveCheckoutVerifier } from '../common/flutterwave/checkout-verifier';
import { FlutterwaveBillsClient } from './flutterwave-bills.client';
import { FlutterwaveBillsMock } from './flutterwave-bills.mock';
import { shouldUseMockFlutterwave } from '../common/flutterwave/require-payment-config';
import { BillPaymentService } from './bill-payment.service';
import { BillPaymentController } from './bill-payment.controller';
import { BillPaymentOpsController } from './bill-payment-ops.controller';

/**
 * AdminAuthModule is imported for its two exported GUARDS only.
 * BillPaymentOpsController moved off
 * AdminKeyGuard (one shared static secret, no identity, no roles) onto
 * AdminAuthGuard + AdminRolesGuard. Imported here rather than wired in
 * app.module.ts so the documented, load-bearing route-registration order in
 * that file is untouched — Nest dedupes the already-registered module.
 */
@Module({
  imports: [PrismaModule, AdminAuthModule, AdminOpsAuditModule],
  controllers: [BillPaymentController, BillPaymentOpsController],
  providers: [
    BillPaymentService,
    // Same adapter choice every other money module makes. Without this, a
    // developer with no Flutterwave key could not open the bills screen at
    // all: the client threw on its very first call. See the mock's own header
    // for which of its rows are production captures and which are stand-ins.
    {
      provide: FlutterwaveBillsClient,
      useClass: shouldUseMockFlutterwave() ? FlutterwaveBillsMock : FlutterwaveBillsClient,
    },
    FlutterwaveCheckoutVerifier,
  ],
  exports: [BillPaymentService],
})
export class BillPaymentModule {}
