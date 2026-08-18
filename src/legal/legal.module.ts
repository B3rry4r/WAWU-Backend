import { Module } from '@nestjs/common';
import { PrismaModule } from '../common/prisma/prisma.module';
import { FlutterwaveCheckoutVerifier } from '../common/flutterwave/checkout-verifier';
import { LegalRequestsService } from './legal.service';
import { LegalController } from './legal.controller';

@Module({
  imports: [PrismaModule],
  controllers: [LegalController],
  providers: [LegalRequestsService, FlutterwaveCheckoutVerifier],
  exports: [LegalRequestsService],
})
export class LegalModule {}
