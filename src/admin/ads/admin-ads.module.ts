import { Module } from '@nestjs/common';
import { AdminAuthModule } from '../auth/admin-auth.module';
import { AdminAdsController } from './admin-ads.controller';
import { AdminAdsService } from './admin-ads.service';

/**
 * Admin ad management (task ADS-06). Imports exactly one thing: AdminAuthModule,
 * for the guards. PrismaService arrives from the global PrismaModule. Does not
 * import the serving module (ADS-04): the two halves share the tables and the
 * rule written in ad-campaign-state.ts, not a code path.
 */
@Module({
  imports: [AdminAuthModule],
  controllers: [AdminAdsController],
  providers: [AdminAdsService],
})
export class AdminAdsModule {}
