import { Module } from '@nestjs/common';
import { WawuAuthModule } from '../common/auth/wawu-auth.module';
import { BlockedAccountModule } from '../blocked-account/blocked-account.module';
import { StorageModule } from '../storage/storage.module';
import { ExploreController } from './explore.controller';
import { ExploreService } from './explore.service';

@Module({
  imports: [WawuAuthModule, BlockedAccountModule, StorageModule],
  controllers: [ExploreController],
  providers: [ExploreService],
})
export class ExploreModule {}
