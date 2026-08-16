import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { PaginationQueryDto } from '../common/dto/pagination.dto';
import { CommunityMessageService } from './community-message.service';
import { CreateCommunityMessageDto } from './dto/create-community-message.dto';

/**
 * Frozen CommunityMessage contract: GET/POST /communities/:id/messages,
 * both `roles: ["any"]` — any authenticated WAWU user. POST additionally
 * carries the CreditsState paid-messaging gate documented on
 * CommunityMessageService.create().
 */
@UseGuards(WawuAuthGuard)
@Controller('communities/:id/messages')
export class CommunityMessageController {
  constructor(
    private readonly communityMessageService: CommunityMessageService,
  ) {}

  @Get()
  list(
    @Param('id', ParseUUIDPipe) communityId: string,
    @Query() query: PaginationQueryDto,
  ) {
    return this.communityMessageService.list(
      communityId,
      query.page,
      query.perPage,
    );
  }

  @Post()
  create(
    @Param('id', ParseUUIDPipe) communityId: string,
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: CreateCommunityMessageDto,
  ) {
    return this.communityMessageService.create(communityId, user.sub, dto);
  }
}
