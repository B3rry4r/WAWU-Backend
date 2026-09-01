import { Module } from '@nestjs/common';
import { PaymentLinkService } from './payment-link.service';
import { PaymentLinkController } from './payment-link.controller';

/** Hosted Flutterwave checkout. PrismaService comes from the global module. */
@Module({
  controllers: [PaymentLinkController],
  providers: [PaymentLinkService],
  exports: [PaymentLinkService],
})
export class PaymentLinkModule {}
