import { Module } from '@nestjs/common';
import { AdminAuthModule } from '../admin/auth/admin-auth.module';
import { GeoModule } from '../geo/geo.module';
import { IdentityUsersModule } from '../identity-users/identity-users.module';
import { GeoFillController } from './geo-fill.controller';
import { GeoFillService } from './geo-fill.service';

/** The country fill for existing accounts (R-143): the superadmin route and the by-itself runs. Added once in `app.module.ts`. */
@Module({
  imports: [AdminAuthModule, GeoModule, IdentityUsersModule],
  controllers: [GeoFillController],
  providers: [GeoFillService],
})
export class GeoFillModule {}
