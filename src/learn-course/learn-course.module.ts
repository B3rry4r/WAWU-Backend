import { Module } from '@nestjs/common';
import { LearnCourseController } from './learn-course.controller';
import { LearnCourseService } from './learn-course.service';

@Module({
  controllers: [LearnCourseController],
  providers: [LearnCourseService],
})
export class LearnCourseModule {}
