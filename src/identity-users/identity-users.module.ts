import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WawuIdUsersClient } from './wawu-id-users.client';

/** WAWU ID's people read (R-142, R-143). Imported by the modules that need it; `src/common/**` is untouched. */
@Module({
  imports: [ConfigModule],
  providers: [WawuIdUsersClient],
  exports: [WawuIdUsersClient],
})
export class IdentityUsersModule {}
