import { Inject, Injectable } from '@nestjs/common';
import { PLANS_CONFIG, type PlansConfig } from '../plans/plans-config';
import { PlanSettingsService } from '../plan-settings/plan-settings.service';
import { PointsQuoteService } from '../points/spend/points-quote.service';
import { AiToolError, UNAVAILABLE_MESSAGE } from './ai-tools-error';
import { AiInputService } from './input/ai-input-files';
import type { AiTool } from './tools/ai-tool';
import type {
  AiFileQuoteView,
  AiToolsView,
  AiToolView,
} from './ai-tools-view.type';
import {
  AI_INPUT_FOLDERS,
  AI_INPUT_MAX_BYTES_SETTING,
  FOLDER_CONTENT_TYPES,
} from '../storage/dto/presign-upload.dto';
import { AI_TOOLS } from './tools';
import { DUBBING_LANGUAGES_SETTING } from './tools/dubbing.tool';
import { dubLanguagesOf } from './dub/dub-support';
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
    private readonly input: AiInputService,
    private readonly quotes: PointsQuoteService,
  ) {}

  /**
   * The points quote for a person's own file (AITOOLS-04): the Hub opens the
   * file (their own, within the byte cap, its length readable), prices the
   * minutes from its own reading, and hands the same quote `POST /points/quote`
   * does. Nothing is held. The phone sends no length.
   */
  async quoteFile(
    wawuUserId: string,
    tool: AiTool,
    fileKey: string,
  ): Promise<AiFileQuoteView> {
    if (!tool.enabled(this.voice))
      throw new AiToolError('ai_tool_unavailable', UNAVAILABLE_MESSAGE);
    const opened = await this.input.open(wawuUserId, fileKey);
    const quote = await this.quotes.quote(wawuUserId, {
      action: tool.action,
      units: opened.minutes,
    });
    return {
      ...quote,
      file: { seconds: Math.ceil(opened.seconds), minutes: opened.minutes },
    };
  }

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
      if (spec.kind === 'file') {
        tools.push({
          id: tool.id,
          action: action.id,
          name: tool.name,
          description: tool.description,
          unit: tool.unit,
          costPointsPerUnit: action.points,
          enabled,
          input: {
            kind: 'file',
            // A file tool takes no text: the two fields every tool carries are 0.
            maxCharacters: 0,
            charactersPerUnit: 0,
            file: {
              folders: {
                audio: AI_INPUT_FOLDERS[0],
                video: AI_INPUT_FOLDERS[1],
              },
              accepts: {
                audio: [...FOLDER_CONTENT_TYPES[AI_INPUT_FOLDERS[0]]],
                video: [...FOLDER_CONTENT_TYPES[AI_INPUT_FOLDERS[1]]],
              },
              maxBytes: this.settings.number(AI_INPUT_MAX_BYTES_SETTING),
              maxMinutes: plan.caps.maxAudioMinPerJob,
              languageCode: spec.languageCode,
              ...(spec.dubbing
                ? {
                    dubbing: {
                      languages: dubLanguagesOf(
                        this.settings.lines(DUBBING_LANGUAGES_SETTING),
                      ),
                    },
                  }
                : {}),
            },
          },
          voices: [],
        });
        continue;
      }
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
