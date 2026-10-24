import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { CreatorAccountGuard } from '../common/guards/creator-account.guard';
import { StorageBusyInterceptor } from '../storage/storage-busy.interceptor';
import {
  CourseLessonsService,
  type LessonPlay,
  type LessonView,
} from './course-lessons.service';
import { SetLessonsDto } from './dto/set-lessons.dto';

/**
 * The lessons of a course, one file each (FIX-107, H25). New routes one segment deeper than `GET/DELETE /content/:id`, so
 * that catch-all cannot swallow them.
 */
@UseGuards(WawuAuthGuard)
@UseInterceptors(StorageBusyInterceptor)
@Controller('content/:id/lessons')
export class CourseLessonsController {
  constructor(private readonly lessons: CourseLessonsService) {}

  /** A fresh link to play one lesson: free lessons for anyone who may open the piece, the rest for buyers and the creator. */
  @Get(':lessonId/play')
  play(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
    @CurrentUser() user: WawuJwtClaims,
  ): Promise<LessonPlay> {
    return this.lessons.play(id, lessonId, user.sub);
  }

  /** The creator states the lessons: the list, the order and each lesson's file. */
  @Put()
  @UseGuards(CreatorAccountGuard)
  set(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: SetLessonsDto,
  ): Promise<{ lessons: LessonView[] }> {
    return this.lessons.set(id, user.sub, dto);
  }
}
