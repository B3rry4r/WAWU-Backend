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
import { LegalAssistantService } from './legal-assistant.service';
import { SendAssistantMessageDto } from './dto/legal-assistant.dto';
import type {
  LegalAssistantThread,
  LegalAssistantTopic,
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
 * is kept, and `POST {id}/reply` asks again).
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
}
