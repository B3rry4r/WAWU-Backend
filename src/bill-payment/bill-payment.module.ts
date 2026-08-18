import { Module } from '@nestjs/common';
import { PrismaModule } from '../common/prisma/prisma.module';
import { FlutterwaveCheckoutVerifier } from '../common/flutterwave/checkout-verifier';
import { FlutterwaveBillsClient } from './flutterwave-bills.client';
import { BillPaymentService } from './bill-payment.service';
import { BillPaymentController } from './bill-payment.controller';

@Module({
  imports: [PrismaModule],
  controllers: [BillPaymentController],
  providers: [BillPaymentService, FlutterwaveBillsClient, FlutterwaveCheckoutVerifier],
  exports: [BillPaymentService],
})
export class BillPaymentModule {}
