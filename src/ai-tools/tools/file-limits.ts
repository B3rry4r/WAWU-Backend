import type { PlansConfig } from '../../plans/plans-config';
import { PointsError } from '../../points/points-error';
import { asFile, type AiToolRequest } from './ai-tool';

/**
 * The limit a file tool holds a request to (AITOOLS-04): the plan's longest
 * audio job (`points.max_audio_min_per_job`, an admin setting), checked against
 * the minutes the Hub read from the file itself. Refused before anything is
 * held, named as POINTS-03 names it. The file's size is checked earlier, when
 * the file is opened (`ai.input_max_bytes`).
 */
export function checkFileLimits(
  req: AiToolRequest,
  plan: Pick<PlansConfig, 'caps'>,
): void {
  const { minutes } = asFile(req);
  const max = plan.caps.maxAudioMinPerJob;
  if (minutes > max)
    throw new PointsError(
      'points_cap_reached',
      `One job can run up to ${max} ${max === 1 ? 'minute' : 'minutes'}. This one is ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`,
      {
        cap: 'minutes_per_job',
        capLimit: max,
        capUnit: 'minutes',
        resetsAt: null,
      },
    );
}

/** Seconds above the priced length that the provider may report before the job fails (the Hub never charges less than the work). */
export const LENGTH_SLACK_SECONDS = 60;
