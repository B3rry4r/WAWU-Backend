import type { AiTool, AiToolId } from './ai-tool';
import { AUDIOBOOK_TOOL } from './audiobook.tool';
import { CAPTIONS_TOOL } from './captions.tool';
import { CLEAN_AUDIO_TOOL } from './clean-audio.tool';
import { DIALOGUE_TOOL } from './dialogue.tool';
import { DUBBING_TOOL } from './dubbing.tool';
import { IMAGE_TOOL } from './image.tool';
import { MUSIC_TOOL } from './music.tool';
import { MY_VOICE_TOOL } from './my-voice.tool';
import { PHOTO_EDIT_TOOL } from './photo-edit.tool';
import { PODCAST_TOOL } from './podcast.tool';
import { RECEPTIONIST_TOOL } from './receptionist.tool';
import { QUICK_VOICE_TOOL } from './quick-voice.tool';
import { SOUND_EFFECT_TOOL } from './sound-effect.tool';
import { STEMS_TOOL } from './stems.tool';
import { TALKING_PHOTO_TOOL } from './talking-photo.tool';
import { VIDEO_MUSIC_TOOL } from './video-music.tool';
import { VIDEO_TOOL } from './video.tool';
import { VOICE_CHANGER_TOOL } from './voice-changer.tool';
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
  // AITOOLS-11, AITOOLS-12: Voice changer, Dialogue, Clone your own voice, Music for a video, Split a song.
  VOICE_CHANGER_TOOL,
  DIALOGUE_TOOL,
  MY_VOICE_TOOL,
  VIDEO_MUSIC_TOOL,
  STEMS_TOOL,
  // AITOOLS-13: Audiobook and Podcast maker.
  AUDIOBOOK_TOOL,
  PODCAST_TOOL,
  // AITOOLS-06: the Receptionist's text messages (setting it up and talking to it are routes of their own).
  RECEPTIONIST_TOOL,
];

/** Every tool the Hub can run, in the order Studio lists them: the pipeline, the catalogue and the follower read this. */
export const ALL_AI_TOOLS: readonly AiTool[] = [
  ...AI_TOOLS,
  ...AI_STUDIO2_TOOLS,
];

/** The tool whose plan action a job row names (`tool` column), or null for an action no built tool prices. */
export function toolForAction(action: string): AiTool | null {
  return (
    ALL_AI_TOOLS.find(
      (t) => t.action === action || t.alsoActions?.includes(action),
    ) ?? null
  );
}

export function toolById(id: AiToolId): AiTool {
  const tool = ALL_AI_TOOLS.find((t) => t.id === id);
  if (!tool) throw new Error(`no AI tool with id ${id}`);
  return tool;
}
