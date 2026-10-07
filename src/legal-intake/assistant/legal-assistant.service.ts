import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
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
import { withoutEmDash } from '../ai-text';
import {
  ASSISTANT_BRIEF_AFTER_CLIENT_MESSAGES,
  ASSISTANT_CLAIM_MS,
  ASSISTANT_HISTORY_MESSAGES,
} from './legal-assistant-config';
import {
  LegalAssistantAllowance,
  refusal,
  TX_OPTIONS,
  type Spend,
} from './legal-assistant-allowance';
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

/** How long a caller that lost a claim waits for the winner to finish. */
const CLAIM_WAIT_MS = 20_000;
const CLAIM_POLL_MS = 50;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    private readonly allowance: LegalAssistantAllowance,
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
    const findOpen = () =>
      this.prisma.legalIntake.findFirst({
        where: {
          wawuUserId: user.sub,
          channel: ASSISTANT_CHANNEL,
          status: 'in_progress',
        },
        orderBy: { startedAt: 'desc' },
      });
    const open = await findOpen();
    if (open) return this.thread(open);

    const firstName = (user.firstName ?? '').trim();
    // Both lines get their time from here, a millisecond apart, so they
    // always read in this order.
    const at = Date.now();
    let created: IntakeRow;
    try {
      created = await this.prisma.$transaction(async (tx) => {
        // Opening is idempotent per person: the lock makes parallel opens
        // queue, and the first one's conversation is the one the rest find.
        // The database's partial unique index is the backstop behind it.
        await this.lockPerson(tx, user.sub);
        const existing = await tx.legalIntake.findFirst({
          where: {
            wawuUserId: user.sub,
            channel: ASSISTANT_CHANNEL,
            status: 'in_progress',
          },
          orderBy: { startedAt: 'desc' },
        });
        if (existing) return existing;
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
      }, TX_OPTIONS);
    } catch (error) {
      if ((error as { code?: unknown })?.code !== 'P2002') throw error;
      const winner = await findOpen();
      if (!winner) throw error;
      created = winner;
    }
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
    const rawBody = dto.body ?? '';
    // Postgres cannot store U+0000 in text. Refused here, with a reason the
    // app can show, rather than failing at the write as a 500.
    if (rawBody.includes('\u0000')) {
      throw refusal(
        HttpStatus.BAD_REQUEST,
        'message_invalid_characters',
        'That message has a character we cannot keep. Remove it and send again.',
      );
    }
    const typed = rawBody.trim();
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

    // The limits are checked and the message written in ONE step under the
    // person's lock, so parallel sends cannot all pass the check before any
    // of them is counted. A tap is resolved in the same step, so a double
    // tap is one message and the second is "no longer on offer".
    await this.reserve(wawuUserId, intake.id, 'message', async (tx) => {
      const current = await tx.legalIntake.findUnique({
        where: { id: intake.id },
      });
      if (
        !current ||
        current.status !== 'in_progress' ||
        current.legalRequestId
      ) {
        throw this.busy();
      }
      let body = typed;
      if (tapped) {
        const last = await tx.legalIntakeMessage.findFirst({
          where: { legalIntakeId: intake.id },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        });
        const live =
          last && last.authorRole === 'assistant'
            ? readQuickReplies(last.quickReplies)
            : [];
        const reply = live.find((q) => q.id === tapped);
        if (!reply) throw this.unknownQuickReply();
        body = reply.label;
        const topic = tapped.startsWith(TOPIC_ID_PREFIX)
          ? topicById(tapped)
          : undefined;
        if (topic && topic.matter !== current.matter) {
          await tx.legalIntake.update({
            where: { id: intake.id },
            data: {
              matter: topic.matter,
              answers: this.keepAnswersFor(
                topic.matter,
                current.answers,
              ) as never,
            },
          });
        }
      }
      return tx.legalIntakeMessage.create({
        data: {
          legalIntakeId: intake.id,
          wawuUserId,
          authorRole: 'client',
          body,
        },
      });
    });
    await this.turn(await this.owned(wawuUserId, id));
    return this.thread(await this.owned(wawuUserId, id));
  }

  /**
   * Ask the assistant again when its last answer failed. It is a paid call
   * like a message, so it is counted against the same limits, and only one
   * can run for a conversation at a time (409 `assistant_busy`).
   */
  async retry(wawuUserId: string, id: string): Promise<LegalAssistantThread> {
    const intake = await this.owned(wawuUserId, id);
    if (intake.legalRequestId || intake.status !== 'in_progress') {
      throw this.nothingToAnswer();
    }
    const waiting = () =>
      this.prisma.legalIntakeMessage.findFirst({
        where: { legalIntakeId: intake.id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
    const last = await waiting();
    if (!last || last.authorRole !== 'client') throw this.nothingToAnswer();

    const lease = await this.claim(intake.id);
    if (!lease) throw this.busy();
    try {
      await this.reserve(wawuUserId, intake.id, 'reply', async (tx) => {
        // Checked again under the lock: another reply may just have answered.
        const newest = await tx.legalIntakeMessage.findFirst({
          where: { legalIntakeId: intake.id },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        });
        const current = await tx.legalIntake.findUnique({
          where: { id: intake.id },
        });
        if (
          !newest ||
          newest.authorRole !== 'client' ||
          !current ||
          current.status !== 'in_progress' ||
          current.legalRequestId
        ) {
          throw this.nothingToAnswer();
        }
        await tx.legalAssistantCall.create({
          data: { legalIntakeId: intake.id, wawuUserId, kind: 'reply' },
        });
      });
      await this.turn(await this.owned(wawuUserId, id));
    } finally {
      await this.release(intake.id, lease);
    }
    return this.thread(await this.owned(wawuUserId, id));
  }

  /**
   * "Send to a consultant" (S16). Writes the brief into the intake, in the
   * form's shape, and opens the matter at `awaiting_quote`, where a
   * consultant reads it before anything is priced or paid. Sending twice
   * opens one matter.
   *
   * Preparing the brief is a paid AI call, so the intake is CLAIMED first and
   * the call made only by the claim's holder: 20 parallel sends make one
   * call, and the others wait for it and answer with the sent thread. A
   * failed brief releases the claim, so it can be sent again, but each try is
   * counted (`ASSISTANT_BRIEF_ATTEMPTS_PER_HOUR`, and the hourly limit).
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

    const lease = await this.claim(intake.id);
    if (!lease) {
      return this.afterLostClaim(wawuUserId, id);
    }
    try {
      await this.makeAndSend(wawuUserId, intake, draft);
    } finally {
      await this.release(intake.id, lease);
    }
    return this.thread(await this.owned(wawuUserId, id));
  }

  private async makeAndSend(
    wawuUserId: string,
    intake: IntakeRow,
    draft: AssistantDraft,
  ): Promise<void> {
    await this.reserve(wawuUserId, intake.id, 'brief', async (tx) => {
      const current = await tx.legalIntake.findUnique({
        where: { id: intake.id },
      });
      if (!current || current.status !== 'in_progress') throw this.notFound();
      await tx.legalAssistantCall.create({
        data: { legalIntakeId: intake.id, wawuUserId, kind: 'brief' },
      });
    });

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
      // The conversion: only one send converts the intake, however many
      // arrive (the claim above already keeps them out; this is the backstop).
      const claim = await tx.legalIntake.updateMany({
        where: { id: intake.id, status: 'in_progress', legalRequestId: null },
        data: {
          status: 'converted',
          completedAt: new Date(),
          brief: brief as never,
          assistantBusyUntil: null,
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
    }, TX_OPTIONS);
    if (!sent) {
      this.logger.log(`Intake ${intake.id} was already sent`);
    }
  }

  /**
   * A caller whose claim was refused: another send is preparing the brief
   * (or a reply is being asked for). Wait for it. If the brief went, so did
   * this caller's; if the claim is released without one, say the assistant is
   * busy and let the client try again.
   */
  private async afterLostClaim(
    wawuUserId: string,
    id: string,
  ): Promise<LegalAssistantThread> {
    const deadline = Date.now() + CLAIM_WAIT_MS;
    for (;;) {
      // One read for both facts, so "sent" and "released" cannot be seen
      // from two different moments.
      const row = await this.prisma.legalIntake.findUnique({ where: { id } });
      if (!row || row.wawuUserId !== wawuUserId) throw this.notFound();
      if (row.legalRequestId) return this.thread(row);
      if (row.status !== 'in_progress') throw this.notFound();
      const stillHeld =
        row.assistantBusyUntil !== null && row.assistantBusyUntil > new Date();
      if (!stillHeld || Date.now() >= deadline) throw this.busy();
      await sleep(CLAIM_POLL_MS);
    }
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
   *
   * The reply is written only if the message it answers is still the newest
   * in the conversation (checked under the lock, in the write itself). Two
   * messages sent at once each start a turn; the one that read the newest
   * message answers it, and the other finds it answered or superseded and
   * writes nothing, so a conversation never gets two replies to one message.
   */
  private async turn(intake: IntakeRow): Promise<void> {
    const messages = await this.intakeMessages(intake.id);
    const newest = messages[messages.length - 1];
    // Already answered (by a turn that started with the same message).
    if (!newest || newest.authorRole !== 'client') return;
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

    await this.prisma.$transaction(async (tx) => {
      await this.lockPerson(tx, intake.wawuUserId);
      const [latest, current] = await Promise.all([
        tx.legalIntakeMessage.findFirst({
          where: { legalIntakeId: intake.id },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { id: true },
        }),
        tx.legalIntake.findUnique({
          where: { id: intake.id },
          select: { status: true, legalRequestId: true },
        }),
      ]);
      if (
        !latest ||
        latest.id !== newest.id ||
        !current ||
        current.status !== 'in_progress' ||
        current.legalRequestId
      ) {
        return;
      }
      await tx.legalIntakeMessage.create({
        data: {
          legalIntakeId: intake.id,
          wawuUserId: intake.wawuUserId,
          authorRole: 'assistant',
          body: turn.reply,
          quickReplies: quickReplies.length > 0 ? quickReplies : undefined,
        },
      });
      await tx.legalIntake.update({
        where: { id: intake.id },
        data: {
          matter,
          answers: nextAnswers as never,
          draftBrief: nextDraft as never,
        },
      });
    }, TX_OPTIONS);
  }

  /**
   * A client message once the brief is sent. Counted against the same hourly
   * allowance as every other message, in one step with the write. Before
   * payment it waits for the consultant on the matter's thread (the
   * assistant has stopped); after payment the existing conversation rules
   * apply unchanged (LegalChatService.answerWaiting: the assistant answers
   * until a consultant has written).
   */
  private async sendOnMatter(
    wawuUserId: string,
    requestId: string,
    body: string,
  ): Promise<void> {
    await this.reserve(wawuUserId, null, 'matter_message', (tx) =>
      tx.legalChatMessage.create({
        data: { legalRequestId: requestId, authorRole: 'client', body },
      }),
    );
    await this.chat.answerWaiting(wawuUserId, requestId);
  }

  /**
   * The person's lock and the limit check live in `LegalAssistantAllowance`,
   * shared with the older matter-chat route so both draw on ONE allowance.
   */
  private lockPerson(tx: Prisma.TransactionClient, wawuUserId: string) {
    return this.allowance.lockPerson(tx, wawuUserId);
  }

  private reserve<T>(
    wawuUserId: string,
    intakeId: string | null,
    spend: Spend,
    write: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.allowance.reserve(wawuUserId, intakeId, spend, write);
  }

  /**
   * Claim the conversation for one paid call that no message pays for (a
   * retry of the reply, preparing the brief). One holder at a time; the claim
   * lapses by itself if the process holding it dies. Returns the lease the
   * holder set (its expiry time), or null when somebody else holds one. The
   * lease is the holder's token: `release` clears only a lease that is still
   * its own.
   */
  private async claim(intakeId: string): Promise<Date | null> {
    const now = new Date();
    const lease = new Date(now.getTime() + ASSISTANT_CLAIM_MS);
    const won = await this.prisma.legalIntake.updateMany({
      where: {
        id: intakeId,
        status: 'in_progress',
        legalRequestId: null,
        OR: [{ assistantBusyUntil: null }, { assistantBusyUntil: { lt: now } }],
      },
      data: { assistantBusyUntil: lease },
    });
    return won.count === 1 ? lease : null;
  }

  /**
   * Give the claim back, but only the holder's own. A call that outlived its
   * lease (a hung provider) finds the lease replaced by a second holder's and
   * leaves it alone, so its late failure cannot free a claim it no longer has.
   */
  private async release(intakeId: string, lease: Date): Promise<void> {
    await this.prisma.legalIntake.updateMany({
      where: { id: intakeId, assistantBusyUntil: lease },
      data: { assistantBusyUntil: null },
    });
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
      // The assistant's lines carry no em-dash, whatever was stored.
      body: m.authorRole === 'assistant' ? withoutEmDash(m.body) : m.body,
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
          body: r.authorRole === 'ai' ? withoutEmDash(r.body) : r.body,
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

  private busy() {
    return refusal(
      HttpStatus.CONFLICT,
      'assistant_busy',
      'The assistant is already working on this conversation. Wait a moment, then try again.',
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
