import { Module } from '@nestjs/common';
import { LearnGuideController } from './learn-guide.controller';
import { LearnGuideService } from './learn-guide.service';

/**
 * PrismaModule is @Global() (conventions.md § ORM / database) so it is not
 * re-imported here; LearnGuideService injects PrismaService directly.
 */
@Module({
  controllers: [LearnGuideController],
  providers: [LearnGuideService],
})
export class LearnGuideModule {}
