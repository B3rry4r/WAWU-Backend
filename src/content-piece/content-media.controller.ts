import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  UseGuards,
} from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { ContentMediaService } from './content-media.service';
import { CreatorAccountGuard } from './guards/creator-account-guard';
import { SetMediaDto } from './dto/set-media.dto';

/**
 * Photo-set frames, durations and page counts of a piece (HOME-05). New
 * routes one segment deeper than `GET/DELETE /content/:id`, so that catch-all
 * cannot swallow them.
 */
@UseGuards(WawuAuthGuard)
@Controller('content/:id/media')
export class ContentMediaController {
  constructor(private readonly media: ContentMediaService) {}

  @Get()
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: WawuJwtClaims,
  ) {
    return this.media.get(id, user.sub);
  }

  @Put()
  @UseGuards(CreatorAccountGuard)
  set(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: SetMediaDto,
  ) {
    return this.media.set(id, user.sub, dto);
  }
}
