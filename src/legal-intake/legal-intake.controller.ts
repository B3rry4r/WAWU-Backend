import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { LegalIntakeService } from './legal-intake.service';
import {
  SaveAnswersDto,
  SendAssistantMessageDto,
  SendChatMessageDto,
  StartAssistantDto,
  StartIntakeDto,
} from './dto/legal-intake.dto';
import { LegalChatService } from './legal-chat.service';
import { LegalAssistantService } from './assistant/legal-assistant.service';
import { LEGAL_MATTERS } from './legal-intake-questions';

/**
 * Legal profiling — `/api/hub/legal/intake/*`.
 *
 * Sits ahead of everything in `/legal/requests`. A request is where money and
 * scheduling live; this is where somebody explains their problem, and it
 * happens first on purpose.
 *
 * ── ROUTE ORDER ───────────────────────────────────────────────────────────
 * The literal `matters` and `mine` segments are declared before `:id`. Nest
 * matches in declaration order, and without that ordering GET
 * /legal/intake/mine would fall into the detail route and 400 on the UUID
 * pipe — the catch-all shape that has bitten this codebase before.
 *
 * Every route is behind WawuAuthGuard. An intake holds somebody's legal
 * problem; none of it is public, and the service re-checks ownership on every
 * read rather than trusting the id alone.
 */
@UseGuards(WawuAuthGuard)
@Controller('legal/intake')
export class LegalIntakeController {
  constructor(
    private readonly service: LegalIntakeService,
    private readonly chat: LegalChatService,
    private readonly assistant: LegalAssistantService,
  ) {}

  /** The fourteen things somebody can say they need. Step one of the flow. */
  @Get('matters')
  matters() {
    return LEGAL_MATTERS;
  }

  /**
   * The chat that writes the brief (LEGAL-01, R-14), which comes before any
   * payment: the person describes the problem to the WAWU Legal Assistant, a
   * brief is written from the conversation, and sending it puts the matter in
   * a consultant's queue with nothing charged.
   *
   * Every route is two or more segments, so none can be taken for `:id`; the
   * literals (`options`, `current`) are declared before `assistant/:id`.
   */
  @Get('assistant/options')
  assistantOptions() {
    return this.assistant.options();
  }

  /** The conversation this person has open, or null when they have none. */
  @Get('assistant/current')
  assistantCurrent(@CurrentUser() user: WawuJwtClaims) {
    return this.assistant.current(user.sub);
  }

  /** Start, or pick up the open one. */
  @Post('assistant')
  assistantStart(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: StartAssistantDto,
  ) {
    return this.assistant.start(user.sub, dto);
  }

  @Get('assistant/:id')
  assistantDetail(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.assistant.get(user.sub, id);
  }

  /** Say something. The assistant answers unless a consultant has joined. */
  @Post('assistant/:id/messages')
  assistantSend(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendAssistantMessageDto,
  ) {
    return this.assistant.send(user.sub, id, dto);
  }

  /** Answer again, when the last message went unanswered. */
  @Post('assistant/:id/reply')
  assistantReply(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.assistant.retryReply(user.sub, id);
  }

  /** Write the brief from the conversation, to be checked before it is sent. */
  @Post('assistant/:id/brief')
  assistantBrief(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.assistant.writeBrief(user.sub, id);
  }

  /** Send the checked brief to a consultant. Nothing is charged. */
  @Post('assistant/:id/send')
  assistantSendToConsultant(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.assistant.sendToConsultant(user.sub, id);
  }

  @Get('mine')
  mine(@CurrentUser() user: WawuJwtClaims) {
    return this.service.listMine(user.sub);
  }

  /** Start, or pick up an unfinished one for the same matter. */
  @Post()
  start(@CurrentUser() user: WawuJwtClaims, @Body() dto: StartIntakeDto) {
    return this.service.start(user.sub, dto.matter);
  }

  @Get(':id')
  detail(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.getOwned(user.sub, id);
  }

  /** Save as they go. Merges, so partial bodies are the normal case. */
  @Patch(':id/answers')
  saveAnswers(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SaveAnswersDto,
  ) {
    return this.service.saveAnswers(user.sub, id, dto);
  }

  /** Finish, and generate the brief the consultant reads. */
  @Post(':id/complete')
  complete(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.complete(user.sub, id);
  }

  /**
   * The conversation on a matter this intake became.
   *
   * Under `/legal/intake/` rather than `/legal/requests/` on purpose: this is
   * the same continuous thing the client started when they answered the first
   * question, and splitting it across two prefixes is how the profiling ended
   * up feeling detached from the service in the first place.
   */
  @Get('chat/:requestId')
  thread(
    @CurrentUser() user: WawuJwtClaims,
    @Param('requestId', ParseUUIDPipe) requestId: string,
  ) {
    return this.chat.getThread(user.sub, requestId);
  }

  @Post('chat/:requestId')
  sendMessage(
    @CurrentUser() user: WawuJwtClaims,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() dto: SendChatMessageDto,
  ) {
    return this.chat.send(user.sub, requestId, dto.body);
  }
}
