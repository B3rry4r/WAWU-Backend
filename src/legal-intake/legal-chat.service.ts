import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { LivePublisher } from '../live/live-publisher.service';
import {
  GEMINI_CLIENT,
  type GeminiClient,
} from '../common/ai/gemini-client.interface';
import { cleanAiText, withoutEmDash } from './ai-text';
import {
  LegalAssistantAllowance,
  consultantHasWritten,
  openerRunning,
} from './assistant/legal-assistant-allowance';
import { LEGAL_OPENER_WAIT_MS } from './assistant/legal-assistant-config';
import type { LegalBrief } from './legal-brief';

/**
 * How often a read waiting for another read's opener looks again (FIX-11).
 * How long it waits at most is `ASSISTANT_OPENER_WAIT_MS`.
 */
const OPENER_POLL_MS = 50;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type ChatRow = {
  id: string;
  authorRole: 'client' | 'ai' | 'consultant';
  body: string;
  createdAt: Date;
};

export interface ChatMessageView {
  id: string;
  authorRole: 'client' | 'ai' | 'consultant';
  body: string;
  createdAt: Date;
}

export interface ChatThreadView {
  legalRequestId: string;
  serviceName: string;
  status: string;
  /** True once a consultant has written in the thread. */
  consultantJoined: boolean;
  messages: ChatMessageView[];
}

/**
 * What the AI is, and is not, allowed to be.
 *
 * It is triage in the client's own words: it works through what the intake
 * left unclear and tells them what to expect. It is emphatically NOT the
 * lawyer. Somebody who has just paid a consultation fee will read whatever
 * answers them as advice unless it says otherwise, so the instruction makes
 * the model say otherwise, repeatedly and plainly, and refuse the questions
 * that need a professional.
 */
const CHAT_INSTRUCTION = [
  'You are the WAWUAfrica Legal assistant. You speak to a client who has paid for a consultation and is waiting for their consultant.',
  '',
  'You have their intake brief. Your job is to use the wait well: clarify what the brief left open, gather anything the consultant will need, and set expectations.',
  '',
  'Rules:',
  '- You are NOT a lawyer and you do not give legal advice. Say so plainly the first time it matters, without repeating it in every message.',
  "- Never tell the client what their legal position is, what they should do, what a document means for them, or what outcome to expect. That is the consultant's work.",
  '- When asked something that needs a lawyer, say it is exactly what the consultant will answer, and use the moment to collect what would help them answer it.',
  '- Ask one question at a time. This is a conversation, not a form.',
  '- Never invent a fact about their matter. If it is not in the brief or something they have said, ask.',
  '- Nigerian law is the default unless the brief says another jurisdiction.',
  '- Be brief and plain. Short paragraphs. No legal jargon, no preamble.',
  '- Never promise a timeline, a price, or an outcome.',
].join('\n');

/**
 * The conversation on a legal matter.
 *
 * One thread, two authors over time: the AI opens it once the consultation is
 * paid for, and a consultant continues in the same place from the dashboard.
 * The client is never moved to another screen and never repeats themselves —
 * which is the reason the profiling happens first at all.
 *
 * ONCE A CONSULTANT HAS SPOKEN, THE AI STOPS. A model continuing to answer
 * alongside a lawyer in the same thread is how a client ends up unable to
 * tell which replies were legal advice, and that ambiguity is not something
 * to leave in a record of a legal engagement.
 */
@Injectable()
export class LegalChatService {
  private readonly logger = new Logger(LegalChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(GEMINI_CLIENT) private readonly gemini: GeminiClient,
    private readonly allowance: LegalAssistantAllowance,
    @Inject(LEGAL_OPENER_WAIT_MS) private readonly openerWaitMs: number,
    private readonly live: LivePublisher,
  ) {}

  /**
   * The thread opens once the consultation is PAID FOR — not at intake.
   * Profiling is what a matter needs before it can be priced; the
   * conversation is what the client bought.
   */
  private static readonly OPEN_FROM = new Set([
    'consultation_scheduled',
    'consultation_done',
    'quoted',
    'contract_signed',
    'awaiting_service_payment',
    'in_progress',
    'delivered',
  ]);

  async getThread(
    wawuUserId: string,
    requestId: string,
  ): Promise<ChatThreadView> {
    // When this read began, before anything is awaited: an opener call that
    // ends after this moment is one this read was in flight for, so the read
    // never tries again after it (`LegalAssistantAllowance.reserveOpener`).
    const arrivedAt = new Date();
    const request = await this.findOwned(wawuUserId, requestId);
    let messages = await this.linesOf(requestId);

    // The opener is written on first read rather than at payment time, so a
    // client always finds something waiting rather than an empty box that
    // makes them go first about a problem they have already described.
    if (
      messages.length === 0 &&
      LegalChatService.OPEN_FROM.has(request.status)
    ) {
      messages = await this.openThread(request, arrivedAt);
    }

    return {
      legalRequestId: request.id,
      serviceName: request.serviceName,
      status: request.status,
      consultantJoined: messages.some((m) => m.authorRole === 'consultant'),
      messages: messages.map(toView),
    };
  }

  async send(
    wawuUserId: string,
    requestId: string,
    body: string,
  ): Promise<ChatThreadView> {
    const request = await this.findOwned(wawuUserId, requestId);
    if (!LegalChatService.OPEN_FROM.has(request.status)) {
      throw new ConflictException(
        'This conversation opens once your consultation is paid for.',
      );
    }

    // The message is counted and written in one step under the person's
    // lock, the same reservation `POST /legal/assistant/{id}/messages` uses
    // after Send, so both routes draw on ONE hourly allowance and parallel
    // posts cannot all pass the check before any is counted (LEGAL-01, D8).
    // Over the limit this is the same 429 `assistant_rate_limited` with
    // `retryAfterSeconds`. A request under the limit answers as it always did.
    // Once a consultant has written in this thread the message is for them:
    // it is neither counted nor refused (decided inside the same lock).
    await this.allowance.reserveMatterMessage(
      wawuUserId,
      requestId,
      (tx, createdAt) =>
        tx.legalChatMessage.create({
          data: {
            legalRequestId: requestId,
            authorRole: 'client',
            body: body.trim(),
            createdAt,
          },
        }),
    );

    await this.answerWaiting(wawuUserId, requestId);
    return this.getThread(wawuUserId, requestId);
  }

  /**
   * The assistant answers the client's newest message, unless the matter's
   * conversation is not open yet or a consultant has already written (the
   * AI's turn is over for good then). The message itself is already saved:
   * the caller writes it, so a caller that has to count it first (LEGAL-01's
   * hourly limit) can do both in one step. A provider failure is a 503 that
   * says the message was kept.
   */
  async answerWaiting(wawuUserId: string, requestId: string): Promise<void> {
    const request = await this.findOwned(wawuUserId, requestId);
    if (!LegalChatService.OPEN_FROM.has(request.status)) return;

    // Handover is one-way and permanent. Once a consultant has written here,
    // every later client message is for them. Asked of the WHOLE thread, by
    // the same query the reservation uses (a window of rows would miss a
    // consultant line past it, and the message would be free yet answered).
    if (await consultantHasWritten(this.prisma, requestId)) return;

    // The model sees the NEWEST 40 rows, in the order they were written.
    const history = (
      await this.prisma.legalChatMessage.findMany({
        where: { legalRequestId: requestId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 40,
      })
    ).reverse();

    try {
      const reply = cleanAiText(
        await this.gemini.chat({
          instruction: this.instructionWithBrief(request.details),
          history: history.map((m) => ({
            role:
              m.authorRole === 'client'
                ? ('user' as const)
                : ('model' as const),
            text: m.body,
          })),
        }),
      );
      if (!reply) throw new Error('The assistant answer was empty');
      await this.prisma.legalChatMessage.create({
        data: { legalRequestId: requestId, authorRole: 'ai', body: reply },
      });
    } catch (error) {
      // The client's own message is already saved, so nothing they wrote is
      // lost — the consultant will read it either way. Only the AI reply is
      // missing, and saying so is better than a silent dead end.
      this.logger.error(
        `Legal chat reply failed for ${requestId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw new ServiceUnavailableException(
        'Your message was saved and your consultant will see it. The assistant could not reply just now.',
      );
    }
  }

  /** A consultant replying from the dashboard. This is what ends the AI's turn. */
  async sendAsConsultant(
    requestId: string,
    adminId: string,
    body: string,
  ): Promise<ChatThreadView> {
    const request = await this.prisma.legalRequest.findUnique({
      where: { id: requestId },
    });
    if (!request) throw new NotFoundException('Legal request not found');

    // Under the client's lock, so the handover is ordered against their
    // messages (see `LegalAssistantAllowance.writeAsConsultant`).
    const written = await this.allowance.writeAsConsultant(
      request.wawuUserId,
      (tx, createdAt) =>
        tx.legalChatMessage.create({
          data: {
            legalRequestId: requestId,
            authorRole: 'consultant',
            authorAdminId: adminId,
            body: body.trim(),
            createdAt,
          },
        }),
    );
    // LEGAL-02: the client's phone learns the conversation changed (no words
    // travel); it reads them from the route. Never throws.
    await this.live.publish({
      kind: 'legal.thread',
      legalRequestId: requestId,
      messageId: written.id,
    });
    return this.threadFor(request);
  }

  /** The consultant's read. No ownership check — the admin guard is the gate. */
  async getThreadForOps(requestId: string): Promise<ChatThreadView> {
    const request = await this.prisma.legalRequest.findUnique({
      where: { id: requestId },
    });
    if (!request) throw new NotFoundException('Legal request not found');
    return this.threadFor(request);
  }

  /* ---------------------------------------------------------------- */

  private async threadFor(request: {
    id: string;
    serviceName: string;
    status: string;
  }): Promise<ChatThreadView> {
    const messages = await this.prisma.legalChatMessage.findMany({
      where: { legalRequestId: request.id },
      orderBy: { createdAt: 'asc' },
    });
    return {
      legalRequestId: request.id,
      serviceName: request.serviceName,
      status: request.status,
      consultantJoined: messages.some((m) => m.authorRole === 'consultant'),
      messages: messages.map(toView),
    };
  }

  /** The thread's lines, oldest first (the order every read has used). */
  private linesOf(requestId: string): Promise<ChatRow[]> {
    return this.prisma.legalChatMessage.findMany({
      where: { legalRequestId: requestId },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Write the opener on an empty, open thread, and answer with the thread's
   * lines afterwards (FIX-11).
   *
   * The opener is a paid AI call nobody typed, so a read may not multiply
   * it. The call is CLAIMED first, under the person's lock and in the same
   * step as their hourly limits (`LegalAssistantAllowance.reserveOpener`):
   * only the claim's holder calls the provider, and the call is counted like
   * every other assistant call. Parallel reads find the claim held and wait
   * for its opener instead of making their own, so twenty reads at once make
   * one call and all see the same opener. A read that was in flight while
   * a call ended without an opener answers the thread as it is; only a read
   * that arrives after that may try again, so a failing provider is called
   * once per batch of parallel reads, not once per read. Over a limit no
   * call is made and the thread is read as it is.
   */
  private async openThread(
    request: {
      id: string;
      wawuUserId: string;
      details: unknown;
    },
    arrivedAt: Date,
  ): Promise<ChatRow[]> {
    let claim;
    try {
      claim = await this.allowance.reserveOpener(
        request.wawuUserId,
        request.id,
        arrivedAt,
      );
    } catch (error) {
      // An empty thread is recoverable: a later read tries again once the
      // limit allows. Failing the whole screen over the opener is not.
      const limited =
        error instanceof HttpException &&
        error.getStatus() === Number(HttpStatus.TOO_MANY_REQUESTS);
      const why = `Legal chat opener for ${request.id} not attempted: ${
        error instanceof Error ? error.message : String(error)
      }`;
      if (limited) this.logger.log(why);
      else this.logger.warn(why);
      return this.linesOf(request.id);
    }
    if (claim.kind === 'opened' || claim.kind === 'ended') {
      return this.linesOf(request.id);
    }
    if (claim.kind === 'busy') return this.waitForOpener(request.id);

    let reply: string | null = null;
    try {
      const raw = await this.gemini.chat({
        instruction: this.instructionWithBrief(request.details),
        history: [
          {
            role: 'user',
            text: 'I have just paid for my consultation. Open the conversation: greet me briefly, show me you have read my intake by referring to it specifically, say plainly that you are an assistant and not my lawyer, and ask me the single most useful question while I wait.',
          },
        ],
      });
      reply = cleanAiText(raw) || null;
      if (!reply) throw new Error('The assistant opener was empty');
    } catch (error) {
      // The call ends as failed and frees the thread: an empty thread is
      // recoverable (a later read tries again, counted again), failing the
      // whole screen because an opener could not be written is not.
      reply = null;
      this.logger.warn(
        `Could not open legal chat for ${request.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const body = reply;
    try {
      await this.allowance.finishOpener(
        request.wawuUserId,
        request.id,
        claim.callId,
        body === null
          ? null
          : (tx, createdAt) =>
              tx.legalChatMessage.create({
                data: {
                  legalRequestId: request.id,
                  authorRole: 'ai',
                  body,
                  createdAt,
                },
              }),
      );
    } catch (error) {
      // The claim lapses on its own (ASSISTANT_CLAIM_MS); the read still
      // answers with the thread as it is.
      this.logger.warn(
        `Could not store the legal chat opener for ${request.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return this.linesOf(request.id);
  }

  /**
   * Another read holds the opener's claim: wait for its opener rather than
   * make a second call. Answers as soon as the thread has a line, or with
   * the thread as it is once no opener call is running (it failed) or the
   * wait (`ASSISTANT_OPENER_WAIT_MS`) is over. A read that waited never
   * calls the provider itself, so a failing provider is not called once per
   * waiting read.
   */
  private async waitForOpener(requestId: string): Promise<ChatRow[]> {
    const deadline = Date.now() + this.openerWaitMs;
    for (;;) {
      // Running is asked BEFORE the lines are read: the opener and the end
      // of its call are one write, so a call seen ended here has its opener
      // (if any) in the lines read next.
      const running = await openerRunning(this.prisma, requestId);
      const lines = await this.linesOf(requestId);
      if (lines.length > 0 || !running || Date.now() >= deadline) {
        return lines;
      }
      await sleep(OPENER_POLL_MS);
    }
  }

  /** The system instruction, with this matter's brief appended. */
  private instructionWithBrief(details: unknown): string {
    const brief = (details as { brief?: LegalBrief } | null)?.brief;
    if (!brief) return CHAT_INSTRUCTION;

    return [
      CHAT_INSTRUCTION,
      '',
      "--- The client's intake brief ---",
      `Matter: ${brief.matterLabel}`,
      '',
      'What they told us:',
      ...brief.facts.map((f) => `- ${f.question} ${f.answer}`),
      '',
      `Summary: ${brief.analysis.summary}`,
      brief.analysis.questionsToClarify.length > 0
        ? `Still unclear: ${brief.analysis.questionsToClarify.join('; ')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private async findOwned(wawuUserId: string, requestId: string) {
    const request = await this.prisma.legalRequest.findUnique({
      where: { id: requestId },
    });
    if (!request) throw new NotFoundException('Legal request not found');
    if (request.wawuUserId !== wawuUserId) {
      throw new ForbiddenException('This matter is not yours.');
    }
    return request;
  }
}

function toView(m: {
  id: string;
  authorRole: 'client' | 'ai' | 'consultant';
  body: string;
  createdAt: Date;
}): ChatMessageView {
  return {
    id: m.id,
    authorRole: m.authorRole,
    // A line the AI wrote before em-dashes were stripped on the way in is
    // still read without them.
    body: m.authorRole === 'ai' ? withoutEmDash(m.body) : m.body,
    createdAt: m.createdAt,
  };
}
