import { Module } from '@nestjs/common';
import { UserProfileController } from './user-profile.controller';
import { UserProfileService } from './user-profile.service';

/**
 * registry.json "UserProfile" resource module. PrismaService comes from the
 * globally-registered PrismaModule (conventions.md § ORM / database) — not
 * re-imported here.
 */
@Module({
  controllers: [UserProfileController],
  providers: [UserProfileService],
})
export class UserProfileModule {}
