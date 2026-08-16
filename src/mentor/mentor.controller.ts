import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { MentorService } from './mentor.service';
import { ListMentorsQueryDto } from './dto/list-mentors-query.dto';
import type { Mentor } from '../common/types';

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

  @Get()
  list(@Query() query: ListMentorsQueryDto): Promise<Mentor[]> {
    return this.mentorService.list(query.category);
  }

  @Get(':id')
  findOne(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string): Promise<Mentor> {
    return this.mentorService.findOne(id);
  }
}
