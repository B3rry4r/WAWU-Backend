import type { PlansConfig } from '../../plans/plans-config';
import { PointsError } from '../../points/points-error';
import { AiToolError } from '../ai-tools-error';
import {
  asPrompt,
  type AiToolRequest,
  type AiToolSettings,
  type PromptInputSpec,
} from './ai-tool';

/**
 * The limits a prompt tool (Sound effect, Music track) holds a request to,
 * read from its settings on each call (R-65). Each refusal happens before
 * anything is priced or held, so it names the limit and holds nothing.
 *
 *  - the description's length in characters: the tool's own setting
 *    (`ai.sfx_max_prompt_chars`, `ai.music_max_prompt_chars`); the plan's
 *    per-job character cap is checked by the hold after this;
 *  - the length asked for: the tool's own setting in seconds
 *    (`ai.sfx_max_seconds`, `ai.music_max_seconds`), and the plan's longest
 *    audio job (`points.max_audio_min_per_job`), which bounds a track too.
 */
export function checkPromptLimits(
  spec: PromptInputSpec,
  req: AiToolRequest,
  settings: AiToolSettings,
  plan: Pick<PlansConfig, 'caps'>,
): void {
  const { prompt, seconds } = asPrompt(req);
  const characters = Array.from(prompt).length;
  const maxCharacters = settings.number(spec.maxCharactersSetting);
  if (characters > maxCharacters)
    throw new AiToolError(
      'ai_prompt_too_long',
      `Describe it in ${maxCharacters} characters or fewer. This one has ${characters}. No points were taken.`,
      {
        cap: 'prompt_characters',
        capLimit: maxCharacters,
        capUnit: 'characters',
      },
    );
  if (seconds === null) return;
  const maxSeconds = settings.number(spec.length.maxSecondsSetting);
  if (seconds > maxSeconds)
    throw new AiToolError(
      'ai_length_too_long',
      `The longest is ${maxSeconds} seconds. No points were taken.`,
      { cap: 'length_seconds', capLimit: maxSeconds, capUnit: 'seconds' },
    );
  // The plan's longest audio job bounds the length too, named as POINTS-03 names it.
  const maxMinutes = plan.caps.maxAudioMinPerJob;
  if (seconds > maxMinutes * 60)
    throw new PointsError(
      'points_cap_reached',
      `One job can run up to ${maxMinutes} minutes. This one is ${seconds} seconds.`,
      {
        cap: 'minutes_per_job',
        capLimit: maxMinutes,
        capUnit: 'minutes',
        resetsAt: null,
      },
    );
}
