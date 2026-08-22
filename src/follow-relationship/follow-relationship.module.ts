import { Module } from '@nestjs/common';
import { FollowRelationshipController } from './follow-relationship.controller';
import { FollowRelationshipService } from './follow-relationship.service';
import { NotificationModule } from '../notification/notification.module';
import { BlockedAccountModule } from '../blocked-account/blocked-account.module';

/**
 * registry.json "FollowRelationship" resource module. PrismaService comes
 * from the globally-registered PrismaModule (conventions.md § ORM /
 * database) — not re-imported here.
 */
@Module({
  imports: [NotificationModule, BlockedAccountModule],
  controllers: [FollowRelationshipController],
  providers: [FollowRelationshipService],
})
export class FollowRelationshipModule {}
