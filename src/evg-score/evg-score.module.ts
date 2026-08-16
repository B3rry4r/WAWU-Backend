import { Module } from '@nestjs/common';
import { EvgScoreController } from './evg-score.controller';
import { EvgScoreService } from './evg-score.service';

@Module({
  controllers: [EvgScoreController],
  providers: [EvgScoreService],
})
export class EvgScoreModule {}
