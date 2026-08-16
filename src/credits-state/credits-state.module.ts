import { Module } from '@nestjs/common';
import { CreditsStateController } from './credits-state.controller';
import { CreditsStateService } from './credits-state.service';

@Module({
  controllers: [CreditsStateController],
  providers: [CreditsStateService],
})
export class CreditsStateModule {}
