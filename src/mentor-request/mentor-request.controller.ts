import { Body, Controller, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { MentorRequestService } from './mentor-request.service';
import { CreateMentorRequestDto } from './dto/create-mentor-request.dto';

/**
 * registry.json "MentorRequest": POST /services/mentors/:id/requests.
 * `roles: ["any"]` — any authenticated WAWU user, no creator gate. FREE —
 * mentors volunteer their time, no payment step (registry note).
 */
@UseGuards(WawuAuthGuard)
@Controller('services/mentors/:id/requests')
export class MentorRequestController {
  constructor(private readonly mentorRequestService: MentorRequestService) {}

  @Post()
  create(
    @Param('id', new ParseUUIDPipe({ version: '4' })) mentorId: string,
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: CreateMentorRequestDto,
  ) {
    return this.mentorRequestService.create(mentorId, user.sub, dto);
  }
}
