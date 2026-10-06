import type { AdCampaignStatus } from '../../../generated/prisma/enums';

/**
 * The life of an ad campaign, written once (ADS-06).
 *
 *   draft ──schedule──> scheduled | live ──pause──> paused ──resume──> scheduled | live
 *     │                      │                          │
 *     └────────end───────────┴────────────end───────────┘──> ended (final)
 *
 * What each status means to the rest of the system:
 *  - ADS-04 (serving) serves a campaign whose status is `scheduled` or `live`
 *    and whose window holds the server's clock. It never serves `draft`,
 *    `paused` or `ended`. So "pause" takes effect on the very next request:
 *    the status is the thing serving reads, and nothing caches it.
 *  - `scheduled` and `live` differ only in what the team did. A schedule or a
 *    resume made after the window has started stores `live`; one made before it
 *    stores `scheduled`. Nothing moves a campaign from `scheduled` to `live`
 *    when the window opens, because serving does not need it to: no timer
 *    exists and none is needed. What a campaign is doing now is `phase`
 *    (upcoming, running, over), worked out from the window and the clock.
 *  - `ended` is final. A campaign whose window has passed keeps its status
 *    until someone ends it; it is simply not served, because the window no
 *    longer holds the clock.
 *
 * A repeat of an action (pause a paused campaign) is a refusal, never a quiet
 * success: the second of two requests that race is refused the same way.
 */

export type AdAction = 'schedule' | 'pause' | 'resume' | 'end';

/** The statuses each action may start from. */
export const ACTION_FROM: Record<AdAction, readonly AdCampaignStatus[]> = {
  schedule: ['draft'],
  pause: ['scheduled', 'live'],
  resume: ['paused'],
  end: ['draft', 'scheduled', 'live', 'paused'],
};

/** Statuses in which the card's words, window and weight may be changed. */
export const EDITABLE_STATUSES: readonly AdCampaignStatus[] = [
  'draft',
  'paused',
];

/** Only a draft can be deleted: anything else has been, or could have been, on air. */
export const DELETABLE_STATUSES: readonly AdCampaignStatus[] = ['draft'];

/** The statuses ADS-04 serves, inside the window. */
export const SERVED_STATUSES: readonly AdCampaignStatus[] = [
  'scheduled',
  'live',
];

/**
 * Where a campaign goes when it is put on air at `now`: `live` if its window
 * has started, `scheduled` if it has not.
 */
export function onAirStatus(startsAt: Date, now: Date): 'scheduled' | 'live' {
  return startsAt.getTime() <= now.getTime() ? 'live' : 'scheduled';
}

export type AdPhase = 'upcoming' | 'running' | 'over';

export function phaseOf(startsAt: Date, endsAt: Date, now: Date): AdPhase {
  if (now.getTime() < startsAt.getTime()) return 'upcoming';
  if (now.getTime() < endsAt.getTime()) return 'running';
  return 'over';
}
