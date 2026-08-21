import { Module } from '@nestjs/common';
import { CommunityController } from './community.controller';
import { CommunityService } from './community.service';
import { CreatorAccountGuard } from './guards/creator-account-guard';

/**
 * Community resource module. PrismaService comes from the globally-registered
 * PrismaModule (conventions.md § ORM / database) — not re-imported here.
 *
 * CreatorAccountGuard is this resource's own local copy (one per resource
 * dir — the established pattern, see src/content-piece/guards/), registered
 * as a provider exactly as ContentPieceModule registers its own.
 */
@Module({
  controllers: [CommunityController],
  providers: [CommunityService, CreatorAccountGuard],
})
export class CommunityModule {}
