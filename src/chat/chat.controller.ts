import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { ChatService } from './chat.service';
import {
  ChatPageQueryDto,
  ChatUploadDto,
  MarkChatReadDto,
  OpenChatDto,
  ChatSendMessageDto,
} from './dto/chat.dto';
import type {
  ChatMessage,
  ChatMessagePage,
  ChatReadMark,
  ChatSummary,
  ChatSummaryPage,
  ChatUpload,
} from './chat-view.type';

/**
 * Free chat between any two users (task INBOX-06, DECISIONS R-13). New
 * routes under `/chats`, a first segment no other route uses. Any signed-in
 * account may chat; a block in either direction refuses opening, uploading
 * and sending with 403 `chat_blocked`.
 */
@UseGuards(WawuAuthGuard)
@Controller('chats')
export class ChatController {
  constructor(private readonly chats: ChatService) {}

  /** Open the chat with one person, or get the one that already exists. */
  @Post()
  @HttpCode(200)
  open(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: OpenChatDto,
  ): Promise<ChatSummary> {
    return this.chats.open(user.sub, dto.wawuId);
  }

  /** The caller's chats, newest activity first, cursor-paged. */
  @Get()
  list(
    @CurrentUser() user: WawuJwtClaims,
    @Query() query: ChatPageQueryDto,
  ): Promise<ChatSummaryPage> {
    return this.chats.list(user.sub, query.cursor, query.limit);
  }

  @Get(':chatId')
  get(
    @CurrentUser() user: WawuJwtClaims,
    @Param('chatId', ParseUUIDPipe) chatId: string,
  ): Promise<ChatSummary> {
    return this.chats.get(user.sub, chatId);
  }

  /** Messages, newest first, cursor-paged. */
  @Get(':chatId/messages')
  messages(
    @CurrentUser() user: WawuJwtClaims,
    @Param('chatId', ParseUUIDPipe) chatId: string,
    @Query() query: ChatPageQueryDto,
  ): Promise<ChatMessagePage> {
    return this.chats.messages(user.sub, chatId, query.cursor, query.limit);
  }

  @Post(':chatId/messages')
  send(
    @CurrentUser() user: WawuJwtClaims,
    @Param('chatId', ParseUUIDPipe) chatId: string,
    @Body() dto: ChatSendMessageDto,
  ): Promise<ChatMessage> {
    return this.chats.send(user.sub, chatId, dto);
  }

  /** Move the caller's read mark forward. */
  @Post(':chatId/read')
  @HttpCode(200)
  markRead(
    @CurrentUser() user: WawuJwtClaims,
    @Param('chatId', ParseUUIDPipe) chatId: string,
    @Body() dto: MarkChatReadDto,
  ): Promise<ChatReadMark> {
    return this.chats.markRead(user.sub, chatId, dto);
  }

  /** Where to upload one photo, video or PDF for this chat. */
  @Post(':chatId/attachments')
  @HttpCode(200)
  presignAttachment(
    @CurrentUser() user: WawuJwtClaims,
    @Param('chatId', ParseUUIDPipe) chatId: string,
    @Body() dto: ChatUploadDto,
  ): Promise<ChatUpload> {
    return this.chats.presignAttachment(user.sub, chatId, dto);
  }
}
