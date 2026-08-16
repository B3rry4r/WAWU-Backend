import { Module } from '@nestjs/common';
import { CourseLessonService } from './course-lesson.service';

/**
 * No controller: this resource's frozen contract (registry.json) declares
 * `"endpoints": []` — CourseLesson is only ever read as data embedded in a
 * `course`-type ContentPiece response (content-detail screen), never fetched
 * at its own route. `CourseLessonService` is exported so the ContentPiece
 * module can inject it when assembling that response.
 */
@Module({
  providers: [CourseLessonService],
  exports: [CourseLessonService],
})
export class CourseLessonModule {}
