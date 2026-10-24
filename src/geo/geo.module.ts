import { Module } from '@nestjs/common';
import { GeoController } from './geo.controller';
import { GeoService } from './geo.service';
import { ProfileLocationService } from './profile-location.service';

/**
 * Countries, regions and a person's place (GEO-02, R-85). Mounted by being
 * imported where it is used (UserProfileModule, MeModule, the admin modules),
 * so `src/app.module.ts` (fenced) is not touched.
 */
@Module({
  controllers: [GeoController],
  providers: [GeoService, ProfileLocationService],
  exports: [GeoService, ProfileLocationService],
})
export class GeoModule {}
