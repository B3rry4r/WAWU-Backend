import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  GEMINI_CLIENT,
  type GeminiBrief,
  type GeminiClient,
} from '../../common/ai/gemini-client.interface';
import { GEMINI_MODEL } from '../../common/ai/real-gemini.adapter';
import { BRIEF_INSTRUCTION, type LegalBrief } from '../legal-brief';
import { matterLabel } from '../legal-intake-questions';
import {
  ASSISTANT_CHANNEL,
  ASSISTANT_GREETING,
  ASSISTANT_INSTRUCTION,
  DEFAULT_ASSISTANT_MATTER,
  FACTS_INSTRUCTION,
  HISTORY_WINDOW,
  MAX_CLIENT_MESSAGES,
  TRANSCRIPT_NOTE,
  assistantOptions,
  parseFacts,
  plainDashes,
  readReply,
  renderTranscript,
  type LegalAssistantOptionsView,
} from './legal-assistant';
import { LegalIntakeService } from '../legal-intake.service';
import {
  consultantNameFor,
  loadThreadMessages,
  type ChatMessageView,
} from '../legal-thread';
import type {
  SendAssistantMessageDto,
  StartAssistantDto,
} from '../dto/legal-intake.dto';

/** What the app renders for the chat that writes the brief. */
export interface LegalAssistantView {
  id: string;
  /** `in_progress` while the brief is being written, `converted` once sent. */
  status: string;
  matter: string;
  matterLabel: string;
  /** Oldest first. Before and after the intake was sent, as one thread. */
  messages: ChatMessageView[];
  /** The assistant has said it has what a consultant needs. */
  briefReady: boolean;
  /** The last message is the person's and nothing has answered it yet. */
  awaitingReply: boolean;
  /** The brief card (S16), or null until one has been written. */
  brief: LegalBrief | null;
  /**
   * The brief covers everything the person has said. False once they add
   * something after it was written: it has to be written again before it can
   * be sent, so a consultant never reads a summary the person did not check.
   */
  briefCurrent: boolean;
  /** Set when the brief has been sent: the matter the chat continues on. */
  legalRequestId: string | null;
  /** A consultant has written in the thread, so the assistant has stopped. */
  consultantJoined: boolean;
  /** The first name of the consultant who joined, for the handover line. */
  consultantName: string | null;
}

/**
 * The chat that writes the brief, before anyone pays.
 *
 * ORDER IS THE FEATURE (R-14). The person describes the problem to the WAWU
 * Legal Assistant; the assistant asks what a consultant would ask; a brief is
 * written from the conversation and shown to the person to check; sending it
 * opens the matter in the consultant's queue with nothing charged and no price
 * quoted. A consultant who writes in the thread ends the assistant's turn,
 * the same one-way handover the paid chat has.
 *
 * Every write checks ownership, the channel and the state, and every model
 * failure is a plain 503 that leaves what the person wrote saved.
 */
@Injectable()
export class LegalAssistantService {
  private readonly logger = new Logger(LegalAssistantService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly intakes: LegalIntakeService,
    @Inject(GEMINI_CLIENT) private readonly gemini: GeminiClient,
  ) {}

  options(): LegalAssistantOptionsView {
    return assistantOptions();
  }

  /**
   * Start the conversation, or pick up the one this person already has open.
   * Serialised per person with an advisory lock, so a double tap on "start"
   * cannot leave two open conversations.
   */
  async start(
    wawuUserId: string,
    dto: StartAssistantDto,
  ): Promise<LegalAssistantView> {
    const matter = dto.matter ?? DEFAULT_ASSISTANT_MATTER;
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`legal-assistant:${wawuUserId}`}))`;
      const open = await tx.legalIntake.findFirst({
        where: {
          wawuUserId,
          channel: ASSISTANT_CHANNEL,
          status: 'in_progress',
        },
        orderBy: { startedAt: 'desc' },
      });
      if (open) return open;
      const created = await tx.legalIntake.create({
        data: {
          wawuUserId,
          matter,
          channel: ASSISTANT_CHANNEL,
          answers: {},
          documents: [],
        },
      });
      await tx.legalIntakeMessage.create({
        data: {
          legalIntakeId: created.id,
          wawuUserId,
          authorRole: 'ai',
          body: ASSISTANT_GREETING,
        },
      });
      return created;
    });
    return this.view(row);
  }

  /** The person's own conversations that are still being written, if any. */
  async current(wawuUserId: string): Promise<LegalAssistantView | null> {
    const open = await this.prisma.legalIntake.findFirst({
      where: { wawuUserId, channel: ASSISTANT_CHANNEL, status: 'in_progress' },
      orderBy: { startedAt: 'desc' },
    });
    return open ? this.view(open) : null;
  }

  async get(wawuUserId: string, id: string): Promise<LegalAssistantView> {
    return this.view(await this.findOwned(wawuUserId, id));
  }

  /**
   * The person says something. It is saved first, so nothing they wrote is
   * lost if the assistant cannot answer, then the assistant replies unless a
   * consultant has already joined (then it is for the consultant).
   */
  async send(
    wawuUserId: string,
    id: string,
    dto: SendAssistantMessageDto,
  ): Promise<LegalAssistantView> {
    const intake = await this.findOwned(wawuUserId, id);
    if (intake.status !== 'in_progress') {
      // Sent: the conversation carries on where the consultant is.
      throw new ConflictException(
        'This conversation has been sent to a consultant. Message them in the matter.',
      );
    }

    const sent = await this.prisma.legalIntakeMessage.count({
      where: { legalIntakeId: id, authorRole: 'client' },
    });
    if (sent >= MAX_CLIENT_MESSAGES) {
      throw new ConflictException(
        'This conversation is long enough. Ask for your summary and send it to a consultant, who can take it from here.',
      );
    }

    await this.prisma.legalIntakeMessage.create({
      data: {
        legalIntakeId: id,
        wawuUserId,
        authorRole: 'client',
        body: dto.body.trim(),
      },
    });

    // A quick reply names the matter. It only fills in a matter nothing has
    // named yet, so a stray tap later never overwrites what was settled.
    if (dto.matter && intake.matter === DEFAULT_ASSISTANT_MATTER) {
      await this.prisma.legalIntake.update({
        where: { id },
        data: { matter: dto.matter },
      });
    }

    await this.reply(id, wawuUserId);
    return this.get(wawuUserId, id);
  }

  /**
   * Ask the assistant to answer again, after a message went unanswered
   * because the model could not be reached. Only valid while the last message
   * is the person's.
   */
  async retryReply(
    wawuUserId: string,
    id: string,
  ): Promise<LegalAssistantView> {
    const intake = await this.findOwned(wawuUserId, id);
    if (intake.status !== 'in_progress') {
      throw new ConflictException(
        'This conversation has been sent to a consultant. Message them in the matter.',
      );
    }
    const last = await this.prisma.legalIntakeMessage.findFirst({
      where: { legalIntakeId: id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    if (!last || last.authorRole !== 'client') {
      throw new ConflictException('There is nothing waiting for a reply.');
    }
    await this.reply(id, wawuUserId);
    return this.get(wawuUserId, id);
  }

  /**
   * Write the brief from the conversation (S16) and keep it on the intake.
   *
   * Callable again after the person adds something, which replaces the brief.
   * A failed generation fails the call and leaves the previous brief as it
   * was: a consultant is never handed a blank that reads like "nothing to
   * flag".
   */
  async writeBrief(
    wawuUserId: string,
    id: string,
  ): Promise<LegalAssistantView> {
    const intake = await this.findOwned(wawuUserId, id);
    if (intake.status !== 'in_progress') {
      throw new ConflictException(
        'This conversation has already been sent to a consultant.',
      );
    }

    const messages = await this.prisma.legalIntakeMessage.findMany({
      where: { legalIntakeId: id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const said = messages.filter((m) => m.authorRole === 'client');
    if (said.length === 0) {
      throw new BadRequestException(
        'Tell the assistant what is going on first, then ask for your summary.',
      );
    }

    const transcript = renderTranscript(messages.slice(-HISTORY_WINDOW));

    let facts;
    let analysis: GeminiBrief;
    try {
      [facts, analysis] = await Promise.all([
        this.extractFacts(transcript),
        this.gemini.generateBrief({
          instruction: `${BRIEF_INSTRUCTION}\n- ${TRANSCRIPT_NOTE}`,
          content: [
            `Matter: ${matterLabel(intake.matter)}`,
            '',
            'Conversation transcript:',
            transcript,
            '',
            'The client attached no documents.',
          ].join('\n'),
        }),
      ]);
    } catch (error) {
      // The transcript is somebody's legal problem; it stays out of the log.
      this.logger.error(
        `Brief generation failed for assistant intake ${id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw new ServiceUnavailableException(
        'We could not prepare your summary just now. What you wrote is saved. Please try again in a moment.',
      );
    }
    if (!facts || !analysis.summary) {
      throw new ServiceUnavailableException(
        'We could not prepare your summary just now. What you wrote is saved. Please try again in a moment.',
      );
    }

    // The model's reading of the matter replaces the placeholder or a quick
    // reply, but never settles on "something else" over a matter already named.
    const matter =
      facts.matter && facts.matter !== DEFAULT_ASSISTANT_MATTER
        ? facts.matter
        : intake.matter;

    const brief: LegalBrief = {
      matter,
      matterLabel: matterLabel(matter),
      facts: facts.facts,
      documentCount: 0,
      analysis: {
        summary: plainDashes(analysis.summary),
        keyIssues: analysis.keyIssues.map(plainDashes),
        questionsToClarify: analysis.questionsToClarify.map(plainDashes),
        risks: analysis.risks.map(plainDashes),
      },
      generatedBy: GEMINI_MODEL,
      generatedAt: new Date().toISOString(),
    };

    // Only while it is still being written: a send racing this call must not
    // have its sent brief replaced under it.
    const written = await this.prisma.legalIntake.updateMany({
      where: { id, status: 'in_progress' },
      data: { matter, brief: brief as never },
    });
    if (written.count === 0) {
      throw new ConflictException(
        'This conversation has already been sent to a consultant.',
      );
    }
    return this.get(wawuUserId, id);
  }

  /**
   * Send the brief to a consultant. The matter opens in their queue, awaiting
   * a quote, with nothing charged. Sending twice returns the same matter.
   */
  async sendToConsultant(
    wawuUserId: string,
    id: string,
  ): Promise<LegalAssistantView> {
    const intake = await this.findOwned(wawuUserId, id);
    if (intake.status === 'converted') return this.view(intake);
    if (intake.status !== 'in_progress') {
      throw new ConflictException('This conversation cannot be sent.');
    }

    const brief = intake.brief as LegalBrief | null;
    if (!brief) {
      throw new ConflictException(
        'Ask for your summary first, check it, then send it.',
      );
    }
    const lastSaid = await this.prisma.legalIntakeMessage.findFirst({
      where: { legalIntakeId: id, authorRole: 'client' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    if (
      lastSaid &&
      lastSaid.createdAt.getTime() > Date.parse(brief.generatedAt)
    ) {
      throw new ConflictException(
        'You added something after your summary was written. Ask for it again so it covers everything, then send it.',
      );
    }

    const updated = await this.intakes.openRequest(intake, brief, {});
    return this.view(updated);
  }

  /* ---------------------------------------------------------------- */

  /** One assistant turn. Skipped when a consultant has joined. */
  private async reply(id: string, wawuUserId: string): Promise<void> {
    const messages = await this.prisma.legalIntakeMessage.findMany({
      where: { legalIntakeId: id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    // Before sending nobody but the person and the assistant can be here, but
    // the one-way handover is checked on the record, never assumed.
    if (messages.some((m) => m.authorRole === 'consultant')) return;

    let raw: string;
    try {
      raw = await this.gemini.chat({
        instruction: ASSISTANT_INSTRUCTION,
        history: messages.slice(-HISTORY_WINDOW).map((m) => ({
          role:
            m.authorRole === 'client' ? ('user' as const) : ('model' as const),
          text: m.body,
        })),
      });
    } catch (error) {
      this.logger.error(
        `Assistant reply failed for intake ${id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw new ServiceUnavailableException(
        'Your message was saved. The assistant could not reply just now. Please try again in a moment.',
      );
    }

    const { text, ready } = readReply(raw);
    if (!text) {
      throw new ServiceUnavailableException(
        'Your message was saved. The assistant could not reply just now. Please try again in a moment.',
      );
    }
    await this.prisma.legalIntakeMessage.create({
      data: { legalIntakeId: id, wawuUserId, authorRole: 'ai', body: text },
    });
    if (ready) {
      await this.prisma.legalIntake.update({
        where: { id },
        data: { assistantReadyAt: new Date() },
      });
    }
  }

  private async extractFacts(transcript: string) {
    const raw = await this.gemini.chat({
      instruction: FACTS_INSTRUCTION,
      history: [{ role: 'user', text: transcript }],
    });
    return parseFacts(raw);
  }

  private async findOwned(wawuUserId: string, id: string) {
    const intake = await this.prisma.legalIntake.findUnique({ where: { id } });
    // A form intake is not a chat: it does not exist on these routes.
    if (!intake || intake.channel !== ASSISTANT_CHANNEL) {
      throw new NotFoundException('Conversation not found');
    }
    if (intake.wawuUserId !== wawuUserId) {
      throw new ForbiddenException('This conversation is not yours.');
    }
    return intake;
  }

  private async view(intake: {
    id: string;
    status: string;
    matter: string;
    brief: unknown;
    legalRequestId: string | null;
    assistantReadyAt: Date | null;
  }): Promise<LegalAssistantView> {
    const messages = await loadThreadMessages(this.prisma, {
      legalIntakeId: intake.id,
      legalRequestId: intake.legalRequestId,
    });
    const brief = (intake.brief as LegalBrief | null) ?? null;
    const last = messages[messages.length - 1];
    const lastSaid = [...messages]
      .reverse()
      .find((m) => m.authorRole === 'client');
    const consultantJoined = messages.some(
      (m) => m.authorRole === 'consultant',
    );

    return {
      id: intake.id,
      status: intake.status,
      matter: intake.matter,
      matterLabel: matterLabel(intake.matter),
      messages: messages.map((m) => ({
        id: m.id,
        authorRole: m.authorRole,
        body: m.body,
        createdAt: m.createdAt,
      })),
      briefReady: intake.assistantReadyAt !== null,
      awaitingReply: !consultantJoined && last?.authorRole === 'client',
      brief,
      briefCurrent:
        brief !== null &&
        (!lastSaid ||
          lastSaid.createdAt.getTime() <= Date.parse(brief.generatedAt)),
      legalRequestId: intake.legalRequestId,
      consultantJoined,
      consultantName: consultantJoined
        ? await consultantNameFor(this.prisma, messages)
        : null,
    };
  }
}
