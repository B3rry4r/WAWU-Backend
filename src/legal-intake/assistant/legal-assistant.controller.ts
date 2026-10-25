import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { WawuAuthGuard } from '../../common/guards/wawu-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../../common/auth/wawu-jwt-claims.interface';
import { ChatUploadDto } from '../../chat/dto/chat.dto';
import { LegalAssistantService } from './legal-assistant.service';
import {
  SendAssistantMessageDto,
  StartFixedPriceDto,
} from './dto/legal-assistant.dto';
import type {
  LegalAssistantThread,
  LegalAssistantTopic,
  LegalAssistantUpload,
} from './legal-assistant.types';

/**
 * Legal starts as a chat: `/api/hub/legal/assistant/*` (LEGAL-01, S14 to S17).
 *
 * The assistant profiles the problem on an unpaid intake, the client confirms
 * the brief and sends it to a consultant, and the consultant joins the same
 * conversation before anything is priced or paid. Nothing on these routes
 * takes money.
 *
 * Behind WawuAuthGuard: a conversation holds somebody's legal problem, and
 * another person's conversation answers 404 like one that does not exist.
 * The literal `topics` is declared before `:id`.
 *
 * Refusals carry `reason.code`: `message_empty` (400),
 * `message_invalid_characters` (400, a NUL in the text), `quick_reply_unknown`
 * (400), `not_found` (404), `brief_not_ready` (409), `nothing_to_answer`
 * (409), `assistant_busy` (409, another paid call for this conversation is
 * running), `assistant_conversation_full` (409), `assistant_rate_limited`
 * (429, `retryAfterSeconds`), `assistant_unavailable` (503; a client message
 * is kept, and `POST {id}/reply` asks again), `assistant_at_capacity` (503;
 * the provider's allowance is spent: the message is kept, the assistant is
 * busy, and asking again later works), `fixed_price_matter` (409, Send for a
 * matter that starts from `POST {id}/start`) and `not_fixed_price` (409,
 * `start` for a matter that needs a consultant first). Files for the matter
 * (R2-LEGAL3): `matter_not_open` (409, no request exists yet), `matter_closed`
 * (409, delivered or cancelled) and `matter_files_full` (409, 20 files); the
 * upload itself is refused as a chat refuses one (413 for a size, 413
 * `storage_limit_reached` when the person's storage is full).
 *
 * Limits, per person and checked together with the write so parallel requests
 * cannot beat them: 30 paid calls an hour (a client message, before or after
 * Send, a reply asked for again, a brief prepared) and 40 per conversation
 * before Send; the brief at most 5 tries an hour.
 */
@UseGuards(WawuAuthGuard)
@Controller('legal/assistant')
export class LegalAssistantController {
  constructor(private readonly service: LegalAssistantService) {}

  /** The problems offered as taps when the assistant opens (S14). */
  @Get('topics')
  topics(): LegalAssistantTopic[] {
    return this.service.topics();
  }

  /**
   * Open the conversation, or pick up the unfinished one. A new one starts
   * with the assistant's two opening lines and the topic taps.
   */
  @Post()
  start(@CurrentUser() user: WawuJwtClaims): Promise<LegalAssistantThread> {
    return this.service.startOrResume(user);
  }

  @Get(':id')
  thread(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<LegalAssistantThread> {
    return this.service.get(user.sub, id);
  }

  /**
   * The client says something: typed (`body`) or a tap (`quickReplyId`).
   * Before the brief is sent the assistant answers; after, the message goes
   * to the consultant on the matter's thread.
   */
  @Post(':id/messages')
  send(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendAssistantMessageDto,
  ): Promise<LegalAssistantThread> {
    return this.service.send(user.sub, id, dto);
  }

  /**
   * A file for the matter (R2-LEGAL3): where to upload one photo, video or PDF.
   * Upload it there, confirm it with `POST /uploads/confirm`, then send it with
   * `POST {id}/messages` and `attachment.key`. A file that is signed for and
   * never sent is given back like any chat upload (`POST /uploads/release`).
   */
  @Post(':id/attachments')
  attachment(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChatUploadDto,
  ): Promise<LegalAssistantUpload> {
    return this.service.presignAttachment(user.sub, id, dto);
  }

  /**
   * Ask the assistant again after `503 assistant_unavailable`. Counted like a
   * message, and one at a time per conversation (409 `assistant_busy`).
   */
  @Post(':id/reply')
  reply(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<LegalAssistantThread> {
    return this.service.retry(user.sub, id);
  }

  /**
   * "Send to a consultant" (S16): the brief goes to WAWU Legal's consultant
   * queue and the matter opens at `awaiting_quote`. Nothing is charged.
   * Sending again answers the same thread and opens nothing new.
   */
  @Post(':id/send')
  sendToConsultant(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<LegalAssistantThread> {
    return this.service.sendToConsultant(user.sub, id);
  }

  /**
   * "Start this request" (S24, S26): a matter with a fixed price becomes a
   * request at that price with no consultation (409 `not_fixed_price` when
   * the matter has none). Nothing is charged: the letter is signed on the
   * matter, then the fee is paid. Starting twice answers the same thread.
   */
  @Post(':id/start')
  startFixedPrice(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: StartFixedPriceDto,
  ): Promise<LegalAssistantThread> {
    return this.service.startFixedPrice(user.sub, id, dto.firstNameChoice);
  }
}
