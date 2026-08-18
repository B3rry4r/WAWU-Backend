import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  OptionalPaginationQueryDto,
  paginateArray,
  wantsPagination,
} from '../common/dto/pagination.dto';
import type { Paginated } from '../common/interceptors/response.interceptor';
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

  /**
   * Opt-in pagination: no `page`/`perPage` -> the full catalog array, the
   * shape the contract and the frontend already expect. Supply either and
   * the response becomes the standard `Paginated<T>` envelope.
   */
  @Get()
  async findAll(
    @Query() pagination: OptionalPaginationQueryDto,
  ): Promise<LearnCourse[] | Paginated<LearnCourse>> {
    const courses = await this.learnCourseService.findAll();
    return wantsPagination(pagination)
      ? paginateArray(courses, pagination)
      : courses;
  }

  @Get(':id')
  findOne(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<LearnCourse> {
    return this.learnCourseService.findOne(id);
  }
}
