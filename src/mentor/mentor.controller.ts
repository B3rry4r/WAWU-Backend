import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import {
  MAX_PAGE,
  MAX_PER_PAGE,
  paginateArray,
  wantsPagination,
} from '../common/dto/pagination.dto';
import type { Paginated } from '../common/interceptors/response.interceptor';
import { MentorService } from './mentor.service';
import { ListMentorsQueryDto } from './dto/list-mentors-query.dto';
import type { Mentor } from '../common/types';

/**
 * `category` + opt-in `page`/`perPage` in one class: the global
 * ValidationPipe runs `forbidNonWhitelisted`, so a handler can't bind two
 * separate @Query() DTOs — each would reject the other's properties. Kept
 * here next to its only consumer rather than widening the shared
 * ListMentorsQueryDto, which other callers pass without paging.
 */
class ListMentorsPagedQueryDto extends ListMentorsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PER_PAGE)
  perPage?: number;
}

/**
 * registry.json § Mentor — both endpoints are `roles: ["any"]`, i.e. any
 * authenticated WAWU user (conventions.md § Roles & permissions guard idiom
 * — `@UseGuards(WawuAuthGuard)` for "any authenticated user"). Mentors are
 * FREE (product-truths.json: mentors volunteer their time, no payment
 * step) — read-only directory here, no request/booking endpoint (that's
 * MentorRequest, a separate registry resource).
 */
@UseGuards(WawuAuthGuard)
@Controller('services/mentors')
export class MentorController {
  constructor(private readonly mentorService: MentorService) {}

  /** Opt-in pagination — no `page`/`perPage` returns the full array as before. */
  @Get()
  async list(
    @Query() query: ListMentorsPagedQueryDto,
  ): Promise<Mentor[] | Paginated<Mentor>> {
    const mentors = await this.mentorService.list(query.category);
    return wantsPagination(query) ? paginateArray(mentors, query) : mentors;
  }

  @Get(':id')
  findOne(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<Mentor> {
    return this.mentorService.findOne(id);
  }
}
