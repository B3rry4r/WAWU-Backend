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
import { AdminRole } from '../../../generated/prisma/enums';
import { ChatService } from '../../chat/chat.service';
import { ChatPageQueryDto, ChatSendMessageDto } from '../../chat/dto/chat.dto';
import type {
  ChatMessage,
  ChatMessagePage,
  ChatSummaryPage,
} from '../../chat/chat-view.type';
import { SUPPORT_WAWU_ID } from '../../support/support-account';
import { AdminRoles } from '../auth/decorators/admin-roles.decorator';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { AdminRolesGuard } from '../auth/guards/admin-roles.guard';

/**
 * How staff read and answer support threads (task SUPPORT-01, DECISIONS
 * R-30) — `/api/hub/admin/support/*` once the global prefix is applied. The
 * dashboard had no support tools, so these are the reply route.
 *
 * A support thread is a chat between a person and the support account, and
 * every route here reads or writes it AS the support account: the same chat
 * service the person's app uses, so a reply lands in the person's chat with
 * the same unread count, read marks and live update as any message. A chat
 * the support account is not in is 404, so these routes can never read a chat
 * between two people.
 *
 * ── ROLE MATRIX (documented, and enforced per handler) ────────────────────
 *   list, read, reply          — superadmin, support
 *   reviewer, finance          — refused entirely
 *
 * AdminRolesGuard does not treat superadmin as implicitly allowed, so every
 * handler names both roles.
 */
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Controller('admin/support')
export class AdminSupportController {
  constructor(private readonly chats: ChatService) {}

  /**
   * The support threads, newest activity first. Each item's `other` is the
   * person, `lastMessage.mine` is false while it waits for a reply, and
   * `unreadCount` is how many of their messages no reply has followed.
   */
  @AdminRoles(AdminRole.superadmin, AdminRole.support)
  @Get('threads')
  threads(@Query() query: ChatPageQueryDto): Promise<ChatSummaryPage> {
    return this.chats.list(SUPPORT_WAWU_ID, query.cursor, query.limit);
  }

  /** One thread's messages, newest first, cursor-paged. */
  @AdminRoles(AdminRole.superadmin, AdminRole.support)
  @Get('threads/:chatId/messages')
  messages(
    @Param('chatId', ParseUUIDPipe) chatId: string,
    @Query() query: ChatPageQueryDto,
  ): Promise<ChatMessagePage> {
    return this.chats.messages(
      SUPPORT_WAWU_ID,
      chatId,
      query.cursor,
      query.limit,
    );
  }

  /**
   * Reply in a thread. The person sees it in their chat from "Who Made
   * This?". The same `clientMessageId` sent again returns the first reply
   * instead of posting it twice.
   */
  @AdminRoles(AdminRole.superadmin, AdminRole.support)
  @Post('threads/:chatId/messages')
  reply(
    @Param('chatId', ParseUUIDPipe) chatId: string,
    @Body() dto: ChatSendMessageDto,
  ): Promise<ChatMessage> {
    return this.chats.send(SUPPORT_WAWU_ID, chatId, dto);
  }
}
