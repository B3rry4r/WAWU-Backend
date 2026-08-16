import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { LearnCourseService } from './learn-course.service';
import type { LearnCourse } from '../common/types';

/**
 * Routes per registry.json "LearnCourse".endpoints — both `roles: ["any"]`,
 * so deliberately no `@UseGuards(WawuAuthGuard)` here: this is a public
 * course catalog, matching the mobile Learn rebuild's Alison handoff flow.
 */
@Controller('learn/courses')
export class LearnCourseController {
  constructor(private readonly learnCourseService: LearnCourseService) {}

  @Get()
  findAll(): Promise<LearnCourse[]> {
    return this.learnCourseService.findAll();
  }

  @Get(':id')
  findOne(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string): Promise<LearnCourse> {
    return this.learnCourseService.findOne(id);
  }
}
