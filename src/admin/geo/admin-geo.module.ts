import { Module } from '@nestjs/common';
import { AdminAuthModule } from '../auth/admin-auth.module';
import { GeoModule } from '../../geo/geo.module';
import { AdminGeoController } from './admin-geo.controller';
import { AdminGeoService } from './admin-geo.service';

/** Counts of accounts by country and region (GEO-02). Imported by AdminCreatorsModule, so `src/app.module.ts` (fenced) is untouched. */
@Module({
  imports: [AdminAuthModule, GeoModule],
  controllers: [AdminGeoController],
  providers: [AdminGeoService],
})
export class AdminGeoModule {}
