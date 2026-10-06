import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  GEMINI_CLIENT,
  type GeminiClient,
} from '../../common/ai/gemini-client.interface';
import { GEMINI_MODEL } from '../../common/ai/real-gemini.adapter';
import type { WawuJwtClaims } from '../../common/auth/wawu-jwt-claims.interface';
import { legalService } from '../../legal/legal-catalogue';
import { LegalChatService } from '../legal-chat.service';
import {
  BRIEF_INSTRUCTION,
  renderForModel,
  type LegalBrief,
} from '../legal-brief';
import {
  matterLabel,
  MATTER_TO_SERVICE_CODE,
  validQuestionIds,
  type LegalMatter,
} from '../legal-intake-questions';
import {
  ASSISTANT_BRIEF_AFTER_CLIENT_MESSAGES,
  ASSISTANT_CLIENT_MESSAGES_PER_HOUR,
  ASSISTANT_CLIENT_MESSAGES_PER_INTAKE,
  ASSISTANT_HISTORY_MESSAGES,
} from './legal-assistant-config';
import {
  buildHistory,
  buildInstruction,
  parseTurn,
  validAnswers,
  type AssistantDraft,
} from './legal-assistant-prompt';
import {
  ASSISTANT_TOPICS,
  TOPIC_ID_PREFIX,
  topicById,
} from './legal-assistant-topics';
import type {
  LegalAssistantBrief,
  LegalAssistantMessage,
  LegalAssistantQuickReply,
  LegalAssistantStage,
  LegalAssistantThread,
  LegalAssistantTopic,
  LegalAssistantTranscript,
} from './legal-assistant.types';
import type { SendAssistantMessageDto } from './dto/legal-assistant.dto';

/** The `channel` an assistant intake carries (LegalIntake.channel). */
export const ASSISTANT_CHANNEL = 'assistant';

/**
 * The lines the server writes itself. They are the design's own words (S14,
 * S17; R-14: the chat-first flow is built as designed), and they are true of
 * the system: nothing in this flow takes money, and a matter opened from it
 * starts at `awaiting_quote`, priced only by a consultant.
 */
export const OPENER_LINE = (firstName: string) =>
  `${firstName ? `Hi ${firstName}.` : 'Hi.'} Tell me what's going on, in your own words. I'll ask a few questions, then a consultant picks it up.`;
export const NOT_CHARGED_LINE =
  'Nothing is charged, and no price is quoted until a consultant has read it.';
export const SENT_LINE = "I've sent your brief to a consultant.";

const ONE_HOUR_MS = 3_600_000;

type IntakeRow = {
  id: string;
  wawuUserId: string;
  matter: string;
  status: string;
  answers: unknown;
  brief: unknown;
  draftBrief: unknown;
  channel: string | null;
  legalRequestId: string | null;
};

type IntakeMessageRow = {
  id: string;
  authorRole: 'client' | 'assistant';
  scripted: boolean;
  body: string;
  quickReplies: unknown;
  createdAt: Date;
};

/** A refusal the app can switch on (`reason.code`), never a bare sentence. */
function refusal(
  status: HttpStatus,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): HttpException {
  const body = { message, reason: { code, message, ...extra } };
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return new BadRequestException(body);
    case HttpStatus.NOT_FOUND:
      return new NotFoundException(body);
    case HttpStatus.CONFLICT:
      return new ConflictException(body);
    case HttpStatus.SERVICE_UNAVAILABLE:
      return new ServiceUnavailableException(body);
    default:
      return new HttpException(body, status);
  }
}

function readDraft(value: unknown): AssistantDraft | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<AssistantDraft>;
  return {
    headline: typeof v.headline === 'string' ? v.headline : null,
    facts: Array.isArray(v.facts) ? v.facts : [],
    ready: v.ready === true,
  };
}

function readQuickReplies(value: unknown): LegalAssistantQuickReply[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (q): q is LegalAssistantQuickReply =>
      !!q &&
      typeof (q as LegalAssistantQuickReply).id === 'string' &&
      typeof (q as LegalAssistantQuickReply).label === 'string',
  );
}

/**
 * Legal starts as a chat (LEGAL-01, R-14).
 *
 * The assistant runs on an UNPAID intake: it opens with the design's two
 * lines and the topic taps, asks its questions one at a time, writes what the
 * client said into a working brief on the intake (`draftBrief`) and records
 * any intake answers the client's words clearly give. When the brief is
 * ready the client confirms it and sends it to a consultant: that writes the
 * brief into the intake in the shape the question form writes, opens the
 * matter at `awaiting_quote` (the consultant's queue, before any payment) and
 * from then on the conversation continues on the matter's own thread, where a
 * consultant joins from the existing consultant routes. Once a consultant has
 * written, the assistant answers no more.
 *
 * The question form (`/legal/intake`, the web's) is untouched; the two share
 * the intake table, the matters, the brief shape and the request lifecycle.
 */
@Injectable()
export class LegalAssistantService {
  private readonly logger = new Logger(LegalAssistantService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(GEMINI_CLIENT) private readonly gemini: GeminiClient,
    private readonly chat: LegalChatService,
  ) {}

  topics(): LegalAssistantTopic[] {
    return ASSISTANT_TOPICS;
  }

  /**
   * Pick up the person's unfinished conversation, or open a new one. A
   * conversation already sent to a consultant is never reopened here; it is
   * read by its id.
   */
  async startOrResume(user: WawuJwtClaims): Promise<LegalAssistantThread> {
    const open = await this.prisma.legalIntake.findFirst({
      where: {
        wawuUserId: user.sub,
        channel: ASSISTANT_CHANNEL,
        status: 'in_progress',
      },
      orderBy: { startedAt: 'desc' },
    });
    if (open) return this.thread(open);

    const firstName = (user.firstName ?? '').trim();
    // Both lines get their time from here, a millisecond apart, so they
    // always read in this order.
    const at = Date.now();
    const created = await this.prisma.$transaction(async (tx) => {
      const intake = await tx.legalIntake.create({
        data: {
          wawuUserId: user.sub,
          // `other` until a topic is tapped or the assistant works it out.
          matter: 'other',
          channel: ASSISTANT_CHANNEL,
          answers: {},
          documents: [],
        },
      });
      await tx.legalIntakeMessage.create({
        data: {
          legalIntakeId: intake.id,
          wawuUserId: user.sub,
          authorRole: 'assistant',
          scripted: true,
          body: OPENER_LINE(firstName),
          createdAt: new Date(at),
        },
      });
      await tx.legalIntakeMessage.create({
        data: {
          legalIntakeId: intake.id,
          wawuUserId: user.sub,
          authorRole: 'assistant',
          scripted: true,
          body: NOT_CHARGED_LINE,
          quickReplies: ASSISTANT_TOPICS.map((t) => ({
            id: t.id,
            label: t.label,
          })),
          createdAt: new Date(at + 1),
        },
      });
      return intake;
    });
    return this.thread(created);
  }

  async get(wawuUserId: string, id: string): Promise<LegalAssistantThread> {
    return this.thread(await this.owned(wawuUserId, id));
  }

  async send(
    wawuUserId: string,
    id: string,
    dto: SendAssistantMessageDto,
  ): Promise<LegalAssistantThread> {
    const intake = await this.owned(wawuUserId, id);
    const typed = dto.body?.trim() ?? '';
    const tapped = dto.quickReplyId ?? '';
    if ((typed === '') === (tapped === '')) {
      throw refusal(
        HttpStatus.BAD_REQUEST,
        'message_empty',
        'Type a message or tap an answer.',
      );
    }

    // After "Send to a consultant": the matter's own thread.
    if (intake.legalRequestId) {
      if (tapped) throw this.unknownQuickReply();
      await this.sendOnMatter(wawuUserId, intake.legalRequestId, typed);
      return this.thread(await this.owned(wawuUserId, id));
    }
    if (intake.status !== 'in_progress') throw this.notFound();

    await this.checkLimits(wawuUserId, intake.id);

    let body = typed;
    if (tapped) {
      const live = await this.liveQuickReplies(intake.id);
      const reply = live.find((q) => q.id === tapped);
      if (!reply) throw this.unknownQuickReply();
      body = reply.label;
      const topic = tapped.startsWith(TOPIC_ID_PREFIX)
        ? topicById(tapped)
        : undefined;
      if (topic && topic.matter !== intake.matter) {
        const updated = await this.prisma.legalIntake.update({
          where: { id: intake.id },
          data: {
            matter: topic.matter,
            answers: this.keepAnswersFor(topic.matter, intake.answers) as never,
          },
        });
        intake.matter = updated.matter;
        intake.answers = updated.answers;
      }
    }

    await this.prisma.legalIntakeMessage.create({
      data: {
        legalIntakeId: intake.id,
        wawuUserId,
        authorRole: 'client',
        body,
      },
    });
    await this.turn(intake);
    return this.thread(await this.owned(wawuUserId, id));
  }

  /** Ask the assistant again when its last answer failed. */
  async retry(wawuUserId: string, id: string): Promise<LegalAssistantThread> {
    const intake = await this.owned(wawuUserId, id);
    if (intake.legalRequestId || intake.status !== 'in_progress') {
      throw this.nothingToAnswer();
    }
    const last = await this.prisma.legalIntakeMessage.findFirst({
      where: { legalIntakeId: intake.id },
      orderBy: { createdAt: 'desc' },
    });
    if (!last || last.authorRole !== 'client') throw this.nothingToAnswer();
    await this.turn(intake);
    return this.thread(await this.owned(wawuUserId, id));
  }

  /**
   * "Send to a consultant" (S16). Writes the brief into the intake, in the
   * form's shape, and opens the matter at `awaiting_quote`, where a
   * consultant reads it before anything is priced or paid. Sending twice
   * opens one matter.
   */
  async sendToConsultant(
    wawuUserId: string,
    id: string,
  ): Promise<LegalAssistantThread> {
    const intake = await this.owned(wawuUserId, id);
    if (intake.legalRequestId) return this.thread(intake);
    if (intake.status !== 'in_progress') throw this.notFound();

    const draft = readDraft(intake.draftBrief);
    if (!draft?.ready || draft.facts.length === 0) {
      throw refusal(
        HttpStatus.CONFLICT,
        'brief_not_ready',
        'The assistant needs a little more before this can go to a consultant.',
      );
    }

    const matter = intake.matter;
    const facts = [
      { question: 'Matter', answer: draft.headline ?? matterLabel(matter) },
      ...draft.facts.map((f) => ({ question: f.label, answer: f.value })),
    ];

    // The consultant's analysis, written from the confirmed brief only: the
    // rows the client was shown and agreed to, nothing else.
    let analysis;
    try {
      analysis = await this.gemini.generateBrief({
        instruction: BRIEF_INSTRUCTION,
        content: renderForModel(matter, facts, 0),
      });
    } catch (error) {
      this.logger.error(
        `Assistant brief failed for intake ${intake.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw this.briefUnavailable();
    }
    if (!analysis.summary) throw this.briefUnavailable();

    const service = legalService(MATTER_TO_SERVICE_CODE[matter as LegalMatter]);
    if (!service) {
      this.logger.error(`Matter ${matter} maps to no catalogue service`);
      throw this.briefUnavailable();
    }

    const brief: LegalBrief = {
      matter,
      matterLabel: matterLabel(matter),
      facts,
      documentCount: 0,
      analysis,
      generatedBy: GEMINI_MODEL,
      generatedAt: new Date().toISOString(),
    };

    const sent = await this.prisma.$transaction(async (tx) => {
      // The claim: only one send converts the intake, however many arrive.
      const claim = await tx.legalIntake.updateMany({
        where: { id: intake.id, status: 'in_progress', legalRequestId: null },
        data: {
          status: 'converted',
          completedAt: new Date(),
          brief: brief as never,
        },
      });
      if (claim.count === 0) return false;
      const request = await tx.legalRequest.create({
        data: {
          wawuUserId,
          serviceCode: service.code,
          serviceName: service.name,
          category: service.category,
          path: service.path,
          details: {
            intakeId: intake.id,
            brief,
            answers: intake.answers,
          } as never,
          documents: [],
          // As the form does: nobody is quoted before a consultant has read
          // what they need (legal-intake.service.ts, complete()).
          status: 'awaiting_quote',
        },
      });
      await tx.legalIntake.update({
        where: { id: intake.id },
        data: { legalRequestId: request.id },
      });
      await tx.legalIntakeMessage.create({
        data: {
          legalIntakeId: intake.id,
          wawuUserId,
          authorRole: 'assistant',
          scripted: true,
          body: SENT_LINE,
        },
      });
      return true;
    });
    if (!sent) {
      this.logger.log(`Intake ${intake.id} was already sent`);
    }
    return this.thread(await this.owned(wawuUserId, id));
  }

  /** The conversation before the brief was sent, for the consultant. */
  async transcriptForOps(id: string): Promise<LegalAssistantTranscript> {
    const intake = await this.prisma.legalIntake.findUnique({ where: { id } });
    if (!intake || intake.channel !== ASSISTANT_CHANNEL) {
      throw new NotFoundException('Intake not found');
    }
    const rows = await this.intakeMessages(intake.id);
    return {
      intakeId: intake.id,
      legalRequestId: intake.legalRequestId,
      brief: this.briefView(intake),
      messages: rows.map((m) => this.fromIntakeMessage(m)),
    };
  }

  /* ---------------------------------------------------------------- */

  /**
   * One profiling turn: the model reads the conversation and answers with a
   * reply, its working brief and any intake answers; the server keeps only
   * what passes its checks. A failure keeps the client's message and says so.
   */
  private async turn(intake: IntakeRow): Promise<void> {
    const messages = await this.intakeMessages(intake.id);
    const history = buildHistory(messages, ASSISTANT_HISTORY_MESSAGES);
    const last = history[history.length - 1];
    if (!last || last.role !== 'user') throw this.nothingToAnswer();

    const draft = readDraft(intake.draftBrief);
    const answers = (intake.answers ?? {}) as Record<string, unknown>;

    let turn;
    try {
      const raw = await this.gemini.chat({
        instruction: buildInstruction({
          matter: intake.matter,
          draft,
          answers,
        }),
        history,
      });
      turn = parseTurn(raw);
    } catch (error) {
      // Logged without the conversation: it is somebody's legal problem.
      this.logger.error(
        `Assistant turn failed for intake ${intake.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw refusal(
        HttpStatus.SERVICE_UNAVAILABLE,
        'assistant_unavailable',
        'Your message was saved. The assistant could not reply just now. Try again in a moment.',
      );
    }

    const matter = turn.matter ?? intake.matter;
    const kept =
      matter === intake.matter
        ? answers
        : this.keepAnswersFor(matter, intake.answers);
    const nextAnswers = { ...kept, ...validAnswers(matter, turn.answers) };
    const facts = turn.facts.length > 0 ? turn.facts : (draft?.facts ?? []);
    const clientMessages = messages.filter(
      (m) => m.authorRole === 'client',
    ).length;
    const nextDraft: AssistantDraft = {
      headline: turn.headline ?? draft?.headline ?? null,
      facts,
      ready:
        facts.length > 0 &&
        (turn.briefReady ||
          clientMessages >= ASSISTANT_BRIEF_AFTER_CLIENT_MESSAGES),
    };
    const quickReplies = nextDraft.ready
      ? []
      : turn.quickReplies.map((label, i) => ({ id: `answer:${i + 1}`, label }));

    await this.prisma.$transaction([
      this.prisma.legalIntakeMessage.create({
        data: {
          legalIntakeId: intake.id,
          wawuUserId: intake.wawuUserId,
          authorRole: 'assistant',
          body: turn.reply,
          quickReplies: quickReplies.length > 0 ? quickReplies : undefined,
        },
      }),
      this.prisma.legalIntake.update({
        where: { id: intake.id },
        data: {
          matter,
          answers: nextAnswers as never,
          draftBrief: nextDraft as never,
        },
      }),
    ]);
  }

  /**
   * A client message once the brief is sent. Before payment it waits for the
   * consultant on the matter's thread (the assistant has stopped); after
   * payment the existing conversation rules apply unchanged
   * (LegalChatService.send: the assistant answers until a consultant has
   * written).
   */
  private async sendOnMatter(
    wawuUserId: string,
    requestId: string,
    body: string,
  ): Promise<void> {
    try {
      await this.chat.send(wawuUserId, requestId, body);
    } catch (error) {
      if (!(error instanceof ConflictException)) throw error;
      // Not paid for yet: LegalChatService.send refuses before writing
      // anything, so the message is written here, for the consultant.
      await this.prisma.legalChatMessage.create({
        data: { legalRequestId: requestId, authorRole: 'client', body },
      });
    }
  }

  private async checkLimits(wawuUserId: string, intakeId: string) {
    const inThisOne = await this.prisma.legalIntakeMessage.count({
      where: { legalIntakeId: intakeId, authorRole: 'client' },
    });
    if (inThisOne >= ASSISTANT_CLIENT_MESSAGES_PER_INTAKE) {
      throw refusal(
        HttpStatus.CONFLICT,
        'assistant_conversation_full',
        'This conversation is long enough for a consultant to pick up. Send your brief to a consultant.',
      );
    }
    const since = new Date(Date.now() - ONE_HOUR_MS);
    const recent = await this.prisma.legalIntakeMessage.findMany({
      where: { wawuUserId, authorRole: 'client', createdAt: { gte: since } },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
      take: ASSISTANT_CLIENT_MESSAGES_PER_HOUR,
    });
    if (recent.length >= ASSISTANT_CLIENT_MESSAGES_PER_HOUR) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil(
          (recent[0].createdAt.getTime() + ONE_HOUR_MS - Date.now()) / 1000,
        ),
      );
      throw refusal(
        HttpStatus.TOO_MANY_REQUESTS,
        'assistant_rate_limited',
        'You have sent a lot of messages in the last hour. Try again a little later.',
        { retryAfterSeconds },
      );
    }
  }

  /** Answers that are still questions of `matter`; the rest are dropped. */
  private keepAnswersFor(
    matter: string,
    answers: unknown,
  ): Record<string, unknown> {
    const valid = validQuestionIds(matter);
    return Object.fromEntries(
      Object.entries((answers ?? {}) as Record<string, unknown>).filter(
        ([id]) => valid.has(id),
      ),
    );
  }

  private async owned(wawuUserId: string, id: string): Promise<IntakeRow> {
    const intake = await this.prisma.legalIntake.findUnique({ where: { id } });
    // Somebody else's conversation answers exactly like one that does not
    // exist, so ids cannot be probed.
    if (
      !intake ||
      intake.wawuUserId !== wawuUserId ||
      intake.channel !== ASSISTANT_CHANNEL
    ) {
      throw this.notFound();
    }
    return intake;
  }

  private async intakeMessages(intakeId: string): Promise<IntakeMessageRow[]> {
    return this.prisma.legalIntakeMessage.findMany({
      where: { legalIntakeId: intakeId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  private async liveQuickReplies(
    intakeId: string,
  ): Promise<LegalAssistantQuickReply[]> {
    const last = await this.prisma.legalIntakeMessage.findFirst({
      where: { legalIntakeId: intakeId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    if (!last || last.authorRole !== 'assistant') return [];
    return readQuickReplies(last.quickReplies);
  }

  private stageOf(intake: IntakeRow): LegalAssistantStage {
    if (intake.legalRequestId) return 'sent';
    return readDraft(intake.draftBrief)?.ready ? 'brief_ready' : 'profiling';
  }

  private briefView(intake: IntakeRow): LegalAssistantBrief | null {
    const sent = intake.brief as LegalBrief | null;
    if (intake.legalRequestId && sent?.facts) {
      return {
        matter: sent.matter,
        matterLabel: sent.matterLabel,
        rows: sent.facts.map((f) => ({ label: f.question, value: f.answer })),
        ready: true,
      };
    }
    const draft = readDraft(intake.draftBrief);
    if (!draft || draft.facts.length === 0) return null;
    return {
      matter: intake.matter,
      matterLabel: matterLabel(intake.matter),
      rows: [
        {
          label: 'Matter',
          value: draft.headline ?? matterLabel(intake.matter),
        },
        ...draft.facts.map((f) => ({ label: f.label, value: f.value })),
      ],
      ready: draft.ready,
    };
  }

  private fromIntakeMessage(m: IntakeMessageRow): LegalAssistantMessage {
    return {
      id: m.id,
      authorRole: m.authorRole,
      body: m.body,
      createdAt: m.createdAt,
      consultantName: null,
    };
  }

  private async thread(intake: IntakeRow): Promise<LegalAssistantThread> {
    const intakeRows = await this.intakeMessages(intake.id);
    const messages = intakeRows.map((m) => this.fromIntakeMessage(m));

    let requestStatus: string | null = null;
    let consultant: LegalAssistantThread['consultant'] = null;
    if (intake.legalRequestId) {
      const [request, rows] = await Promise.all([
        this.prisma.legalRequest.findUnique({
          where: { id: intake.legalRequestId },
          select: { status: true },
        }),
        this.prisma.legalChatMessage.findMany({
          where: { legalRequestId: intake.legalRequestId },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
      ]);
      requestStatus = request?.status ?? null;
      const adminIds = [
        ...new Set(
          rows
            .map((r) => r.authorAdminId)
            .filter((v): v is string => Boolean(v)),
        ),
      ];
      const admins = adminIds.length
        ? await this.prisma.adminUser.findMany({
            where: { id: { in: adminIds } },
            select: { id: true, name: true },
          })
        : [];
      const names = new Map(admins.map((a) => [a.id, a.name]));
      for (const r of rows) {
        const consultantName =
          r.authorRole === 'consultant'
            ? (names.get(r.authorAdminId ?? '') ?? null)
            : null;
        if (r.authorRole === 'consultant' && !consultant) {
          consultant = { name: consultantName, joinedAt: r.createdAt };
        }
        messages.push({
          id: r.id,
          authorRole: r.authorRole === 'ai' ? 'assistant' : r.authorRole,
          body: r.body,
          createdAt: r.createdAt,
          consultantName,
        });
      }
    }

    const stage = this.stageOf(intake);
    const lastIntake = intakeRows[intakeRows.length - 1];
    const quickReplies =
      stage !== 'sent' && lastIntake?.authorRole === 'assistant'
        ? readQuickReplies(lastIntake.quickReplies)
        : [];

    return {
      id: intake.id,
      stage,
      matter: intake.matter,
      matterLabel: matterLabel(intake.matter),
      messages,
      quickReplies,
      brief: this.briefView(intake),
      awaitingReply: stage !== 'sent' && lastIntake?.authorRole === 'client',
      legalRequestId: intake.legalRequestId,
      requestStatus,
      consultant,
      assistantStopped: consultant !== null,
    };
  }

  private notFound() {
    return refusal(
      HttpStatus.NOT_FOUND,
      'not_found',
      'This conversation could not be found.',
    );
  }

  private unknownQuickReply() {
    return refusal(
      HttpStatus.BAD_REQUEST,
      'quick_reply_unknown',
      'That answer is no longer on offer. Type your answer instead.',
    );
  }

  private nothingToAnswer() {
    return refusal(
      HttpStatus.CONFLICT,
      'nothing_to_answer',
      'There is no message waiting for the assistant.',
    );
  }

  private briefUnavailable() {
    return refusal(
      HttpStatus.SERVICE_UNAVAILABLE,
      'assistant_unavailable',
      'We could not prepare your brief just now. Nothing was sent. Try again in a moment.',
    );
  }
}
