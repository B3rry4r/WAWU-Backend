import { Module } from '@nestjs/common';
import { CommunityController } from './community.controller';
import { CommunityService } from './community.service';
import { CreatorAccountGuard } from './guards/creator-account-guard';
import { CommunityRoomsController } from './rooms/community-rooms.controller';
import { CommunityRoomsService } from './rooms/community-rooms.service';
import { NotificationModule } from '../notification/notification.module';
import { CommunityMessageModule } from '../community-message/community-message.module';

/**
 * Community resource module. PrismaService comes from the globally-registered
 * PrismaModule (conventions.md § ORM / database) — not re-imported here.
 *
 * CreatorAccountGuard is this resource's own local copy (one per resource
 * dir — the established pattern, see src/content-piece/guards/), registered
 * as a provider exactly as ContentPieceModule registers its own.
 *
 * INBOX-01: CommunityRoomsController comes FIRST so its fixed paths
 * (GET /communities/mine, GET /communities/links/:slug) are matched before
 * CommunityController's GET /communities/:id. NotificationModule supplies the
 * join-decision notifications; CommunityMessageModule supplies the sender
 * lookup for each room's last message.
 */
@Module({
  imports: [NotificationModule, CommunityMessageModule],
  controllers: [CommunityRoomsController, CommunityController],
  providers: [CommunityService, CommunityRoomsService, CreatorAccountGuard],
})
export class CommunityModule {}
