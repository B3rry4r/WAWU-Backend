import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import {
  MAX_PAGE,
  MAX_PER_PAGE,
  paginateArray,
  wantsPagination,
} from '../common/dto/pagination.dto';
import type { Paginated } from '../common/interceptors/response.interceptor';
import type { LearnGuideResponse } from '../common/types';
import { ListLearnGuidesQueryDto } from './dto/list-learn-guides-query.dto';
import { LearnGuideService } from './learn-guide.service';

/**
 * `kind`/`country` filters + opt-in `page`/`perPage`. One class because the
 * global ValidationPipe runs `forbidNonWhitelisted` — two separate @Query()
 * DTOs on one handler would each reject the other's properties.
 */
class ListLearnGuidesPagedQueryDto extends ListLearnGuidesQueryDto {
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
 * Registry resource: LearnGuide. Both endpoints are `roles: ["any"]` (public,
 * no `WawuAuthGuard`) — the "Learn" hub's country/article/template guides are
 * readable by anyone, matching the frontend's SEAM comment
 * (`getMockGuides()` takes no auth/token).
 */
@Controller('learn/guides')
export class LearnGuideController {
  constructor(private readonly learnGuideService: LearnGuideService) {}

  /** Opt-in pagination — no `page`/`perPage` returns the full array as before. */
  @Get()
  async list(
    @Query() query: ListLearnGuidesPagedQueryDto,
  ): Promise<LearnGuideResponse[] | Paginated<LearnGuideResponse>> {
    const guides = await this.learnGuideService.findAll(query);
    return wantsPagination(query) ? paginateArray(guides, query) : guides;
  }

  @Get(':id')
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<LearnGuideResponse> {
    const guide = await this.learnGuideService.findOne(id);
    if (!guide) {
      throw new NotFoundException('Learn guide not found.');
    }
    return guide;
  }
}
