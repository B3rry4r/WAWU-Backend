import { Module } from '@nestjs/common';
import { MentorRequestController } from './mentor-request.controller';
import { MentorRequestService } from './mentor-request.service';

@Module({
  controllers: [MentorRequestController],
  providers: [MentorRequestService],
})
export class MentorRequestModule {}
