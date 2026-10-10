import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FintavaModule } from '../fintava/fintava.module';
import { BillsCatalogueController } from './bills-catalogue.controller';
import { BillsCatalogueService } from './bills-catalogue.service';

/**
 * BILLS-01's two routes. Mounted by BillPaymentModule (which AppModule already mounts), so `src/app.module.ts` is
 * untouched. Bills stay on Fintava whichever wallet provider runs (R-45): this module reaches Fintava through its client
 * and never through the wallet provider seam, which Nuvion sits behind.
 */
@Module({
  imports: [ConfigModule, FintavaModule],
  controllers: [BillsCatalogueController],
  providers: [BillsCatalogueService],
  exports: [BillsCatalogueService],
})
export class BillsCatalogueModule {}
