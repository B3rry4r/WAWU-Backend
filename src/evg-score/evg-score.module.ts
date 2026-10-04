import { Module } from '@nestjs/common';
import { BlockedAccountModule } from '../blocked-account/blocked-account.module';
import { EvgScoreController } from './evg-score.controller';
import { EvgScoreService } from './evg-score.service';

@Module({
  imports: [BlockedAccountModule],
  controllers: [EvgScoreController],
  providers: [EvgScoreService],
})
export class EvgScoreModule {}
