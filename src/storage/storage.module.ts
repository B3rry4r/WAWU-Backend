import { Module } from '@nestjs/common';
import { StorageService } from './storage.service';
import { StorageController } from './storage.controller';
import { StorageSweepService } from './storage-sweep.service';

@Module({
  controllers: [StorageController],
  providers: [StorageService, StorageSweepService],
  exports: [StorageService],
})
export class StorageModule {}
