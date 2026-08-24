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
 * still names a 2.x model is broken rather than merely old.
 */
export const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-3.7-flash';
const TIMEOUT_MS = 20_000;

interface GeminiApiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
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

    const body = {
      systemInstruction: { parts: [{ text: request.instruction }] },
      contents: [{ role: 'user', parts: [{ text: request.content }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 1200,
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
        `${API_BASE}/${encodeURIComponent(GEMINI_MODEL)}:generateContent`,
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

    const text = payload.candidates?.[0]?.content?.parts?.[0]?.text;
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
   * No response schema here — this is prose to a person, not a document for a
   * dashboard to render. Temperature stays low for the same reason the brief's
   * does: the client is asking about their own legal position, and a confident
   * invention is worse than a plain "the consultant will confirm that".
   */
  async chat(request: GeminiChatRequest): Promise<string> {
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
      throw new Error(
        'GEMINI_API_KEY is not set. Legal chat cannot answer without it.',
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(
        `${API_BASE}/${encodeURIComponent(GEMINI_MODEL)}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': key,
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: request.instruction }] },
            contents: request.history.map((m) => ({
              role: m.role,
              parts: [{ text: m.text }],
            })),
            generationConfig: { temperature: 0.3, maxOutputTokens: 700 },
          }),
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
    const text = payload.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) throw new Error('Gemini chat returned no content');
    return text;
  }
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
