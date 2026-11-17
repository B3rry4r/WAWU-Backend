import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AdminAuthModule } from '../auth/admin-auth.module';
import { GeoModule } from '../../geo/geo.module';
import { IdentityUsersModule } from '../../identity-users/identity-users.module';
import { AdminUsersController } from './admin-users.controller';
import { AdminUsersService } from './admin-users.service';

/** The dashboard's Users page (R-142). Added once in `app.module.ts`. */
@Module({
  imports: [AdminAuthModule, GeoModule, IdentityUsersModule, ConfigModule],
  controllers: [AdminUsersController],
  providers: [AdminUsersService],
})
export class AdminUsersModule {}
