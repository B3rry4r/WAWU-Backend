import { Module } from '@nestjs/common';
import { FollowRelationshipController } from './follow-relationship.controller';
import { FollowRelationshipService } from './follow-relationship.service';

/**
 * registry.json "FollowRelationship" resource module. PrismaService comes
 * from the globally-registered PrismaModule (conventions.md § ORM /
 * database) — not re-imported here.
 */
@Module({
  controllers: [FollowRelationshipController],
  providers: [FollowRelationshipService],
})
export class FollowRelationshipModule {}
