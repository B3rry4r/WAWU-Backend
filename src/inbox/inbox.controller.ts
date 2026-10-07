import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { InboxService } from './inbox.service';
import { InboxPageQueryDto } from './dto/inbox.dto';
import type { InboxPage, InboxUnread } from './inbox-view.type';

/**
 * The inbox (task INBOX-07). New routes under `/inbox`, a first segment no
 * other controller declares, so it cannot shadow or be shadowed.
 */
@UseGuards(WawuAuthGuard)
@Controller('inbox')
export class InboxController {
  constructor(private readonly inbox: InboxService) {}

  /** Chats, paid questions and communities in one list, latest activity first. */
  @Get()
  list(
    @CurrentUser() user: WawuJwtClaims,
    @Query() query: InboxPageQueryDto,
  ): Promise<InboxPage> {
    return this.inbox.list(user.sub, query.cursor, query.limit, query.kind);
  }

  /** The Inbox tab's badge: the sum of every row's unread count. */
  @Get('unread')
  unread(@CurrentUser() user: WawuJwtClaims): Promise<InboxUnread> {
    return this.inbox.unread(user.sub);
  }
}
