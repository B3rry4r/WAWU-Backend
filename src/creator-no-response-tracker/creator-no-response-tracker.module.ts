import { Module } from '@nestjs/common';
import { CreatorNoResponseTrackerController } from './creator-no-response-tracker.controller';
import { CreatorNoResponseTrackerService } from './creator-no-response-tracker.service';
import { CreatorAccountGuard } from './guards/creator-account-guard';

@Module({
  controllers: [CreatorNoResponseTrackerController],
  providers: [CreatorNoResponseTrackerService, CreatorAccountGuard],
})
export class CreatorNoResponseTrackerModule {}
