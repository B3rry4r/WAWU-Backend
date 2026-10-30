import type { AiTool, AiToolId } from './ai-tool';
import { CAPTIONS_TOOL } from './captions.tool';
import { CLEAN_AUDIO_TOOL } from './clean-audio.tool';
import { DUBBING_TOOL } from './dubbing.tool';
import { IMAGE_TOOL } from './image.tool';
import { MUSIC_TOOL } from './music.tool';
import { PHOTO_EDIT_TOOL } from './photo-edit.tool';
import { QUICK_VOICE_TOOL } from './quick-voice.tool';
import { SOUND_EFFECT_TOOL } from './sound-effect.tool';
import { TALKING_PHOTO_TOOL } from './talking-photo.tool';
import { VIDEO_TOOL } from './video.tool';
import { VOICEOVER_TOOL } from './voiceover.tool';

/**
 * THE TOOL REGISTRY (AITOOLS-02, R-78). The tools the Hub can run, in the
 * order Studio lists them. A tool is here only once its code is built: the
 * next tasks add one file and one entry each (AITOOLS-03 added Sound effect and Music track, AITOOLS-04 Captions and Clean audio, AITOOLS-05 Dubbing; -06 follows). `GET
 * /ai-tools` lists from here, and every `POST /ai-tools/{id}/jobs` route
 * hands its tool to the one pipeline.
 */
export const AI_TOOLS: readonly AiTool[] = [
  VOICEOVER_TOOL,
  QUICK_VOICE_TOOL,
  SOUND_EFFECT_TOOL,
  MUSIC_TOOL,
  CAPTIONS_TOOL,
  CLEAN_AUDIO_TOOL,
  DUBBING_TOOL,
];

/**
 * The Studio picture and video tools (R-109, AITOOLS-09 and -10), kept apart
 * from the seven above so that list stays the launch set the older specs pin.
 * Each is listed only while its own `ai.listed.<id>` setting is on (AITOOLS-08).
 */
export const AI_STUDIO2_TOOLS: readonly AiTool[] = [
  IMAGE_TOOL,
  PHOTO_EDIT_TOOL,
  VIDEO_TOOL,
  TALKING_PHOTO_TOOL,
];

/** Every tool the Hub can run, in the order Studio lists them: the pipeline, the catalogue and the follower read this. */
export const ALL_AI_TOOLS: readonly AiTool[] = [
  ...AI_TOOLS,
  ...AI_STUDIO2_TOOLS,
];

/** The tool whose plan action a job row names (`tool` column), or null for an action no built tool prices. */
export function toolForAction(action: string): AiTool | null {
  return ALL_AI_TOOLS.find((t) => t.action === action) ?? null;
}

export function toolById(id: AiToolId): AiTool {
  const tool = ALL_AI_TOOLS.find((t) => t.id === id);
  if (!tool) throw new Error(`no AI tool with id ${id}`);
  return tool;
}
