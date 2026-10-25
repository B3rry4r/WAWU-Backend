import { Injectable, Logger } from '@nestjs/common';
import type {
  GeminiBrief,
  GeminiBriefRequest,
  GeminiChatRequest,
  GeminiClient,
} from './gemini-client.interface';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
/**
 * Flash, because this is a short structured summarisation job on a latency
 * budget — somebody is watching a spinner that says "preparing your summary".
 *
 * Pinned to an explicit version rather than a floating alias. A brief is read
 * by a lawyer before they advise a client, and a model silently changing
 * underneath that is not something to discover from a support ticket.
 * Overridable by GEMINI_MODEL so the pin can be moved without a deploy of
 * this file.
 *
 * NOTE ON VERSIONS: gemini-2.0-flash was SHUT DOWN on 1 June 2026, along with
 * 2.0-flash-lite; 1.0 and 1.5 went earlier. Anything on this codebase that
 * still names a 2.0 model is broken rather than merely old.
 *
 * R2-LEGAL: THE DEFAULT IS A MODEL THAT ANSWERED, NOT THE NEWEST NAME.
 * The earlier default, gemini-3.7-flash, answered 503 "high demand" or nothing
 * inside the 20 second limit below in most of a day's probes, and the Legal
 * chat stayed silent. Probed with the real structured chat turn on 25 Oct
 * 2026: gemini-3-flash-preview answered 9 of 9 direct probes in 1 to 4
 * seconds (and every Hub turn but one 429); gemini-2.5-flash 7 of 8 in about
 * 2; gemini-3.5-flash mostly answered but took 5 to 17 seconds and sometimes
 * 503 or ran past the limit; gemini-3.6-flash, gemini-3.7-flash (1 of 7),
 * gemini-3.8-flash and gemini-3.1-flash-lite often 503 or ran past the limit. It is a preview name,
 * so if the provider ever retires it the Hub log says "Gemini chat returned
 * HTTP 404": set GEMINI_MODEL to any id the key lists (gemini-2.5-flash is the
 * stable one) and restart. The request adapts to the model's family
 * (`thinkingConfigFor`).
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-3-flash-preview';

/**
 * The model id from config. An unset, empty or blank GEMINI_MODEL is the
 * default: a `.env` copied from `.env.example` carries `GEMINI_MODEL=` with
 * nothing after it, and `??` would have kept that empty string and asked the
 * provider for a model with no name.
 */
export function resolveGeminiModel(raw: string | undefined): string {
  const model = (raw ?? '').trim();
  return model === '' ? DEFAULT_GEMINI_MODEL : model;
}

export const GEMINI_MODEL = resolveGeminiModel(process.env.GEMINI_MODEL);

/** The model a call asks for, read when the call is made. */
function currentModel(): string {
  return resolveGeminiModel(process.env.GEMINI_MODEL);
}
const TIMEOUT_MS = 20_000;

/**
 * FIX-43: THINKING TOKENS COUNT AGAINST maxOutputTokens.
 *
 * gemini-3.7-flash is a thinking model. Its thoughts are spent from the same
 * `maxOutputTokens` budget as the answer, so with the old limit of 700 a
 * profiling turn used 669 on thinking and had 17 left for the answer: it came
 * back `MAX_TOKENS` with a 58 character fragment and every turn failed. The
 * limit is therefore two named parts, a room for thinking and a room for the
 * answer, added together; and thinking is asked to stay small.
 *
 * `generationConfig.thinkingConfig.thinkingLevel` is the Gemini 3 control
 * (Google's generateContent reference, ThinkingConfig and ThinkingLevel:
 * MINIMAL, LOW, MEDIUM, HIGH). LOW is the default here because every Gemini 3
 * model accepts it; MINIMAL is listed for some Flash models only, and a model
 * that does not support the level answers HTTP 400. GEMINI_THINKING_LEVEL
 * moves it without a deploy of this file, like GEMINI_MODEL.
 *
 * R2-LEGAL: THE LEVEL IS FOR GEMINI 3 ONLY. Gemini 2.5 takes a token budget
 * (`thinkingBudget`) instead and answers HTTP 400 "Thinking level is not
 * supported for this model" to a level, which silenced the Legal chat on a Hub
 * pointed at gemini-2.5-flash. `thinkingConfigFor` picks the control by model
 * family; a model of any other family (an alias such as gemini-flash-latest,
 * or a name newer than this file) is sent no thinking setting and keeps the
 * thinking room below, so a model id from config never fails on this.
 */
const THINKING_LEVELS = ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];
const requestedLevel = (process.env.GEMINI_THINKING_LEVEL ?? '').toUpperCase();
export const GEMINI_THINKING_LEVEL: ThinkingLevel =
  THINKING_LEVELS.find((level) => level === requestedLevel) ?? 'LOW';

/** Gemini 2.5's thinking budget in tokens: small, inside the thinking room below, and above every 2.5 model's minimum (512 for flash-lite). */
export const THINKING_BUDGET_TOKENS = 1024;

export type ThinkingConfig =
  { thinkingLevel: ThinkingLevel } | { thinkingBudget: number };

/** The thinking control `model` accepts, or nothing when its family is not known. */
export function thinkingConfigFor(model: string): ThinkingConfig | undefined {
  if (/^gemini-3(?![0-9])/.test(model)) {
    return { thinkingLevel: GEMINI_THINKING_LEVEL };
  }
  if (/^gemini-2\.5(?![0-9])/.test(model)) {
    return { thinkingBudget: THINKING_BUDGET_TOKENS };
  }
  return undefined;
}

/** The `generationConfig` entry for `model`'s thinking control: the key, or nothing. */
function thinkingEntry(model: string): { thinkingConfig?: ThinkingConfig } {
  const thinkingConfig = thinkingConfigFor(model);
  return thinkingConfig ? { thinkingConfig } : {};
}

/** Tokens kept for thinking, on top of the answer. Even LOW thinking took several hundred on a short turn. */
export const THINKING_TOKEN_ROOM = 2048;
/**
 * Tokens kept for the answer, by call. The structured chat turn is sized from
 * its schema (ASSISTANT_LIMITS): a reply of 1200 characters, 4 quick replies,
 * a headline, 8 facts of up to 200 characters and the intake answers come to
 * about 1400 tokens at most. A prose chat reply and a brief (3 lists of up to
 * 12 lines) are smaller or the same.
 */
export const ANSWER_TOKEN_ROOM = {
  chatJson: 2048,
  chatProse: 1024,
  brief: 2048,
} as const;
export const MAX_OUTPUT_TOKENS = {
  chatJson: THINKING_TOKEN_ROOM + ANSWER_TOKEN_ROOM.chatJson,
  chatProse: THINKING_TOKEN_ROOM + ANSWER_TOKEN_ROOM.chatProse,
  brief: THINKING_TOKEN_ROOM + ANSWER_TOKEN_ROOM.brief,
} as const;

interface GeminiApiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string; thought?: boolean }>;
    };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
  };
}

/**
 * The text of the answer: every part that is not a thought part, joined. A
 * thinking model may send a thought part first, so `parts[0]` is not the
 * answer. A candidate that did not finish with STOP (MAX_TOKENS above all) is
 * a failed call: its text is cut off. The reason and the token counts are
 * logged once; the text never is, because it is somebody's legal problem.
 */
function readAnswerText(
  payload: GeminiApiResponse,
  logger: Logger,
  label: string,
): string {
  const candidate = payload.candidates?.[0];
  const reason = candidate?.finishReason;
  if (reason && reason !== 'STOP') {
    const usage = payload.usageMetadata ?? {};
    logger.error(
      `Gemini ${label} ended with finishReason ${reason} ` +
        `(prompt ${usage.promptTokenCount ?? '?'}, ` +
        `thoughts ${usage.thoughtsTokenCount ?? '?'}, ` +
        `answer ${usage.candidatesTokenCount ?? '?'}, ` +
        `total ${usage.totalTokenCount ?? '?'})`,
    );
    throw new Error(`Gemini ${label} ended early: ${reason}`);
  }
  return (candidate?.content?.parts ?? [])
    .filter((part) => !part.thought && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

/**
 * Gemini over its REST API.
 *
 * No SDK: this makes exactly one call to one endpoint, and a dependency that
 * ships its own auth stack and transport for that is a liability rather than
 * a convenience.
 *
 * This is the only implementation. Tests run against it with a test key.
 *
 * THE RESPONSE IS SCHEMA-CONSTRAINED. `responseMimeType: application/json`
 * plus `responseSchema` makes Gemini return parseable JSON in the shape this
 * backend declared, instead of markdown-fenced prose that a regex has to
 * chase. The parse is still defensive — a model is not a contract.
 *
 * TEMPERATURE IS LOW on purpose. This summarises what a client actually
 * wrote for a lawyer who is about to advise them. Invention is the failure
 * mode that matters, so the model is pinned toward the conservative reading.
 */
@Injectable()
export class RealGeminiAdapter implements GeminiClient {
  private readonly logger = new Logger(RealGeminiAdapter.name);

  async generateBrief(request: GeminiBriefRequest): Promise<GeminiBrief> {
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
      // No fallback to reach for. Point non-production environments at a
      // non-production key, the same way this backend does with Flutterwave.
      throw new Error(
        'GEMINI_API_KEY is not set. Legal intake cannot generate a brief without it.',
      );
    }

    const model = currentModel();
    const body = {
      systemInstruction: { parts: [{ text: request.instruction }] },
      contents: [{ role: 'user', parts: [{ text: request.content }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: MAX_OUTPUT_TOKENS.brief,
        ...thinkingEntry(model),
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            summary: { type: 'STRING' },
            keyIssues: { type: 'ARRAY', items: { type: 'STRING' } },
            questionsToClarify: { type: 'ARRAY', items: { type: 'STRING' } },
            risks: { type: 'ARRAY', items: { type: 'STRING' } },
          },
          required: ['summary', 'keyIssues', 'questionsToClarify'],
        },
      },
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(
        `${API_BASE}/${encodeURIComponent(model)}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': key,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );
    } catch (error) {
      throw new Error(
        `Gemini request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      // The status is logged; the message is not, because a provider error
      // body can echo the prompt back and the prompt is somebody's legal
      // problem.
      this.logger.error(`Gemini returned HTTP ${response.status}`);
      throw new Error(`Gemini returned HTTP ${response.status}`);
    }

    const payload = (await response.json()) as GeminiApiResponse;

    if (payload.promptFeedback?.blockReason) {
      throw new Error(
        `Gemini blocked the request: ${payload.promptFeedback.blockReason}`,
      );
    }

    const text = readAnswerText(payload, this.logger, 'brief');
    if (!text) throw new Error('Gemini returned no content');

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('Gemini returned unparseable JSON');
    }

    return normaliseBrief(parsed);
  }
  /**
   * One conversational turn.
   *
   * No response schema by default: that is prose to a person, not a document
   * for a dashboard to render. A caller that needs one JSON object back (the
   * legal assistant's profiling turn) passes `responseSchema` and the provider
   * constrains the shape itself, as `generateBrief()` does. Temperature stays
   * low for the same reason the brief's does: the client is asking about their
   * own legal position, and a confident invention is worse than a plain "the
   * consultant will confirm that".
   */
  async chat(request: GeminiChatRequest): Promise<string> {
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
      throw new Error(
        'GEMINI_API_KEY is not set. Legal chat cannot answer without it.',
      );
    }

    const model = currentModel();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(
        `${API_BASE}/${encodeURIComponent(model)}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': key,
          },
          body: JSON.stringify(buildChatBody(request, model)),
          signal: controller.signal,
        },
      );
    } catch (error) {
      throw new Error(
        `Gemini chat failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      this.logger.error(`Gemini chat returned HTTP ${response.status}`);
      throw new Error(`Gemini chat returned HTTP ${response.status}`);
    }

    const payload = (await response.json()) as GeminiApiResponse;
    if (payload.promptFeedback?.blockReason) {
      throw new Error(
        `Gemini blocked the request: ${payload.promptFeedback.blockReason}`,
      );
    }
    const text = readAnswerText(payload, this.logger, 'chat').trim();
    if (!text) throw new Error('Gemini chat returned no content');
    return text;
  }
}

/**
 * The request body of one chat turn. With a `responseSchema` it adds
 * `responseMimeType` and the schema to `generationConfig`, in the order
 * `generateBrief()` writes them. Every turn carries the thinking control its
 * model accepts (`thinkingConfigFor`, R2-LEGAL) and a limit with room for
 * thinking (FIX-43).
 */
export function buildChatBody(
  request: GeminiChatRequest,
  model: string = currentModel(),
): object {
  return {
    systemInstruction: { parts: [{ text: request.instruction }] },
    contents: request.history.map((m) => ({
      role: m.role,
      parts: [{ text: m.text }],
    })),
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: request.responseSchema
        ? MAX_OUTPUT_TOKENS.chatJson
        : MAX_OUTPUT_TOKENS.chatProse,
      ...thinkingEntry(model),
      ...(request.responseSchema
        ? {
            responseMimeType: 'application/json',
            responseSchema: request.responseSchema,
          }
        : {}),
    },
  };
}

/**
 * Force whatever came back into the declared shape.
 *
 * The schema makes the right shape likely, not certain, and this brief is
 * about to be rendered to a lawyer. Anything missing becomes empty rather
 * than undefined, and the arrays are capped so one runaway generation cannot
 * hand the dashboard two hundred bullet points.
 */
export function normaliseBrief(value: unknown): GeminiBrief {
  const raw = (value ?? {}) as Record<string, unknown>;
  const strings = (v: unknown): string[] =>
    Array.isArray(v)
      ? v
          .filter((x): x is string => typeof x === 'string')
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 12)
      : [];

  return {
    summary: typeof raw.summary === 'string' ? raw.summary.trim() : '',
    keyIssues: strings(raw.keyIssues),
    questionsToClarify: strings(raw.questionsToClarify),
    risks: strings(raw.risks),
  };
}
