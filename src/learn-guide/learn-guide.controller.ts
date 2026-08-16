import { Controller, Get, NotFoundException, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import type { LearnGuideResponse } from '../common/types';
import { ListLearnGuidesQueryDto } from './dto/list-learn-guides-query.dto';
import { LearnGuideService } from './learn-guide.service';

/**
 * Registry resource: LearnGuide. Both endpoints are `roles: ["any"]` (public,
 * no `WawuAuthGuard`) — the "Learn" hub's country/article/template guides are
 * readable by anyone, matching the frontend's SEAM comment
 * (`getMockGuides()` takes no auth/token).
 */
@Controller('learn/guides')
export class LearnGuideController {
  constructor(private readonly learnGuideService: LearnGuideService) {}

  @Get()
  async list(@Query() query: ListLearnGuidesQueryDto): Promise<LearnGuideResponse[]> {
    return this.learnGuideService.findAll(query);
  }

  @Get(':id')
  async findOne(@Param('id', ParseUUIDPipe) id: string): Promise<LearnGuideResponse> {
    const guide = await this.learnGuideService.findOne(id);
    if (!guide) {
      throw new NotFoundException('Learn guide not found.');
    }
    return guide;
  }
}
