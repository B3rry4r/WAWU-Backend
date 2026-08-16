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
})
export class CreatorEarningsModule {}
