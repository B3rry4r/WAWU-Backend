import { Module } from '@nestjs/common';
import { AdminAuthModule } from '../auth/admin-auth.module';
import { AdminFeaturedCreatorsController } from './admin-featured-creators.controller';

@Module({
  imports: [AdminAuthModule],
  controllers: [AdminFeaturedCreatorsController],
})
export class AdminFeaturedCreatorsModule {}
