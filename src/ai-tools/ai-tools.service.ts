import { Inject, Injectable } from '@nestjs/common';
import { PLANS_CONFIG, type PlansConfig } from '../plans/plans-config';
import { CHARS_PER_MINUTE_SETTING, VOICEOVER_ACTION } from './ai-job.service';
import { PlanSettingsService } from '../plan-settings/plan-settings.service';
import type { AiToolsView } from './ai-tools-view.type';
import {
  AI_VOICE_PROVIDER,
  type AiVoiceProvider,
} from './voice/ai-voice-provider';

/**
 * `GET /ai-tools` (AITOOLS-01, PT1): the AI tools the Hub can run, with what
 * each costs before anyone runs it. Only a tool that is built is listed
 * (R-47): the other tools are added here, one task each, with the code that
 * runs them. Every cost, cap and limit is read from the live settings on each
 * call (R-65), so a change an admin makes shows at once.
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
    const action = plan.actions.find((a) => a.id === VOICEOVER_ACTION);
    return {
      tools: action
        ? [
            {
              id: 'voiceover',
              action: action.id,
              name: 'VoiceOver',
              description: 'Turn your words into spoken audio.',
              unit: 'minute',
              costPointsPerUnit: action.points,
              enabled: this.voice.configured,
              input: {
                maxCharacters: plan.caps.maxCharsPerJob,
                charactersPerUnit: this.settings.number(
                  CHARS_PER_MINUTE_SETTING,
                ),
              },
              voices: this.voice.voices().map((v) => ({
                id: v.id,
                name: v.name,
                description: v.description,
              })),
            },
          ]
        : [],
      caps: {
        dailyPoints: plan.caps.dailyPointsPerUser,
        maxCharactersPerJob: plan.caps.maxCharsPerJob,
        maxAudioMinutesPerJob: plan.caps.maxAudioMinPerJob,
      },
    };
  }
}
