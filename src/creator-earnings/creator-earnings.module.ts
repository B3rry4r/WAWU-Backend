import { Module } from '@nestjs/common';
import { CreatorEarningsController } from './creator-earnings.controller';
import { CreatorEarningsService } from './creator-earnings.service';
import { CreatorAccountGuard } from './guards/creator-account-guard';

/**
 * registry.json "CreatorEarnings" resource module. PrismaService comes from
 * the globally-registered PrismaModule (conventions.md § ORM / database) —
 * not re-imported here. No Flutterwave client: this resource only reads,
 * it never charges anything.
 */
@Module({
  controllers: [CreatorEarningsController],
  providers: [CreatorEarningsService, CreatorAccountGuard],
  // Exported for src/admin/creators/, which reads a creator's earnings for the
  // support lookup screen. An export is the whole change: no route, response
  // shape, guard or line of this service moved. The alternative was a second
  // earnings calculation in the admin tree, and two definitions of one number
  // is how a support agent and a creator end up looking at different money on
  // the same call.
  exports: [CreatorEarningsService],
})
export class CreatorEarningsModule {}
