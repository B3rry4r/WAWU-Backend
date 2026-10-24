import { Module } from '@nestjs/common';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { AdminAuthModule } from '../auth/admin-auth.module';
import { AdminFeaturedCreatorsController } from './admin-featured-creators.controller';

@Module({
  imports: [AdminAuthModule, WawuAuthModule],
  controllers: [AdminFeaturedCreatorsController],
})
export class AdminFeaturedCreatorsModule {}
