import { Inject, Injectable, Optional } from '@nestjs/common';
import { PLANS_CONFIG, type PlansConfig } from '../plans/plans-config';
import { PlanSettingsService } from '../plan-settings/plan-settings.service';
import { PointsQuoteService } from '../points/spend/points-quote.service';
import { AiToolError, UNAVAILABLE_MESSAGE } from './ai-tools-error';
import { AiInputService } from './input/ai-input-files';
import { AiCloneService } from './own-voice/ai-clone.service';
import { OWN_VOICE_ID } from './own-voice/own-voice-id';
import { isMediaSpec, type AiTool, type MediaInputSpec } from './tools/ai-tool';
import type {
  AiFileQuoteView,
  AiSpeechQuoteView,
  AiToolOptionsView,
  AiToolsView,
  AiToolView,
} from './ai-tools-view.type';
import {
  AI_INPUT_FOLDERS,
  AI_INPUT_IMAGE_FOLDER,
  AI_INPUT_IMAGE_MAX_BYTES,
  AI_INPUT_MAX_BYTES_SETTING,
  FOLDER_CONTENT_TYPES,
} from '../storage/dto/presign-upload.dto';
import { ALL_AI_TOOLS } from './tools';
import { DUBBING_LANGUAGES_SETTING } from './tools/dubbing.tool';
import { dubLanguagesOf } from './dub/dub-support';
import {
  AI_VOICE_PROVIDER,
  type AiVoiceProvider,
  type SpokenAudio,
} from './voice/ai-voice-provider';

/** Where a voice's sample is served: a public path on the Hub, from the API's own address (the app adds the address). */
export const voiceSamplePath = (voiceId: string): string =>
  `/api/hub/ai-tools/voices/${voiceId}/sample`;

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
    // AITOOLS-11: the person's saved clone, which joins the voices of the tools that speak (for its owner only).
    @Optional() private readonly clones?: AiCloneService,
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
    if (
      !tool.enabled(this.voice) ||
      (tool.listingSetting && this.settings.number(tool.listingSetting) !== 1)
    )
      throw new AiToolError('ai_tool_unavailable', UNAVAILABLE_MESSAGE);
    const opened = await this.input.open(wawuUserId, fileKey);
    // AITOOLS-11 and -12: the tool's own look at what the Hub read (a video where audio is needed, a length over its
    // setting), so the quote says no before the person runs it. The job makes the same check.
    tool.checkFile?.(opened, this.settings);
    const quote = await this.quotes.quote(wawuUserId, {
      action: tool.action,
      units: tool.quoteUnits ? tool.quoteUnits(opened) : opened.minutes,
    });
    return {
      ...quote,
      file: { seconds: Math.ceil(opened.seconds), minutes: opened.minutes },
    };
  }

  /**
   * The points quote for a Talking photo's voice (AITOOLS-10): the Hub has read
   * the voice's length itself (`AiJobService.openSpeech`) and prices the seconds
   * from that, so the phone sends no length. The same quote `POST /points/quote`
   * hands back. Nothing is held.
   */
  async quoteSpeech(
    wawuUserId: string,
    tool: AiTool,
    seconds: number,
  ): Promise<AiSpeechQuoteView> {
    if (
      !tool.enabled(this.voice) ||
      (tool.listingSetting && this.settings.number(tool.listingSetting) !== 1)
    )
      throw new AiToolError('ai_tool_unavailable', UNAVAILABLE_MESSAGE);
    const units = Math.max(1, Math.ceil(seconds));
    const quote = await this.quotes.quote(wawuUserId, {
      action: tool.action,
      units,
    });
    return { ...quote, speech: { seconds: units } };
  }

  /** What a Studio picture or video tool takes beyond its description, from the tool and its settings (AITOOLS-09, AITOOLS-10). */
  private optionsOf(spec: MediaInputSpec): AiToolOptionsView {
    return {
      shapes: [...spec.shapes],
      ...(spec.lengths ? { lengths: [...spec.lengths] } : {}),
      ...(spec.photo !== 'none'
        ? {
            photo: {
              use: spec.photo,
              folder: AI_INPUT_IMAGE_FOLDER,
              accepts: [...FOLDER_CONTENT_TYPES[AI_INPUT_IMAGE_FOLDER]],
              maxBytes: AI_INPUT_IMAGE_MAX_BYTES,
            },
          }
        : {}),
      ...(spec.speech
        ? {
            speech: {
              audioFolder: AI_INPUT_FOLDERS[0],
              accepts: ['audio/mpeg', 'audio/wav'],
              maxSeconds: this.settings.number(spec.speech.maxSecondsSetting),
              fromJob: true,
            },
          }
        : {}),
    };
  }

  async list(wawuUserId?: string): Promise<AiToolsView> {
    const plan = this.plan;
    // AITOOLS-07: a link to a short sample of each voice, when the provider has one.
    const samples = await this.voice.samples();
    const hubVoices = this.voice.voices().map((v) => ({
      id: v.id,
      name: v.name,
      description: v.description,
      // The Hub's own path (the app adds its address): the provider's link never leaves the adapter.
      ...(samples.has(v.id) ? { sampleUrl: voiceSamplePath(v.id) } : {}),
    }));
    // AITOOLS-11: the person's SAVED clone joins the voices of the tools that speak, for its owner only, as the first
    // row "Your voice" (the same row the Voice Intro voice is; the saved clone wins).
    const keeps =
      wawuUserId !== undefined && this.clones
        ? (await this.clones.activeFor(wawuUserId)) !== null
        : false;
    const voices = keeps
      ? [
          {
            id: OWN_VOICE_ID,
            name: 'Your voice',
            description: 'Your own voice, kept for your voice tools.',
          },
          ...hubVoices,
        ]
      : hubVoices;
    const tools: AiToolView[] = [];
    for (const tool of ALL_AI_TOOLS) {
      const action = plan.actions.find((a) => a.id === tool.action);
      if (!action) continue;
      const enabled = tool.enabled(this.voice);
      if (!enabled && !tool.listedWhenOff) continue;
      // AITOOLS-08: a new tool is listed only while its own switch is on, so
      // the live app never sees a tool before its screen ships.
      if (
        tool.listingSetting &&
        this.settings.number(tool.listingSetting) !== 1
      )
        continue;
      const spec = tool.input;
      if (isMediaSpec(spec)) {
        // Every entry is whole (id, name, cost, enabled): the live app refuses a whole list for one malformed entry.
        const maxCharacters =
          spec.maxCharactersSetting === null
            ? 0
            : Math.min(
                this.settings.number(spec.maxCharactersSetting),
                plan.caps.maxCharsPerJob,
              );
        tools.push({
          id: tool.id,
          action: action.id,
          name: tool.name,
          description: tool.description,
          unit: tool.unit,
          costPointsPerUnit: action.points,
          enabled,
          input: {
            kind: spec.kind,
            maxCharacters,
            charactersPerUnit: maxCharacters,
            options: this.optionsOf(spec),
          },
          voices: [],
        });
        continue;
      }
      if (spec.kind === 'dialogue') {
        // AITOOLS-11: a scene is priced on its characters, like VoiceOver; the voices are the Hub's and the owner's own.
        const maxCharacters = Math.min(
          this.settings.number(spec.maxCharactersSetting),
          plan.caps.maxCharsPerJob,
        );
        tools.push({
          id: tool.id,
          action: action.id,
          name: tool.name,
          description: tool.description,
          unit: tool.unit,
          costPointsPerUnit: action.points,
          enabled,
          input: {
            kind: 'dialogue',
            maxCharacters,
            charactersPerUnit: this.settings.number(
              spec.charactersPerUnitSetting,
            ),
            dialogue: { maxVoices: spec.maxVoices },
          },
          voices,
        });
        continue;
      }
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
              // AITOOLS-11 and -12: what the newer file tools take beyond the file.
              ...(spec.only ? { only: spec.only } : {}),
              ...(spec.maxSecondsSetting
                ? { maxSeconds: this.settings.number(spec.maxSecondsSetting) }
                : {}),
              ...(spec.voice ? { voice: true as const } : {}),
              ...(spec.clone ? { clone: true as const } : {}),
              ...(spec.description
                ? {
                    description: {
                      maxCharacters: this.settings.number(
                        spec.description.maxCharactersSetting,
                      ),
                    },
                  }
                : {}),
              ...(spec.parts ? { parts: [...spec.parts] } : {}),
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
          voices: spec.voice ? voices : [],
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

  /** A short sample of a listed voice (`GET /ai-tools/voices/{voiceId}/sample`), or null when there is none. */
  sample(voiceId: string): Promise<SpokenAudio | null> {
    return this.voice.voices().some((v) => v.id === voiceId)
      ? this.voice.sample(voiceId)
      : Promise.resolve(null);
  }
}
