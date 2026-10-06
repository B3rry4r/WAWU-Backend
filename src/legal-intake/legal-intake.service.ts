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
import { PrismaService } from '../common/prisma/prisma.service';
import {
  GEMINI_CLIENT,
  type GeminiClient,
} from '../common/ai/gemini-client.interface';
import { GEMINI_MODEL } from '../common/ai/real-gemini.adapter';
import {
  BRIEF_INSTRUCTION,
  renderFacts,
  renderForModel,
  type LegalBrief,
} from './legal-brief';
import {
  isQuestionVisible,
  LEGAL_MATTER_VALUES,
  matterLabel,
  MATTER_TO_SERVICE_CODE,
  questionsForMatter,
  validQuestionIds,
  type IntakeQuestion,
  type LegalMatter,
} from './legal-intake-questions';
import { legalService } from '../legal/legal-catalogue';
import type { SaveAnswersDto } from './dto/legal-intake.dto';

/** What the app renders: the questions plus what has been answered so far. */
export interface IntakeView {
  id: string;
  matter: string;
  matterLabel: string;
  status: string;
  answers: Record<string, unknown>;
  documents: string[];
  /** Only the questions this person should see, given their answers. */
  questions: IntakeQuestion[];
  /** Ids still needed before the intake can be completed. */
  outstandingRequired: string[];
  brief: LegalBrief | null;
  /**
   * The request this intake became. Set on completion — the profiling is not
   * a survey that ends in a thank-you, it is how a matter enters the legal
   * lifecycle, and this is the id the client's own matter screen uses.
   */
  legalRequestId: string | null;
}

// Imported, not re-derived. This had its own copy of the default, so the
// brief recorded `generatedBy: gemini-2.0-flash` while the adapter was free
// to call something else entirely — a provenance field that quietly lied
// about which model wrote the analysis a lawyer was reading.

/**
 * Legal profiling.
 *
 * The order this enforces is the whole feature. Before it, somebody with a
 * legal problem picked a service off a price list and the first thing WAWU
 * said to them was a consultation fee. Now they answer two or three minutes
 * of mostly tap-to-answer questions, a brief is generated, and the consultant
 * has read it before the conversation starts — so the client never tells
 * their story twice and nobody is quoted before anybody understands what they
 * need.
 */
@Injectable()
export class LegalIntakeService {
  private readonly logger = new Logger(LegalIntakeService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(GEMINI_CLIENT) private readonly gemini: GeminiClient,
  ) {}

  /**
   * Start, or resume.
   *
   * Resuming rather than always creating is deliberate: people abandon a form
   * halfway and come back, and losing eight answers because somebody closed a
   * tab is how an intake gets a reputation for being long.
   */
  async start(wawuUserId: string, matter: string): Promise<IntakeView> {
    if (!(LEGAL_MATTER_VALUES as string[]).includes(matter)) {
      throw new BadRequestException('Unknown legal matter');
    }

    const existing = await this.prisma.legalIntake.findFirst({
      // `channel: null` is the question form. A chat intake (LEGAL-01) is
      // never resumed here, or the web's form would open on somebody's chat.
      where: { wawuUserId, matter, status: 'in_progress', channel: null },
      orderBy: { startedAt: 'desc' },
    });
    if (existing) return this.toView(existing);

    const created = await this.prisma.legalIntake.create({
      data: { wawuUserId, matter, answers: {}, documents: [] },
    });
    return this.toView(created);
  }

  /** Everything this person has started or finished. */
  async listMine(wawuUserId: string): Promise<IntakeView[]> {
    const rows = await this.prisma.legalIntake.findMany({
      // The form's list. A chat intake is listed by its own route.
      where: { wawuUserId, channel: null },
      orderBy: { startedAt: 'desc' },
    });
    return rows.map((r) => this.toView(r));
  }

  async getOwned(wawuUserId: string, id: string): Promise<IntakeView> {
    return this.toView(await this.findOwned(wawuUserId, id));
  }

  /**
   * Save answers as they go.
   *
   * Answers are MERGED, not replaced, so the app can send one question at a
   * time and a dropped request loses that answer rather than the whole
   * intake. Unknown question ids are rejected: `answers` is Json, and without
   * this check it would accept any shape at all and the brief would render
   * keys nobody was ever asked.
   */
  async saveAnswers(
    wawuUserId: string,
    id: string,
    dto: SaveAnswersDto,
  ): Promise<IntakeView> {
    const intake = await this.findOwned(wawuUserId, id);
    this.refuseChatIntake(intake);
    if (intake.status !== 'in_progress') {
      throw new ConflictException(
        'This intake has already been completed and cannot be edited.',
      );
    }

    const valid = validQuestionIds(intake.matter);
    const unknown = Object.keys(dto.answers).filter((k) => !valid.has(k));
    if (unknown.length > 0) {
      throw new BadRequestException(
        `Not a question on this intake: ${unknown.join(', ')}`,
      );
    }

    const merged = {
      ...(intake.answers as Record<string, unknown>),
      ...dto.answers,
    };

    const updated = await this.prisma.legalIntake.update({
      where: { id },
      data: {
        answers: merged as never,
        ...(dto.documents ? { documents: dto.documents } : {}),
      },
    });
    return this.toView(updated);
  }

  /**
   * Finish, and generate the brief.
   *
   * A FAILED GENERATION FAILS THE CALL. The intake stays `in_progress` and
   * the client is told to try again, rather than being handed to a consultant
   * with an empty brief that looks like a considered "nothing to flag". The
   * consultant's whole reason to trust this screen is that something read the
   * intake; silently shipping a blank would break that on the one occasion it
   * mattered.
   */
  async complete(wawuUserId: string, id: string): Promise<IntakeView> {
    const intake = await this.findOwned(wawuUserId, id);
    this.refuseChatIntake(intake);
    if (intake.status !== 'in_progress') {
      throw new ConflictException(
        'This intake is already complete and has been sent to a consultant.',
      );
    }

    const answers = intake.answers as Record<string, unknown>;
    const outstanding = this.outstandingRequired(intake.matter, answers);
    if (outstanding.length > 0) {
      throw new BadRequestException(
        `Still needed before this can be sent: ${outstanding.join(', ')}`,
      );
    }

    const facts = renderFacts(intake.matter, answers);
    let analysis;
    try {
      analysis = await this.gemini.generateBrief({
        instruction: BRIEF_INSTRUCTION,
        content: renderForModel(intake.matter, facts, intake.documents.length),
      });
    } catch (error) {
      // The message is logged without the transcript — that is somebody's
      // legal problem and it does not belong in a log line.
      this.logger.error(
        `Brief generation failed for intake ${id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw new ServiceUnavailableException(
        'We could not prepare your summary just now. Your answers are saved — please try again in a moment.',
      );
    }

    if (!analysis.summary) {
      throw new ServiceUnavailableException(
        'We could not prepare your summary just now. Your answers are saved — please try again in a moment.',
      );
    }

    const brief: LegalBrief = {
      matter: intake.matter,
      matterLabel: matterLabel(intake.matter),
      facts,
      documentCount: intake.documents.length,
      analysis,
      generatedBy: GEMINI_MODEL,
      generatedAt: new Date().toISOString(),
    };

    const updated = await this.openRequest(intake, brief, answers);
    return this.toView(updated);
  }

  /**
   * The profiling becomes a REQUEST, in one transaction with the brief.
   *
   * This is the join the whole feature turns on, and without it the intake
   * was a survey that ended in a thank-you: a brief was written, the client
   * was told a consultant would read it, and nothing entered the queue a
   * consultant actually works. `legalRequestId` was a column nothing wrote.
   *
   * The matter maps to a catalogue service so the request lands in the
   * existing lifecycle (pricing, engagement letter, delivery) rather than
   * beside it. The consultant refines the exact service; a client should
   * not have to know that "contract drafting or review" is two priced lines
   * before anybody has heard their problem.
   *
   * The brief and the answers travel INTO the request's own `details`, so
   * the matter carries its own context even if it is later reassigned.
   *
   * Shared by the question form (`complete`) and the chat
   * (`LegalAssistantService.sendToConsultant`): one way for a matter to enter
   * the queue. The intake is claimed first, with a conditional update, so two
   * sends racing each other open one matter, not two.
   */
  async openRequest(
    intake: {
      id: string;
      wawuUserId: string;
      matter: string;
      documents: string[];
    },
    brief: LegalBrief,
    answers: Record<string, unknown>,
  ) {
    const serviceCode = MATTER_TO_SERVICE_CODE[intake.matter as LegalMatter];
    const service = legalService(serviceCode);
    if (!service) {
      // A matter that maps to nothing is a data bug, not a client error.
      this.logger.error(
        `Matter ${intake.matter} maps to unknown service ${serviceCode}`,
      );
      throw new ServiceUnavailableException(
        'We could not open your matter just now. Your answers are saved — please try again in a moment.',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.legalIntake.updateMany({
        where: { id: intake.id, status: 'in_progress' },
        data: {
          status: 'converted',
          completedAt: new Date(),
          brief: brief as never,
        },
      });
      if (claimed.count === 0) {
        throw new ConflictException(
          'This intake is already complete and has been sent to a consultant.',
        );
      }
      const created = await tx.legalRequest.create({
        data: {
          wawuUserId: intake.wawuUserId,
          serviceCode: service.code,
          serviceName: service.name,
          category: service.category,
          path: service.path,
          details: { intakeId: intake.id, brief, answers } as never,
          documents: intake.documents,
          // Always `awaiting_quote`, whatever the catalogue price says. The
          // point of profiling first is that nobody is quoted before a human
          // has read what they need; starting a profiled matter at `quoted`
          // would put the price back in front of the understanding.
          status: 'awaiting_quote',
        },
      });
      return tx.legalIntake.update({
        where: { id: intake.id },
        data: { legalRequestId: created.id },
      });
    });
  }

  /** The form routes do not touch a chat intake: it is sent from the chat. */
  private refuseChatIntake(intake: { channel: string | null }) {
    if (intake.channel !== null) {
      throw new ConflictException(
        'This conversation is sent from the chat, not the question form.',
      );
    }
  }

  /* ---------------------------------------------------------------- */

  private async findOwned(wawuUserId: string, id: string) {
    const intake = await this.prisma.legalIntake.findUnique({ where: { id } });
    if (!intake) throw new NotFoundException('Intake not found');
    if (intake.wawuUserId !== wawuUserId) {
      // An intake holds somebody's legal problem. Ownership is checked on
      // every read, not just the writes.
      throw new ForbiddenException('This intake is not yours.');
    }
    return intake;
  }

  /** Required questions that are visible and still unanswered. */
  private outstandingRequired(
    matter: string,
    answers: Record<string, unknown>,
  ): string[] {
    return questionsForMatter(matter)
      .filter((q) => q.level === 'required')
      .filter((q) => isQuestionVisible(q, answers))
      .filter((q) => {
        const v = answers[q.id];
        if (v === null || v === undefined || v === '') return true;
        if (Array.isArray(v) && v.length === 0) return true;
        return false;
      })
      .map((q) => q.id);
  }

  private toView(intake: {
    id: string;
    matter: string;
    status: string;
    answers: unknown;
    documents: string[];
    brief: unknown;
    legalRequestId?: string | null;
  }): IntakeView {
    const answers = (intake.answers ?? {}) as Record<string, unknown>;
    return {
      id: intake.id,
      matter: intake.matter,
      matterLabel: matterLabel(intake.matter),
      status: intake.status,
      answers,
      documents: intake.documents,
      // Only what they should see. The app renders this list and nothing else,
      // which is what makes the intake adaptive without the app knowing any
      // of the rules.
      questions: questionsForMatter(intake.matter).filter((q) =>
        isQuestionVisible(q, answers),
      ),
      outstandingRequired: this.outstandingRequired(intake.matter, answers),
      brief: (intake.brief as LegalBrief | null) ?? null,
      legalRequestId: intake.legalRequestId ?? null,
    };
  }
}
