import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { OpenSupportThreadDto } from './dto/support.dto';
import { SupportService } from './support.service';
import type { SupportThreadView } from './support-view.type';

/**
 * Support chat (task SUPPORT-01, DECISIONS R-30). One new route under
 * `/support`, a first segment no other route uses. The thread it opens is an
 * ordinary chat (`/chats/{chatId}`), so reading and writing in it use the
 * chat routes; staff reply through `/admin/support/threads`.
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('support')
export class SupportController {
  constructor(private readonly support: SupportService) {}

  /**
   * H18 "Contact support", W27 "Report a problem" and W35 "Help with a
   * payment": open the caller's support thread, or get the one that exists,
   * with the payment they are asking about already written into it. The same
   * reference sent again returns the same thread and the same message. A
   * reference that does not exist, or is someone else's, is 404.
   */
  @Post('thread')
  @HttpCode(200)
  open(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: OpenSupportThreadDto,
  ): Promise<SupportThreadView> {
    return this.support.openThread(user.sub, dto);
  }
}
