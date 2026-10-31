import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type {
  Prisma,
  ReceptionistAgent,
  AiToolJob,
} from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import { PLANS_CONFIG, type PlansConfig } from '../../plans/plans-config';
import { PointsError } from '../../points/points-error';
import { PointsService } from '../../points/points.service';
import { JOB_MAX_RUN_SETTING } from '../../points/spend/points-hold-sweep.service';
import { PointsJobQuoteToken } from '../../points/spend/points-job-quote-token';
import {
  jobHoldReference,
  PointsSpendService,
} from '../../points/spend/points-spend.service';
import { lockPersonPoints } from '../../points/points-lock';
import { AiToolError, UNAVAILABLE_MESSAGE } from '../ai-tools-error';
import { jobIdFor } from '../ai-job-id';
import { AiInputService } from '../input/ai-input-files';
import { isListed } from '../tools/ai-tool';
import {
  RECEPTIONIST_TOOL,
  RECEPTIONIST_VOICE_ACTION,
} from '../tools/receptionist.tool';
import { podcastLinkOk } from '../tools/podcast.tool';
import {
  CONVERSATION_GIVE_UP_MS,
  copyOfMarker,
  markerOf,
  ProviderCopyService,
} from '../voice/provider-copy.service';
import {
  AI_VOICE_PROVIDER,
  AiVoiceProviderError,
  type AiVoiceProvider,
  type AgentSpec,
  type ChatTurn,
} from '../voice/ai-voice-provider';
import type {
  ReceptionistKnowledgeView,
  ReceptionistRemovedView,
  ReceptionistView,
  VoiceSessionView,
} from './receptionist-view.type';
import type { AddKnowledgeDto, SaveReceptionistDto } from './receptionist.dto';
import { isUniqueViolation } from '../../money/prisma-unique';

const KEY_FORMAT = /^[A-Za-z0-9_-]{8,128}$/;
/** The only try a session's hold has; a settled one is a new session (and key). */
const ATTEMPT = 1;
const SETTLED_ATTEMPT = 2;
export const RECEPTIONIST_VOICE_MAX_SETTING =
  'ai.receptionist_voice_max_minutes';
const DOCS_MAX_SETTING = 'ai.receptionist_docs_max';
const DOC_BYTES_SETTING = 'ai.receptionist_doc_max_bytes';
const TEXT_CHARS_SETTING = 'ai.receptionist_text_max_chars';
const HISTORY_SETTING = 'ai.receptionist_history_turns';
const LLM_SETTING = 'ai.receptionist_llm';
const LANGUAGES_SETTING = 'ai.receptionist_languages';
const MESSAGE_SETTING = 'ai.receptionist_message_max_chars';
/** Minutes past the longest talking session after which a session nobody ended is settled at the longest. */
export const VOICE_GRACE_MINUTES = 15;
/**
 * The minutes after which the Hub ends a session the app ended but the provider never closed: the minutes the stale
 * sweep gives its hold back at. That is `points.job_max_run_minutes` (the sweep's base cutoff), or the longest talk
 * plus the grace when that is later (the sweep leaves a Receptionist hold alone until then).
 */
export function voiceEndByMinutes(
  jobMaxRunMinutes: number,
  voiceMaxMinutes: number,
): number {
  return Math.max(jobMaxRunMinutes, voiceMaxMinutes + VOICE_GRACE_MINUTES);
}
/** A settle pass reads sessions in pages of this many, at most this many pages. */
const SETTLE_PAGE = 50;
const SETTLE_MAX_PAGES = 20;
const NOT_SET_UP_MESSAGE =
  'Set up your Receptionist first. No points were taken.';
const NOT_FOUND_MESSAGE = "We couldn't find that.";

/** The Hub's own words for the agent, after the person's: it stays on their business and never invents. */
const GUARDRAIL =
  'Answer only about this business, using what you know from the documents you were given. If you do not know, say so plainly and offer to pass the question on. Never invent prices, opening hours, offers or promises. Keep replies short and friendly, and write the way people talk.';

function promptOf(a: {
  businessName: string;
  offer: string;
  replyStyle: string;
}): string {
  return [
    `You are the receptionist for ${a.businessName}.`,
    `What the business offers: ${a.offer}`,
    a.replyStyle === '' ? '' : `How to reply: ${a.replyStyle}`,
    GUARDRAIL,
  ]
    .filter((l) => l !== '')
    .join('\n\n');
}

/**
 * THE RECEPTIONIST (AITOOLS-06, R-109): a creator's own talking AI agent. One agent a person at the provider, made on
 * the first save and edited after; what it knows is a list of texts, web pages and documents the person adds and
 * removes; a text message is a job of the pipeline (`receptionist_message`, held, asked, kept on the reply, given back
 * on a failure); a talking session holds its longest up front, the phone and the provider talk to each other on a signed
 * link (the Hub carries no audio), and the real minutes are kept when the session ends.
 *
 * Every other channel is left out by ruling (R-109 point 3) and has no code here. No
 * message text is logged: the person's words and the replies live in their own rows only.
 */
@Injectable()
export class ReceptionistService {
  private readonly logger = new Logger(ReceptionistService.name);
  private settling = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: PlanSettingsService,
    @Inject(PLANS_CONFIG) private readonly plan: PlansConfig,
    @Inject(AI_VOICE_PROVIDER) private readonly voice: AiVoiceProvider,
    private readonly input: AiInputService,
    private readonly spend: PointsSpendService,
    private readonly points: PointsService,
    private readonly quotes: PointsJobQuoteToken,
    // REC-PRIVACY: a conversation the provider keeps is deleted by the same note-and-retry path as every other copy.
    private readonly copies: ProviderCopyService,
  ) {}

  /** True while the tool is listed and the provider is set up. */
  available(): boolean {
    return (
      this.voice.agentsConfigured && isListed(RECEPTIONIST_TOOL, this.settings)
    );
  }

  private requireAvailable(): void {
    if (!this.available())
      throw new AiToolError('ai_tool_unavailable', UNAVAILABLE_MESSAGE);
  }

  private languages(): { code: string; name: string }[] {
    return this.settings.lines(LANGUAGES_SETTING).map((l) => ({
      code: l.split(' ')[0],
      name: l.slice(l.indexOf(' ') + 1),
    }));
  }

  private limits() {
    return {
      docsMax: this.settings.number(DOCS_MAX_SETTING),
      docMaxBytes: this.settings.number(DOC_BYTES_SETTING),
      textMaxChars: this.settings.number(TEXT_CHARS_SETTING),
      messageMaxChars: this.settings.number(MESSAGE_SETTING),
      voiceMaxMinutes: this.settings.number(RECEPTIONIST_VOICE_MAX_SETTING),
      languages: this.languages(),
    };
  }

  // ---- the agent ---------------------------------------------------------

  /** Whether the person has set up a Receptionist that exists at the provider. */
  async isSetUp(wawuUserId: string): Promise<boolean> {
    const row = await this.prisma.receptionistAgent.findUnique({
      where: { wawuUserId },
      select: { providerAgentId: true },
    });
    return Boolean(row?.providerAgentId);
  }

  /** The person's Receptionist as the app draws it. Read-only; also while the tool is off (it then says `available: false`). */
  async view(wawuUserId: string): Promise<ReceptionistView> {
    const [agent, docs] = await Promise.all([
      this.prisma.receptionistAgent.findUnique({ where: { wawuUserId } }),
      this.prisma.receptionistKnowledge.findMany({
        where: { wawuUserId },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    return {
      available: this.available(),
      setUp: Boolean(agent?.providerAgentId),
      details: agent
        ? {
            businessName: agent.businessName,
            offer: agent.offer,
            replyStyle: agent.replyStyle,
            language: agent.language,
            voiceId: agent.voiceId,
          }
        : null,
      knowledge: docs
        .filter((d) => d.providerDocId !== '')
        .map((d): ReceptionistKnowledgeView => ({
          id: d.id,
          kind: d.kind as ReceptionistKnowledgeView['kind'],
          name: d.name,
          bytes: d.bytes,
          createdAt: d.createdAt.toISOString(),
        })),
      limits: this.limits(),
      voices: this.voice.voices().map((v) => ({
        id: v.id,
        name: v.name,
        description: v.description,
      })),
    };
  }

  private async specOf(
    agent: Pick<
      ReceptionistAgent,
      | 'businessName'
      | 'offer'
      | 'replyStyle'
      | 'language'
      | 'voiceId'
      | 'wawuUserId'
    >,
  ): Promise<AgentSpec> {
    const docs = await this.prisma.receptionistKnowledge.findMany({
      where: { wawuUserId: agent.wawuUserId, NOT: { providerDocId: '' } },
      orderBy: { createdAt: 'asc' },
    });
    return {
      name: agent.businessName.slice(0, 80),
      prompt: promptOf(agent),
      firstMessage: `Hello, you have reached ${agent.businessName}. How can I help?`,
      language: agent.language,
      llm: this.settings.lines(LLM_SETTING)[0],
      voiceId: agent.voiceId || this.voice.voices()[0]?.id || '',
      knowledge: docs.map((d) => ({
        id: d.providerDocId,
        name: d.name,
        kind: d.kind as 'text' | 'url' | 'file',
      })),
    };
  }

  /** `PUT /ai-tools/receptionist`: made on the first save, edited after. Nothing is created at the provider for a refused request. */
  async save(
    wawuUserId: string,
    dto: SaveReceptionistDto,
  ): Promise<ReceptionistView> {
    this.requireAvailable();
    const businessName = dto.businessName.trim();
    const offer = dto.offer.trim();
    const replyStyle = (dto.replyStyle ?? '').trim();
    if (businessName === '' || offer === '')
      throw new AiToolError(
        'ai_text_empty',
        'Add your business name and what you offer. Nothing was saved.',
      );
    const language = (dto.language ?? 'en').trim().toLowerCase();
    if (!this.languages().some((l) => l.code.toLowerCase() === language))
      throw new AiToolError(
        'ai_language_unsupported',
        'That language is not on the list. Nothing was saved.',
      );
    const voiceId = (dto.voiceId ?? '').trim();
    if (voiceId !== '' && !this.voice.voices().some((v) => v.id === voiceId))
      throw new AiToolError(
        'ai_voice_unknown',
        'Pick one of the voices on the list.',
      );
    const fields = { businessName, offer, replyStyle, language, voiceId };
    const existing = await this.prisma.receptionistAgent.findUnique({
      where: { wawuUserId },
    });
    try {
      if (existing?.providerAgentId) {
        await this.voice.updateAgent(
          existing.providerAgentId,
          await this.specOf({ ...fields, wawuUserId }),
        );
        await this.prisma.receptionistAgent.update({
          where: { wawuUserId },
          data: fields,
        });
      } else {
        const made = await this.voice.createAgent(
          await this.specOf({ ...fields, wawuUserId }),
        );
        try {
          await this.prisma.receptionistAgent.upsert({
            where: { wawuUserId },
            create: { wawuUserId, providerAgentId: made.agentId, ...fields },
            update: { providerAgentId: made.agentId, ...fields },
          });
        } catch (e) {
          // Two first saves at once: the other one won; this agent is not wanted.
          await this.voice.deleteAgent(made.agentId).catch(() => undefined);
          if (!isUniqueViolation(e)) throw e;
        }
      }
    } catch (e) {
      if (e instanceof AiToolError) throw e;
      throw this.unavailable(e);
    }
    return this.view(wawuUserId);
  }

  private unavailable(e: unknown): ServiceUnavailableException {
    if (e instanceof AiVoiceProviderError)
      this.logger.warn(
        `receptionist: the provider ${e.status !== undefined ? `answered ${e.status}` : 'did not answer'}`,
      );
    return new ServiceUnavailableException(
      "The Receptionist isn't available right now. Nothing was changed. Try again soon.",
    );
  }

  // ---- what it knows -----------------------------------------------------

  /** Adds a text, a web page or a document. Everything is checked first; nothing is created at the provider for a refused one. */
  async addKnowledge(
    wawuUserId: string,
    dto: AddKnowledgeDto,
  ): Promise<ReceptionistView> {
    this.requireAvailable();
    const agent = await this.prisma.receptionistAgent.findUnique({
      where: { wawuUserId },
    });
    if (!agent?.providerAgentId)
      throw new AiToolError('receptionist_not_set_up', NOT_SET_UP_MESSAGE);
    const name = dto.name.trim();
    if (name === '')
      throw new AiToolError(
        'ai_text_empty',
        'Give it a name. Nothing was added.',
      );
    let bytes = 0;
    let text = '';
    let url = '';
    let doc: { key: string; bytes: number; contentType: string } | null = null;
    if (dto.kind === 'text') {
      text = (dto.text ?? '').trim();
      const max = this.settings.number(TEXT_CHARS_SETTING);
      if (text === '')
        throw new AiToolError(
          'ai_text_empty',
          'Write the text. Nothing was added.',
        );
      if (Array.from(text).length > max)
        throw new AiToolError(
          'ai_prompt_too_long',
          `A text can have ${max} characters. Nothing was added.`,
          { cap: 'knowledge_characters', capLimit: max, capUnit: 'characters' },
        );
      bytes = Buffer.byteLength(text, 'utf8');
    } else if (dto.kind === 'url') {
      url = (dto.url ?? '').trim();
      if (!podcastLinkOk(url))
        throw new AiToolError(
          'ai_link_invalid',
          'Use a web link that starts with https and has a site name in it. Nothing was added.',
        );
    } else {
      if (!dto.fileKey) throw new AiToolError('not_found', NOT_FOUND_MESSAGE);
      doc = await this.input.openDoc(
        wawuUserId,
        dto.fileKey,
        this.settings.number(DOC_BYTES_SETTING),
      );
      bytes = doc.bytes;
    }
    // The place is taken first (a row with no provider id), under one lock with the count, so two adds at once cannot pass the limit.
    const rowId = randomUUID();
    const max = this.settings.number(DOCS_MAX_SETTING);
    const taken = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`receptionist:${wawuUserId}`}))`;
      const have = await tx.receptionistKnowledge.count({
        where: { wawuUserId },
      });
      if (have >= max) return false;
      await tx.receptionistKnowledge.create({
        data: {
          id: rowId,
          wawuUserId,
          providerDocId: '',
          kind: dto.kind,
          name: name.slice(0, 120),
          bytes,
        },
      });
      return true;
    });
    if (!taken)
      throw new AiToolError(
        'receptionist_knowledge_full',
        `Your Receptionist can know ${max} things. Remove one to add another. Nothing was added.`,
        { cap: 'knowledge_documents', capLimit: max, capUnit: 'documents' },
      );
    let providerDocId = '';
    try {
      if (dto.kind === 'text')
        providerDocId = (await this.voice.addKnowledgeText({ name, text })).id;
      else if (dto.kind === 'url')
        providerDocId = (await this.voice.addKnowledgeUrl({ name, url })).id;
      else {
        const file = await this.input.openForRun(
          wawuUserId,
          doc!.key,
          this.settings.number(DOC_BYTES_SETTING),
        );
        try {
          providerDocId = (await this.voice.addKnowledgeFile({ name, file }))
            .id;
        } finally {
          file.sent();
        }
      }
      await this.prisma.receptionistKnowledge.update({
        where: { id: rowId },
        data: { providerDocId },
      });
      await this.voice.updateAgent(
        agent.providerAgentId,
        await this.specOf(agent),
      );
    } catch (e) {
      // Nothing is kept of a document the agent could not take: the provider's copy and the row go.
      if (providerDocId !== '')
        await this.voice.deleteKnowledge(providerDocId).catch(() => undefined);
      await this.prisma.receptionistKnowledge.deleteMany({
        where: { id: rowId },
      });
      throw e instanceof AiToolError || e instanceof ServiceUnavailableException
        ? e
        : this.unavailable(e);
    } finally {
      // The person's uploaded document was read for this one add.
      if (doc) await this.input.remove(doc.key).catch(() => undefined);
    }
    return this.view(wawuUserId);
  }

  /** Removes one thing it knows: deleted at the provider (it also leaves the agent), then the row. */
  async removeKnowledge(
    wawuUserId: string,
    id: string,
  ): Promise<ReceptionistView> {
    const row = await this.prisma.receptionistKnowledge.findUnique({
      where: { id },
    });
    if (!row || row.wawuUserId !== wawuUserId)
      throw new AiToolError('not_found', NOT_FOUND_MESSAGE);
    if (row.providerDocId !== '') {
      const out = await this.voice.deleteKnowledge(row.providerDocId);
      if (out === 'failed')
        throw this.unavailable(
          new AiVoiceProviderError('unavailable', 'delete'),
        );
    }
    await this.prisma.receptionistKnowledge.deleteMany({ where: { id } });
    const agent = await this.prisma.receptionistAgent.findUnique({
      where: { wawuUserId },
    });
    if (agent?.providerAgentId)
      await this.voice
        .updateAgent(agent.providerAgentId, await this.specOf(agent))
        .catch(() => undefined);
    return this.view(wawuUserId);
  }

  /**
   * Clears the Receptionist: the agent and every document are deleted at the provider, then every row (the agent, the
   * knowledge and the earlier messages). A provider delete that fails leaves its row and answers `pending`; asking again
   * carries on. A conversation of the person's the provider still keeps is cleared from the notes only once a read says
   * it is gone (REC-DELETE). Always works, also while the tool is off.
   */
  async clear(wawuUserId: string): Promise<ReceptionistRemovedView> {
    let pending = false;
    const docs = await this.prisma.receptionistKnowledge.findMany({
      where: { wawuUserId },
    });
    for (const d of docs) {
      if (d.providerDocId !== '') {
        const out = await this.voice.deleteKnowledge(d.providerDocId);
        if (out === 'failed') {
          pending = true;
          continue;
        }
      }
      await this.prisma.receptionistKnowledge.deleteMany({
        where: { id: d.id },
      });
    }
    // REC-PRIVACY: every conversation of the person's the provider may still keep (a text chat or a talk whose delete did
    // not go through) is dealt with below; an open talk is left alone and answers `pending`.
    const kept = await this.keptConversations(wawuUserId);
    if (kept.open) pending = true;
    const agent = await this.prisma.receptionistAgent.findUnique({
      where: { wawuUserId },
    });
    let agentDeleted = true;
    if (agent?.providerAgentId) {
      const out = await this.voice.deleteAgent(agent.providerAgentId);
      if (out === 'failed') {
        pending = true;
        agentDeleted = false;
      }
    }
    // REC-DELETE: a delete the provider answers 204 may be ignored (a conversation not yet finished), and after the
    // agent is deleted a 404 by id proves nothing: a conversation still being finished is kept, listed, and 404 by id
    // (proven on the real provider, round 1). So no note is cleared on those answers. Each is tried the ordinary way
    // (read, the provider's list, a delete once finished, a read of both after it) for a moment, stays noted until it
    // is proven gone, and the answer is `pending` while one is left: the sweep carries on.
    if (agentDeleted) {
      const tried = await Promise.all(
        kept.noted.map((c) => this.copies.afterAgentDeleted(c.jobId, c.copy)),
      );
      if (tried.includes('kept')) pending = true;
    }
    if (!pending) {
      await this.prisma.receptionistAgent.deleteMany({ where: { wawuUserId } });
      await this.prisma.receptionistTurn.deleteMany({ where: { wawuUserId } });
    }
    return {
      receptionist: await this.view(wawuUserId),
      atProvider: pending ? 'pending' : 'gone',
    };
  }

  /**
   * The conversations the Hub still has a note of for this person: `conversation:<id>` (a text chat, or a talk once it
   * ended, with `@<ms>` once a delete was sent after it finished) and `convo:<id>` (a talk that ended but whose note was
   * not yet swapped). A row whose job is still `working` (a talk in progress, or an answer not yet given) is not listed:
   * `open` says one exists. Its conversation is the only read of the talk's real length, so deleting it would make the
   * settle step charge the longest talk, or a talk the provider never closed. The settle step (or the end of the job)
   * ends it and deletes its conversation, and asking again then finds nothing.
   */
  private async keptConversations(wawuUserId: string): Promise<{
    open: boolean;
    noted: { jobId: string; copy: { kind: 'conversation'; id: string } }[];
  }> {
    const rows = await this.prisma.aiToolJob.findMany({
      where: {
        wawuUserId,
        // A note older than the sweep's give-up age is ignored here as there (the provider's own limit has passed).
        createdAt: { gte: new Date(Date.now() - CONVERSATION_GIVE_UP_MS) },
        OR: [
          { providerRef: { startsWith: 'conversation:' } },
          {
            tool: RECEPTIONIST_VOICE_ACTION,
            providerRef: { startsWith: 'convo:' },
          },
        ],
      },
      select: { id: true, providerRef: true, state: true },
      orderBy: { createdAt: 'asc' },
      take: SETTLE_PAGE * SETTLE_MAX_PAGES,
    });
    let open = false;
    const noted: {
      jobId: string;
      copy: { kind: 'conversation'; id: string };
    }[] = [];
    for (const row of rows) {
      if (row.state === 'working') {
        open = true;
        continue;
      }
      const talk = !row.providerRef?.startsWith('conversation:');
      const id = talk
        ? conversationOf(row.providerRef)
        : copyOfMarker(row.providerRef)?.copy.id;
      if (!id || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) continue;
      const copy = { kind: 'conversation' as const, id };
      if (talk) {
        // A talk that ended but whose note was not yet swapped: noted as a conversation to delete, as the settle step does.
        const swapped = await this.prisma.aiToolJob.updateMany({
          where: {
            id: row.id,
            state: { not: 'working' },
            providerRef: { startsWith: 'convo:' },
          },
          data: { providerRef: markerOf(copy) },
        });
        if (swapped.count === 0) {
          open = true;
          continue;
        }
      }
      noted.push({ jobId: row.id, copy });
    }
    return { open, noted };
  }

  /** Account deletion: every agent and document of the person is deleted at the provider first; throws while one is left (the purge then tries again). */
  async beforeErase(wawuUserId: string): Promise<void> {
    const out = await this.clear(wawuUserId);
    if (out.atProvider === 'pending')
      throw new Error('a receptionist is still at the provider');
  }

  // ---- text chat ---------------------------------------------------------

  /** What a text message needs when its job runs: the agent's id and the earlier messages, from the Hub's own rows. */
  async chatContext(
    wawuUserId: string,
  ): Promise<{ agentId: string; earlier: ChatTurn[] } | null> {
    const agent = await this.prisma.receptionistAgent.findUnique({
      where: { wawuUserId },
      select: { providerAgentId: true },
    });
    if (!agent?.providerAgentId) return null;
    const keep = this.settings.number(HISTORY_SETTING);
    const rows =
      keep === 0
        ? []
        : await this.prisma.receptionistTurn.findMany({
            where: { wawuUserId },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: keep,
          });
    return {
      agentId: agent.providerAgentId,
      earlier: rows.reverse().map((r): ChatTurn => ({
        role: r.role as ChatTurn['role'],
        text: r.text,
      })),
    };
  }

  /** Keeps a message and its reply as context for the next (a bounded number; none when the setting is 0). Never throws. */
  async remember(
    wawuUserId: string,
    person: string,
    agent: string,
  ): Promise<void> {
    try {
      const keep = this.settings.number(HISTORY_SETTING);
      if (keep === 0) return;
      const now = Date.now();
      await this.prisma.receptionistTurn.createMany({
        data: [
          {
            wawuUserId,
            role: 'person',
            text: person,
            createdAt: new Date(now),
          },
          {
            wawuUserId,
            role: 'agent',
            text: agent,
            createdAt: new Date(now + 1),
          },
        ],
      });
      const old = await this.prisma.receptionistTurn.findMany({
        where: { wawuUserId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: keep,
        select: { id: true },
      });
      if (old.length > 0)
        await this.prisma.receptionistTurn.deleteMany({
          where: { id: { in: old.map((o) => o.id) } },
        });
    } catch {
      this.logger.warn('receptionist: a message was not kept as context');
    }
  }

  // ---- talking -----------------------------------------------------------

  private voiceCost(minutes: number): number {
    const action = this.plan.actions.find(
      (a) => a.id === RECEPTIONIST_VOICE_ACTION,
    );
    if (!action)
      throw new AiToolError('ai_tool_unavailable', UNAVAILABLE_MESSAGE);
    return action.points * minutes;
  }

  private sessionView(
    job: AiToolJob,
    signedUrl: string | null,
  ): VoiceSessionView {
    const max = this.settings.number(RECEPTIONIST_VOICE_MAX_SETTING);
    return {
      id: job.id,
      state: job.state,
      signedUrl,
      conversationId: conversationOf(job.providerRef),
      maxSeconds: max * 60,
      heldPoints: job.state === 'working' ? job.costPoints : 0,
      keptPoints: job.state === 'done' ? job.costPoints : 0,
      minutes: job.state === 'done' ? job.units : null,
    };
  }

  /**
   * `POST /ai-tools/receptionist/voice-sessions`: holds the points for the longest session, mints a signed link with the
   * conversation id and answers it. The phone and the provider talk on that link; the Hub carries no audio. A repeat of
   * the same Idempotency-Key answers the same session without a link (a link is used once): start a new one.
   */
  async startVoice(
    wawuUserId: string,
    idempotencyKey: string | undefined,
    quoteToken: string,
    now: Date = new Date(),
  ): Promise<{ session: VoiceSessionView; replayed: boolean }> {
    if (!idempotencyKey || !KEY_FORMAT.test(idempotencyKey))
      throw new AiToolError(
        'idempotency_key_required',
        'Send an Idempotency-Key of 8 to 128 letters, digits, - or _ with this request.',
      );
    const id = jobIdFor(wawuUserId, idempotencyKey);
    const earlier = await this.prisma.aiToolJob.findUnique({ where: { id } });
    if (earlier) {
      if (earlier.tool !== RECEPTIONIST_VOICE_ACTION)
        throw new AiToolError(
          'idempotency_key_reused',
          'That Idempotency-Key was already used for a different job. Start again.',
        );
      return { session: this.sessionView(earlier, null), replayed: true };
    }
    this.requireAvailable();
    const agent = await this.prisma.receptionistAgent.findUnique({
      where: { wawuUserId },
    });
    if (!agent?.providerAgentId)
      throw new AiToolError('receptionist_not_set_up', NOT_SET_UP_MESSAGE);
    const minutes = this.settings.number(RECEPTIONIST_VOICE_MAX_SETTING);
    const cost = this.voiceCost(minutes);
    const claims = this.quotes.read(quoteToken);
    if (
      !claims ||
      claims.u !== wawuUserId ||
      claims.a !== RECEPTIONIST_VOICE_ACTION ||
      claims.e < now.getTime() ||
      claims.c !== cost
    )
      throw new AiToolError(
        'quote_changed',
        'The cost changed or the quote ended. Check the points and run it again. No points were taken.',
        { costPoints: cost },
      );
    const held = await this.spend.hold(
      {
        wawuUserId,
        action: RECEPTIONIST_VOICE_ACTION,
        units: minutes,
        reference: jobHoldReference(id, ATTEMPT),
      },
      { now },
    );
    let job: AiToolJob;
    try {
      job = await this.prisma.aiToolJob.create({
        data: {
          id,
          wawuUserId,
          tool: RECEPTIONIST_VOICE_ACTION,
          idempotencyKey,
          requestHash: `receptionist-voice:${wawuUserId}:${idempotencyKey}`,
          voiceId: '',
          characters: 0,
          units: minutes,
          costPoints: held.costPoints,
          holdId: held.holdId,
        },
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        const winner = await this.prisma.aiToolJob.findUnique({
          where: { id },
        });
        if (winner)
          return { session: this.sessionView(winner, null), replayed: true };
      }
      await this.spend.release(held.holdId).catch(() => undefined);
      throw e;
    }
    let link;
    try {
      link = await this.voice.openVoiceSession(agent.providerAgentId);
    } catch (e) {
      await this.endWithoutCharge(job, 'provider_unavailable');
      throw e instanceof AiVoiceProviderError ? this.unavailable(e) : e;
    }
    await this.prisma.aiToolJob.update({
      where: { id },
      data: { providerRef: `convo:${link.conversationId}` },
    });
    job.providerRef = `convo:${link.conversationId}`;
    return {
      session: this.sessionView(job, link.signedUrl),
      replayed: false,
    };
  }

  /** The points go back and the session ends as failed, in one transaction. */
  private async endWithoutCharge(job: AiToolJob, code: string): Promise<void> {
    if (!job.holdId) return;
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.spend.release(job.holdId!, { tx });
        await tx.aiToolJob.updateMany({
          where: { id: job.id, state: 'working' },
          data: { state: 'failed', failureCode: code, finishedAt: new Date() },
        });
      });
    } catch (e) {
      if (!(e instanceof PointsError && e.code === 'points_hold_settled'))
        this.logger.error(
          `receptionist session ${job.id}: the points were not given back yet`,
        );
    }
  }

  /**
   * `POST /ai-tools/receptionist/voice-sessions/{id}/end`: the app says the talk is over. The Hub reads the conversation
   * (its length), keeps the real minutes (rounded up, at most what was held) and gives the rest back. If the provider
   * has not closed it yet the session stays open for a moment and the sweep settles it. A second `end` changes nothing.
   */
  async endVoice(wawuUserId: string, id: string): Promise<VoiceSessionView> {
    const job = await this.prisma.aiToolJob.findUnique({ where: { id } });
    if (
      !job ||
      job.wawuUserId !== wawuUserId ||
      job.tool !== RECEPTIONIST_VOICE_ACTION
    )
      throw new AiToolError('not_found', NOT_FOUND_MESSAGE);
    if (job.state !== 'working') return this.sessionView(job, null);
    // Marked as ended, so the sweep carries on if the provider is not ready yet.
    const convo = conversationOf(job.providerRef);
    if (convo)
      await this.prisma.aiToolJob.updateMany({
        where: { id, state: 'working' },
        data: { providerRef: `convo:${convo}:ended` },
      });
    await this.trySettle(job.id);
    const after = await this.prisma.aiToolJob.findUnique({ where: { id } });
    return this.sessionView(after ?? job, null);
  }

  /**
   * Settles one session. `atMaximum` keeps all that was held (a session nobody ended, past its time). Otherwise the
   * provider is asked how long the talk was; no answer yet leaves the session open, unless the session is older than
   * `endBy` (the sweep's minutes): a talk the provider never closed then ends as a timed out failure that gives the
   * points back (nothing is charged for a talk the provider cannot vouch for).
   */
  private async trySettle(
    id: string,
    atMaximum = false,
    endBy: Date | null = null,
  ): Promise<void> {
    const job = await this.prisma.aiToolJob.findUnique({ where: { id } });
    if (!job || job.state !== 'working' || !job.holdId) return;
    const max = this.settings.number(RECEPTIONIST_VOICE_MAX_SETTING);
    let minutes = max;
    const convo = conversationOf(job.providerRef);
    if (!atMaximum) {
      const timedOut = endBy !== null && job.createdAt < endBy;
      if (!convo) {
        if (timedOut) await this.endUnclosed(job);
        return;
      }
      try {
        const read = await this.voice.readConversation(convo);
        if (read.status === 'failed') {
          // The provider never ran a talk: nothing is kept.
          await this.endWithoutCharge(job, 'provider_failed');
          await this.dropConversation(job.id, convo);
          return;
        }
        if (read.status !== 'done' || read.seconds === null) {
          if (timedOut) await this.endUnclosed(job, convo);
          return;
        }
        minutes = Math.min(max, Math.max(1, Math.ceil(read.seconds / 60)));
      } catch {
        if (timedOut) await this.endUnclosed(job, convo);
        return;
      }
    }
    try {
      await this.settleMinutes(job, minutes, max);
    } catch (e) {
      this.logger.error(
        `receptionist session ${job.id}: not settled yet (${(e as Error).name ?? 'Error'})`,
      );
      return;
    }
    // The provider keeps none of the person's words.
    if (convo) await this.dropConversation(job.id, convo);
  }

  /**
   * The provider keeps none of the person's words (REC-PRIVACY): a talk that has ended (settled or failed) is noted on
   * its row as a conversation to delete (`conversation:<id>`, in place of the talk's own `convo:<id>` note), deleted now,
   * tried again over the next minute and then every minute by the copy sweep, until it is gone; DELETE /receptionist and
   * the account purge delete any still noted. Never throws. A row still open is left alone (its note is the talk's own).
   */
  private async dropConversation(jobId: string, convo: string): Promise<void> {
    try {
      const copy = { kind: 'conversation' as const, id: convo };
      await this.prisma.aiToolJob.updateMany({
        where: {
          id: jobId,
          state: { not: 'working' },
          providerRef: { startsWith: 'convo:' },
        },
        data: { providerRef: markerOf(copy) },
      });
      const row = await this.prisma.aiToolJob.findUnique({
        where: { id: jobId },
        select: { state: true },
      });
      if (!row || row.state === 'working') return;
      // Off the request: the provider's delete of a finished conversation takes 7 to 8 seconds (round 1), so POST /end
      // waits for it only a moment and the rest carries on in the background (then the retries and the sweep).
      await this.copies.discardWithin(jobId, copy);
    } catch {
      this.logger.warn(
        `receptionist session ${jobId}: its conversation was not noted for deletion yet`,
      );
    }
  }

  /** The held points become the real minutes: the rest goes back, all in one transaction. */
  private async settleMinutes(
    job: AiToolJob,
    minutes: number,
    max: number,
  ): Promise<void> {
    const holdId = job.holdId!;
    if (minutes >= max) {
      try {
        await this.spend.commit(holdId);
      } catch (e) {
        if (e instanceof PointsError && e.code === 'points_hold_settled') {
          await this.markEnded(job.id);
          return;
        }
        throw e;
      }
      await this.prisma.aiToolJob.updateMany({
        where: { id: job.id, state: 'working' },
        data: { state: 'done', finishedAt: new Date(), units: max },
      });
      return;
    }
    const cost = this.voiceCost(minutes);
    try {
      await this.prisma.$transaction(async (tx) => {
        await lockPersonPoints(tx, job.wawuUserId);
        await this.spend.release(holdId, { tx });
        const again = await this.points.hold(
          {
            wawuUserId: job.wawuUserId,
            purpose: 'ai_job',
            reference: jobHoldReference(job.id, SETTLED_ATTEMPT),
            points: cost,
            title: 'Receptionist voice',
          },
          { tx },
        );
        await this.points.commit({ holdId: again.holdId }, { tx });
        await tx.aiToolJob.updateMany({
          where: { id: job.id, state: 'working' },
          data: {
            state: 'done',
            finishedAt: new Date(),
            units: minutes,
            costPoints: cost,
          },
        });
      });
    } catch (e) {
      if (e instanceof PointsError && e.code === 'points_hold_settled') {
        await this.markEnded(job.id);
        return;
      }
      throw e;
    }
  }

  /**
   * A talk the app ended but the provider never closed, past the sweep's minutes: the session ends as failed
   * `timed_out`. A hold the sweep already gave back is only noted on the row; a hold still held is released with no
   * charge. Nothing here commits, so it can never charge a session a second time: a settle that wins the race
   * commits once, and this then finds the hold spent and ends the row as the points did.
   */
  private async endUnclosed(job: AiToolJob, convo?: string): Promise<void> {
    const hold = job.holdId
      ? await this.prisma.pointHold.findUnique({
          where: { id: job.holdId },
          select: { state: true },
        })
      : null;
    if (hold?.state === 'held') await this.endWithoutCharge(job, 'timed_out');
    // The sweep (or a settle that won) already spent the hold: the row ends as the points did.
    await this.markEnded(job.id);
    if (convo) {
      const after = await this.prisma.aiToolJob.findUnique({
        where: { id: job.id },
        select: { state: true },
      });
      // The provider keeps none of the person's words (noted, tried again, as after a settle).
      if (after && after.state !== 'working')
        await this.dropConversation(job.id, convo);
    }
  }

  /** The hold was settled by someone else (the stale sweep gave it back): the session ends as the points did. */
  private async markEnded(id: string): Promise<void> {
    const job = await this.prisma.aiToolJob.findUnique({ where: { id } });
    if (!job || job.state !== 'working' || !job.holdId) return;
    const hold = await this.prisma.pointHold.findUnique({
      where: { id: job.holdId },
      select: { state: true },
    });
    await this.prisma.aiToolJob.updateMany({
      where: { id, state: 'working' },
      data:
        hold?.state === 'committed'
          ? { state: 'done', finishedAt: new Date() }
          : {
              state: 'failed',
              failureCode: 'timed_out',
              finishedAt: new Date(),
            },
    });
  }

  /**
   * Every minute: a session the app ended but the provider had not closed is read again, and ends as a timed out
   * failure (the points back) once it is older than the stale sweep's minutes (`points.job_max_run_minutes`, or the
   * longest talk plus a grace when that is later; 30 with the settings as shipped, not the 20 of the grace alone); a
   * session nobody ended, past its longest time plus the grace, is settled at the longest (all that was held is kept).
   * Only those two kinds of row are read, oldest first and in pages, so a stuck row can never keep a newer one waiting.
   * One pass at a time.
   *
   * @Cron runs only where ScheduleModule.forRoot() is loaded (AppModule); a spec calls `settleSessions` directly.
   */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'receptionist-voice-settle' })
  async tick(): Promise<void> {
    try {
      await this.settleSessions();
    } catch {
      this.logger.error('receptionist: a settle pass failed');
    }
  }

  async settleSessions(now: Date = new Date()): Promise<number> {
    if (this.settling) return 0;
    this.settling = true;
    let settled = 0;
    try {
      const max = this.settings.number(RECEPTIONIST_VOICE_MAX_SETTING);
      const cutoff = new Date(
        now.getTime() - (max + VOICE_GRACE_MINUTES) * 60_000,
      );
      const endBy = new Date(
        now.getTime() -
          voiceEndByMinutes(this.settings.number(JOB_MAX_RUN_SETTING), max) *
            60_000,
      );
      // A session still talking (not ended, not yet past its time) is not read: it never takes a place in a page.
      const where: Prisma.AiToolJobWhereInput = {
        tool: RECEPTIONIST_VOICE_ACTION,
        state: 'working',
        OR: [
          { providerRef: { endsWith: ':ended' } },
          { createdAt: { lt: cutoff } },
        ],
      };
      // Pages go by the (time, id) of the last row read, not by a cursor row: a row that ends no longer matches `where`.
      let last: { createdAt: Date; id: string } | null = null;
      for (let page = 0; page < SETTLE_MAX_PAGES; page += 1) {
        const rows: AiToolJob[] = await this.prisma.aiToolJob.findMany({
          where: last
            ? {
                AND: [
                  where,
                  {
                    OR: [
                      { createdAt: { gt: last.createdAt } },
                      { createdAt: last.createdAt, id: { gt: last.id } },
                    ],
                  },
                ],
              }
            : where,
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: SETTLE_PAGE,
        });
        for (const row of rows) {
          const ended = (row.providerRef ?? '').endsWith(':ended');
          const abandoned = row.createdAt < cutoff;
          await this.trySettle(row.id, abandoned && !ended, endBy);
          const after = await this.prisma.aiToolJob.findUnique({
            where: { id: row.id },
            select: { state: true },
          });
          if (after && after.state !== 'working') settled += 1;
        }
        if (rows.length < SETTLE_PAGE) break;
        last = rows[rows.length - 1];
      }
      // REC-PRIVACY: a talk that ended but whose conversation was not yet noted for deletion (the Hub stopped between the
      // two steps) is noted and deleted now.
      const ended = await this.prisma.aiToolJob.findMany({
        where: {
          tool: RECEPTIONIST_VOICE_ACTION,
          state: { not: 'working' },
          providerRef: { startsWith: 'convo:' },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: SETTLE_PAGE,
        select: { id: true, providerRef: true },
      });
      for (const row of ended) {
        const convo = conversationOf(row.providerRef);
        if (convo) await this.dropConversation(row.id, convo);
      }
    } finally {
      this.settling = false;
    }
    return settled;
  }
}

/** The conversation id a session's row notes (`convo:<id>` or `convo:<id>:ended`), or null before the provider named one. */
export function conversationOf(marker: string | null): string | null {
  if (!marker || !marker.startsWith('convo:')) return null;
  const id = marker.slice('convo:'.length).replace(/:ended$/, '');
  return /^[A-Za-z0-9_-]{1,100}$/.test(id) ? id : null;
}
