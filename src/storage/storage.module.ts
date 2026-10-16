import { Module } from '@nestjs/common';
import { PlansModule } from '../plans/plans.module';
import { StorageService } from './storage.service';
import { StorageController } from './storage.controller';
import { StorageSweepService } from './storage-sweep.service';

/**
 * PlansModule gives the presign its publishing gate and the allowance
 * (TIER-02): a file for a product needs a tier.
 */
@Module({
  imports: [PlansModule],
  controllers: [StorageController],
  providers: [StorageService, StorageSweepService],
  exports: [StorageService],
})
export class StorageModule {}
