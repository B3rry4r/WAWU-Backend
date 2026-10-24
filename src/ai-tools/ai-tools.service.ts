import { Inject, Injectable } from '@nestjs/common';
import { PLANS_CONFIG, type PlansConfig } from '../plans/plans-config';
import { PlanSettingsService } from '../plan-settings/plan-settings.service';
import type { AiToolsView, AiToolView } from './ai-tools-view.type';
import { AI_TOOLS } from './tools';
import {
  AI_VOICE_PROVIDER,
  type AiVoiceProvider,
} from './voice/ai-voice-provider';

/**
 * `GET /ai-tools` (AITOOLS-01, AITOOLS-02, PT1): the AI tools the Hub can
 * run, with what each costs before anyone runs it. The list is the tool
 * registry (`src/ai-tools/tools/`): only a tool whose code is built is there
 * (R-47), and a tool added through the pipeline is listed only while the
 * provider can run it (VoiceOver keeps AITOOLS-01's answer: listed with
 * `enabled: false` until the provider is set up). Every cost, cap and limit is
 * read from the live settings on each call (R-65), so a change an admin makes
 * shows at once.
 */
@Injectable()
export class AiToolsService {
  constructor(
    @Inject(PLANS_CONFIG) private readonly plan: PlansConfig,
    private readonly settings: PlanSettingsService,
    @Inject(AI_VOICE_PROVIDER) private readonly voice: AiVoiceProvider,
  ) {}

  list(): AiToolsView {
    const plan = this.plan;
    const voices = this.voice.voices().map((v) => ({
      id: v.id,
      name: v.name,
      description: v.description,
    }));
    const tools: AiToolView[] = [];
    for (const tool of AI_TOOLS) {
      const action = plan.actions.find((a) => a.id === tool.action);
      if (!action) continue;
      const enabled = tool.enabled(this.voice);
      if (!enabled && !tool.listedWhenOff) continue;
      const spec = tool.input;
      const maxCharacters =
        spec.kind === 'prompt'
          ? // The tool's own limit, and never above the plan's per-job cap the hold also checks.
            Math.min(
              this.settings.number(spec.maxCharactersSetting),
              plan.caps.maxCharsPerJob,
            )
          : plan.caps.maxCharsPerJob;
      tools.push({
        id: tool.id,
        action: action.id,
        name: tool.name,
        description: tool.description,
        unit: tool.unit,
        costPointsPerUnit: action.points,
        enabled,
        input:
          spec.kind === 'prompt'
            ? {
                kind: 'prompt',
                // One use or track covers a description of any allowed length.
                maxCharacters,
                charactersPerUnit: maxCharacters,
                length: {
                  field: spec.length.field,
                  min: spec.length.minSeconds,
                  max: this.settings.number(spec.length.maxSecondsSetting),
                  whole: spec.length.whole,
                },
                ...(spec.instrumental ? { instrumental: true } : {}),
              }
            : {
                kind: 'text',
                maxCharacters,
                charactersPerUnit: this.settings.number(
                  spec.charactersPerUnitSetting,
                ),
              },
        voices: spec.kind === 'prompt' ? [] : voices,
      });
    }
    return {
      tools,
      caps: {
        dailyPoints: plan.caps.dailyPointsPerUser,
        maxCharactersPerJob: plan.caps.maxCharsPerJob,
        maxAudioMinutesPerJob: plan.caps.maxAudioMinPerJob,
      },
    };
  }
}
