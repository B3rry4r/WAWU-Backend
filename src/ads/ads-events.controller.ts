import {
  Body,
  Controller,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { AdsEventsService } from './ads-events.service';
import { RecordAdEventDto } from './dto/ads-events.dto';

/**
 * Task ADS-05 (R-15). Same `ads` first segment as GET /ads (ADS-04), same
 * guard: any signed-in account. The global rate limit applies as everywhere.
 */
@UseGuards(WawuAuthGuard)
@Controller('ads')
export class AdsEventsController {
  constructor(private readonly events: AdsEventsService) {}

  /**
   * The app reports that this person viewed, tapped or skipped the card of a
   * campaign (the id GET /ads returned). Counted once per person, kind and
   * UTC day: a repeat answers the same as the first and changes nothing, so
   * the app may retry freely and the answer says nothing about earlier counts.
   * A campaign that is not being served (unknown, draft, paused, ended, outside
   * its window) is a plain 404, the same for all of them.
   */
  @Post(':id/events')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async record(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RecordAdEventDto,
  ): Promise<{ accepted: true }> {
    await this.events.record(user.sub, id, body.type);
    return { accepted: true };
  }
}
