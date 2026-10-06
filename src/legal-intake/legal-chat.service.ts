import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  GEMINI_CLIENT,
  type GeminiClient,
} from '../common/ai/gemini-client.interface';
import type { LegalBrief } from './legal-brief';
import { HISTORY_WINDOW, plainDashes } from './assistant/legal-assistant';
import {
  consultantNameFor,
  loadThreadMessages,
  type ChatMessageView,
  type ThreadRow,
} from './legal-thread';

export type { ChatMessageView };

export interface ChatThreadView {
  legalRequestId: string;
  serviceName: string;
  status: string;
  /** True once a consultant has written in the thread. */
  consultantJoined: boolean;
  /** The first name of the consultant who joined, or null before then. */
  consultantName: string | null;
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
  ...chatRules(),
].join('\n');

/**
 * The same assistant before any payment (LEGAL-01): the brief has been sent
 * and a consultant has not yet written. Nothing has been charged, so it must
 * not talk as if it had, and it must keep to the line the chat before the
 * brief keeps: no price, no advice.
 */
const UNPAID_CHAT_INSTRUCTION = [
  'You are the WAWU Legal Assistant. You speak to a client who has sent their matter to a consultant and is waiting for the consultant to read it. Nothing has been charged, and no price is quoted until a consultant has read the brief.',
  '',
  'You have their brief. Your job is to use the wait well: clarify what the brief left open, gather anything the consultant will need, and set expectations.',
  '',
  ...chatRules(),
  '- Never mention a price or a fee unless they ask. If they ask, say a consultant will quote once they have read the brief, and that you cannot give a price.',
].join('\n');

function chatRules(): string[] {
  return [
    'Rules:',
    '- You are NOT a lawyer and you do not give legal advice. Say so plainly the first time it matters, without repeating it in every message.',
    "- Never tell the client what their legal position is, what they should do, what a document means for them, or what outcome to expect. That is the consultant's work.",
    '- When asked something that needs a lawyer, say it is exactly what the consultant will answer, and use the moment to collect what would help them answer it.',
    '- Ask one question at a time. This is a conversation, not a form.',
    '- Never invent a fact about their matter. If it is not in the brief or something they have said, ask.',
    '- Nigerian law is the default unless the brief says another jurisdiction.',
    '- Be brief and plain. Short paragraphs. No legal jargon, no preamble.',
    '- Never promise a timeline, a price, or an outcome.',
  ];
}

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
  ) {}

  /**
   * The thread opens once the consultation is PAID FOR, or earlier for a
   * matter that came from a chat or form intake (LEGAL-01, R-14): the person
   * has already told their story, a consultant can join before any payment,
   * and the assistant keeps them company until one does. A request that came
   * from nowhere near an intake (the web's own) keeps the old rule.
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

  /** Before payment: the matter is open to a consultant, nothing is charged. */
  private static readonly OPEN_UNPAID_FROM = new Set([
    'awaiting_quote',
    'awaiting_consultation_payment',
  ]);

  /** Whether a conversation exists yet, and whether anything has been paid. */
  private async openState(request: {
    id: string;
    status: string;
  }): Promise<{ open: boolean; paid: boolean }> {
    if (LegalChatService.OPEN_FROM.has(request.status)) {
      return { open: true, paid: true };
    }
    if (LegalChatService.OPEN_UNPAID_FROM.has(request.status)) {
      const fromIntake = await this.prisma.legalIntake.count({
        where: { legalRequestId: request.id },
      });
      if (fromIntake > 0) return { open: true, paid: false };
    }
    return { open: false, paid: false };
  }

  async getThread(
    wawuUserId: string,
    requestId: string,
  ): Promise<ChatThreadView> {
    const request = await this.findOwned(wawuUserId, requestId);
    const messages = await loadThreadMessages(this.prisma, {
      legalRequestId: requestId,
    });
    const { open, paid } = await this.openState(request);

    // The opener is written on first read rather than at payment time, so a
    // client always finds something waiting rather than an empty box that
    // makes them go first about a problem they have already described. A
    // matter whose brief was written in the chat already has its thread.
    if (messages.length === 0 && open) {
      const opener = await this.openThread(request, paid);
      if (opener) messages.push(opener);
    }

    return this.viewOf(request, messages);
  }

  async send(
    wawuUserId: string,
    requestId: string,
    body: string,
  ): Promise<ChatThreadView> {
    const request = await this.findOwned(wawuUserId, requestId);
    const { open, paid } = await this.openState(request);
    if (!open) {
      throw new ConflictException(
        'This conversation opens once your consultation is paid for.',
      );
    }

    await this.prisma.legalChatMessage.create({
      data: {
        legalRequestId: requestId,
        authorRole: 'client',
        body: body.trim(),
      },
    });

    const history = (
      await loadThreadMessages(this.prisma, { legalRequestId: requestId })
    ).slice(-HISTORY_WINDOW);

    // Handover is one-way and permanent. Once a consultant has written here,
    // every later client message is for them.
    if (history.some((m) => m.authorRole === 'consultant')) {
      return this.getThread(wawuUserId, requestId);
    }

    try {
      const reply = await this.gemini.chat({
        instruction: this.instructionWithBrief(request.details, paid),
        history: history.map((m) => ({
          role:
            m.authorRole === 'client' ? ('user' as const) : ('model' as const),
          text: m.body,
        })),
      });
      await this.prisma.legalChatMessage.create({
        data: {
          legalRequestId: requestId,
          authorRole: 'ai',
          body: plainDashes(reply),
        },
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

    return this.getThread(wawuUserId, requestId);
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

    await this.prisma.legalChatMessage.create({
      data: {
        legalRequestId: requestId,
        authorRole: 'consultant',
        authorAdminId: adminId,
        body: body.trim(),
      },
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
    const messages = await loadThreadMessages(this.prisma, {
      legalRequestId: request.id,
    });
    return this.viewOf(request, messages);
  }

  private async viewOf(
    request: { id: string; serviceName: string; status: string },
    messages: ThreadRow[],
  ): Promise<ChatThreadView> {
    const consultantJoined = messages.some(
      (m) => m.authorRole === 'consultant',
    );
    return {
      legalRequestId: request.id,
      serviceName: request.serviceName,
      status: request.status,
      consultantJoined,
      consultantName: consultantJoined
        ? await consultantNameFor(this.prisma, messages)
        : null,
      messages: messages.map(toView),
    };
  }

  private async openThread(
    request: { id: string; details: unknown },
    paid: boolean,
  ): Promise<ThreadRow | null> {
    try {
      const reply = await this.gemini.chat({
        instruction: this.instructionWithBrief(request.details, paid),
        history: [
          {
            role: 'user',
            text: paid
              ? 'I have just paid for my consultation. Open the conversation: greet me briefly, show me you have read my intake by referring to it specifically, say plainly that you are an assistant and not my lawyer, and ask me the single most useful question while I wait.'
              : 'I have just sent my matter to a consultant. Open the conversation: greet me briefly, show me you have read my brief by referring to it specifically, say plainly that you are an assistant and not my lawyer, and ask me the single most useful question while I wait.',
          },
        ],
      });
      const created = await this.prisma.legalChatMessage.create({
        data: {
          legalRequestId: request.id,
          authorRole: 'ai',
          body: plainDashes(reply),
        },
      });
      return { ...created, authorAdminId: null };
    } catch (error) {
      // An empty thread is recoverable — the next read tries again. Failing
      // the whole screen because an opener could not be written is not.
      this.logger.warn(
        `Could not open legal chat for ${request.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  /** The system instruction, with this matter's brief appended. */
  private instructionWithBrief(details: unknown, paid: boolean): string {
    const base = paid ? CHAT_INSTRUCTION : UNPAID_CHAT_INSTRUCTION;
    const brief = (details as { brief?: LegalBrief } | null)?.brief;
    if (!brief) return base;

    return [
      base,
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

function toView(m: ChatMessageView): ChatMessageView {
  return {
    id: m.id,
    authorRole: m.authorRole,
    body: m.body,
    createdAt: m.createdAt,
  };
}
