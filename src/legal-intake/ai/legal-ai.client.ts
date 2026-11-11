import { Injectable } from '@nestjs/common';
import type {
  GeminiBrief,
  GeminiBriefRequest,
  GeminiChatRequest,
  GeminiClient,
} from '../../common/ai/gemini-client.interface';
import {
  GEMINI_MODEL,
  RealGeminiAdapter,
} from '../../common/ai/real-gemini.adapter';
import { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import { ElevenLabsLegalAi } from './elevenlabs-legal-ai';

export const LEGAL_AI_PROVIDER_SETTING = 'legal.ai_provider';

/** A client that names the model behind a brief. */
export interface NamesItsModel {
  modelLabel(): string;
}

/** The model the brief records as its author, for any client (a stand-in or Gemini names none: Gemini's own). */
export function modelLabelOf(client: GeminiClient): string {
  const named = (client as Partial<NamesItsModel>).modelLabel;
  return typeof named === 'function' ? named.call(client) : GEMINI_MODEL;
}

/**
 * The legal services' AI client (LEGAL-ELEVEN, R-137), bound to `GEMINI_CLIENT` inside the legal module only.
 * `legal.ai_provider` picks who answers: `elevenlabs` (the default, used only where the agent platform is set up) or
 * `gemini`, which keeps the earlier path untouched. Read on every call, so the way back needs no code change.
 */
@Injectable()
export class LegalAiClient implements GeminiClient, NamesItsModel {
  constructor(
    private readonly settings: PlanSettingsService,
    private readonly gemini: RealGeminiAdapter,
    private readonly eleven: ElevenLabsLegalAi,
  ) {}

  /**
   * The agent platform answers only when it is set up on this server AND `legal.ai_provider` is `elevenlabs`. A server
   * without `AI_VOICE_BASE_URL` and `AI_VOICE_API_KEY` keeps today's Gemini path exactly (its own "not set" error
   * included), so legal never goes dark for want of keys the server was never given.
   */
  private pick(): GeminiClient {
    return this.settings.lines(LEGAL_AI_PROVIDER_SETTING)[0] === 'elevenlabs' &&
      this.eleven.available()
      ? this.eleven
      : this.gemini;
  }

  modelLabel(): string {
    const chosen = this.pick();
    return chosen === this.eleven ? this.eleven.modelLabel() : GEMINI_MODEL;
  }

  generateBrief(request: GeminiBriefRequest): Promise<GeminiBrief> {
    return this.pick().generateBrief(request);
  }

  chat(request: GeminiChatRequest): Promise<string> {
    return this.pick().chat(request);
  }
}
