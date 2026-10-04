import { Module } from '@nestjs/common';
import { WawuAuthModule } from '../common/auth/wawu-auth.module';
import { BlockedAccountModule } from '../blocked-account/blocked-account.module';
import { ExploreController } from './explore.controller';
import { ExploreService } from './explore.service';

@Module({
  imports: [WawuAuthModule, BlockedAccountModule],
  controllers: [ExploreController],
  providers: [ExploreService],
})
export class ExploreModule {}
