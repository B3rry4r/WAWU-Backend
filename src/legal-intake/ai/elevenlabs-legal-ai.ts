import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  GeminiBrief,
  GeminiBriefRequest,
  GeminiChatRequest,
  GeminiClient,
} from '../../common/ai/gemini-client.interface';
import { normaliseBrief } from '../../common/ai/real-gemini.adapter';
import { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import {
  AI_VOICE_PROVIDER,
  AiVoiceProviderError,
  type AgentSpec,
  type AiVoiceProvider,
  type ChatTurn,
} from '../../ai-tools/voice/ai-voice-provider';

/** The settings this adapter reads (LEGAL-ELEVEN, R-137). */
export const LEGAL_AI_LLM_SETTING = 'legal.ai_llm';
export const LEGAL_AI_AGENT_SETTING = 'legal.ai_agent_id';
/** The legal agent's name at the provider: found by it before another is made. */
export const LEGAL_AGENT_NAME = 'WAWU Legal assistant';

/** A turn that has not answered in this long fails, as Gemini's 20 second limit does. */
const TIMEOUT_MS = 25_000;

/**
 * When the Hub tries to delete a finished legal conversation at the provider: after each of these waits (ms). The
 * provider ignores a delete sent before it has closed the conversation (REC-DELETE), so each try reads first.
 */
export const LEGAL_CLEANUP_DELAYS_MS = [
  2_000, 8_000, 30_000, 90_000, 300_000,
] as const;

/**
 * Said once to the agent, in place of a schema the platform cannot enforce: the platform's agents have no structured
 * output (its docs list none), so the shape is demanded in words and checked here.
 */
function jsonDemand(schema: object): string {
  return [
    '',
    'OUTPUT FORMAT (strict): reply with exactly one JSON object and nothing else. No markdown, no code fence, no text before or after it.',
    'The object must follow this schema (types are written in capitals, as in the OpenAPI subset): ' +
      JSON.stringify(schema),
  ].join('\n');
}

/** The brief's shape, as `RealGeminiAdapter.generateBrief` demands it of Gemini. */
export const BRIEF_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING' },
    keyIssues: { type: 'ARRAY', items: { type: 'STRING' } },
    questionsToClarify: { type: 'ARRAY', items: { type: 'STRING' } },
    risks: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['summary', 'keyIssues', 'questionsToClarify'],
} as const;

/** The agent's standing prompt. Every conversation replaces it with the turn's own instruction. */
const AGENT_PROMPT =
  'You are the legal assistant of a Nigerian legal service. Each conversation brings its own instruction, which you follow.';

/**
 * The JSON object in an agent's reply, found the way the legal parsers find it in Gemini's (`parseTurn`): fences dropped,
 * then the first `{` to the last `}`. Anything else is a failed turn, as an unparseable Gemini answer is.
 */
export function readJsonObject(reply: string): unknown {
  const unfenced = reply.replace(/```(?:json)?/gi, '');
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  let parsed: unknown;
  try {
    if (start < 0 || end <= start) throw new Error('none');
    parsed = JSON.parse(unfenced.slice(start, end + 1));
  } catch {
    throw new Error('Legal chat returned unparseable JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error('Legal chat returned unparseable JSON');
  return parsed;
}

/**
 * THE LEGAL ASSISTANT ON ELEVENLABS' AGENT PLATFORM (LEGAL-ELEVEN, R-137).
 *
 * Does what the legal services ask of `GeminiClient` (the profiling turn and the brief) as a text-only agent
 * conversation, reached only through `AI_VOICE_PROVIDER`. One agent at the provider; every turn replaces its prompt
 * and model for that conversation alone (a per-conversation override), so what is sent is exactly the instruction,
 * the earlier lines and the message the Gemini call carried, and nothing else.
 *
 * Privacy: the agent keeps nothing longer than one day (`AGENT_PRIVACY`, the same text the Receptionist's agents get)
 * and the Hub deletes each conversation after its turn, retrying until the provider says it is gone.
 *
 * Nothing in a person's matter is logged: only ids, statuses and counts.
 */
@Injectable()
export class ElevenLabsLegalAi implements GeminiClient {
  private readonly logger = new Logger(ElevenLabsLegalAi.name);
  private ready: Promise<string> | null = null;
  /** Overridable by a spec. */
  cleanupDelaysMs: readonly number[] = LEGAL_CLEANUP_DELAYS_MS;

  constructor(
    @Inject(AI_VOICE_PROVIDER) private readonly voice: AiVoiceProvider,
    private readonly settings: PlanSettingsService,
  ) {}

  /** The model, as the brief records it (`generatedBy`). */
  modelLabel(): string {
    return `elevenlabs:${this.llm()}`;
  }

  private llm(): string {
    return this.settings.lines(LEGAL_AI_LLM_SETTING)[0];
  }

  private spec(): AgentSpec {
    return {
      name: LEGAL_AGENT_NAME,
      prompt: AGENT_PROMPT,
      // No greeting: a text conversation must wait for the person's message, not open with one.
      firstMessage: '',
      language: 'en',
      llm: this.llm(),
      // Typed only: no voice is named.
      voiceId: '',
      knowledge: [],
      allowOverrides: { prompt: true, llm: true },
    };
  }

  /**
   * The legal agent's id. Set in `legal.ai_agent_id`, or made once by the first turn (and logged so the owner can pin
   * it). Either way the agent is brought to the Hub's settings (overrides allowed, privacy) once per process.
   */
  private agent(): Promise<string> {
    if (this.ready) return this.ready;
    const pinned = this.settings.lines(LEGAL_AI_AGENT_SETTING)[0] ?? '';
    const made = (async () => {
      if (pinned !== '') {
        await this.voice.updateAgent(pinned, this.spec());
        return pinned;
      }
      // Found by its exact name before one is made, so a restart never adds another. Oldest first, so agents made
      // at the same moment by two Hubs all settle on the same one.
      const existing = await this.voice.listAgentsNamed(LEGAL_AGENT_NAME);
      if (existing.length > 0) {
        await this.voice.updateAgent(existing[0].agentId, this.spec());
        return existing[0].agentId;
      }
      const { agentId } = await this.voice.createAgent(this.spec());
      // Two Hubs booting together may both have made one: each reads the list again and the older stays; the other
      // deletes only its own.
      const after = await this.voice.listAgentsNamed(LEGAL_AGENT_NAME);
      const winner = after[0]?.agentId ?? agentId;
      if (winner !== agentId) {
        await this.voice.deleteAgent(agentId);
        return winner;
      }
      return agentId;
    })();
    this.ready = made;
    made.catch(() => {
      if (this.ready === made) this.ready = null;
    });
    return made;
  }

  /** One text-only conversation, one reply. Always followed by the conversation's deletion. */
  private async ask(
    instruction: string,
    earlier: ChatTurn[],
    message: string,
    label: string,
  ): Promise<string> {
    if (!this.voice.agentsConfigured) {
      throw new Error(
        `AI_VOICE_API_KEY is not set. Legal ${label} cannot answer without it.`,
      );
    }
    let conversationId = '';
    try {
      const agentId = await this.agent();
      const out = await this.voice.askAgent(
        {
          agentId,
          message,
          earlier,
          override: { prompt: instruction, llm: this.llm() },
          untilTurnEnd: true,
        },
        {
          signal: AbortSignal.timeout(TIMEOUT_MS),
          onConversation: (id) => {
            conversationId = id;
          },
        },
      );
      if (out.conversationId !== '') conversationId = out.conversationId;
      const reply = out.reply.trim();
      if (!reply) throw new Error(`Legal ${label} returned no content`);
      return reply;
    } catch (error) {
      if (error instanceof AiVoiceProviderError) {
        // The status is kept in the text so `providerAtCapacity` reads a 429 as it reads Gemini's.
        throw new Error(
          error.status !== undefined
            ? `Legal ${label} returned HTTP ${error.status}`
            : `Legal ${label} failed: ${error.kind}`,
        );
      }
      throw error;
    } finally {
      if (conversationId !== '') this.forget(conversationId);
    }
  }

  async chat(request: GeminiChatRequest): Promise<string> {
    const last = request.history[request.history.length - 1];
    if (!last || last.role !== 'user')
      throw new Error('Legal chat has no message to answer');
    const reply = await this.ask(
      request.responseSchema
        ? request.instruction + '\n' + jsonDemand(request.responseSchema)
        : request.instruction,
      request.history.slice(0, -1).map((m) => ({
        role: m.role === 'user' ? ('person' as const) : ('agent' as const),
        text: m.text,
      })),
      last.text,
      'chat',
    );
    // The reply goes to the legal parsers as Gemini's does (`parseTurn` finds the object and keeps every check).
    return reply;
  }

  async generateBrief(request: GeminiBriefRequest): Promise<GeminiBrief> {
    const reply = await this.ask(
      request.instruction + '\n' + jsonDemand(BRIEF_SCHEMA),
      [],
      request.content,
      'brief',
    );
    return normaliseBrief(readJsonObject(reply));
  }

  /**
   * Deletes a finished conversation at the provider, in the background (the person is not kept waiting). The provider
   * ignores a delete sent before it has closed the conversation, so each try reads first, deletes only a finished one,
   * and counts it gone only when a read then says 404. If every try is spent the one-day retention is the backstop.
   */
  private forget(conversationId: string): void {
    void (async () => {
      for (const wait of this.cleanupDelaysMs) {
        await new Promise<void>((resolve) => setTimeout(resolve, wait).unref());
        try {
          const read = await this.voice.readConversation(conversationId);
          if (read.status !== 'done' && read.status !== 'failed') continue;
          await this.voice.deleteConversation(conversationId);
          await this.voice.readConversation(conversationId);
        } catch (error) {
          if (error instanceof AiVoiceProviderError && error.status === 404)
            return;
        }
      }
      this.logger.warn(
        `A legal conversation (${conversationId}) was not confirmed deleted; the provider's one-day retention removes it`,
      );
    })();
  }
}
