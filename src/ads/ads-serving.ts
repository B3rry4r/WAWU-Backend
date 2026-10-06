/**
 * How a sponsored card is picked (task ADS-04, R-15). One place, so the
 * service, the tests and ADS-05 and ADS-06 read the same rule.
 *
 * A campaign is served when ALL of these hold at the server's clock:
 *   1. its placement is the one asked for;
 *   2. its status is `scheduled` or `live` (never `draft`, `paused`, `ended`);
 *   3. startsAt <= now < endsAt (the start instant is in, the end instant is out);
 *   4. it has a creative;
 *   5. what the button opens is still open: for `event`, the Event exists, is
 *      `published`, is not cancelled, has not finished (the same "upcoming"
 *      test GET /events uses) and its host is not hidden from the viewer by a
 *      block (the same rule GET /events/:id uses, so the button never leads
 *      to a 404).
 * Of the campaigns that pass, ONE is served: the highest weight first, then
 * the order in AD_TIE_BREAK. A campaign that fails (5) is skipped and the next
 * one is tried, so a card whose event was called off is replaced, not shown.
 * Nothing eligible answers `null`, which the app draws as no card at all.
 *
 * PROVISIONAL(ADS-SERVE-RULE, owner=DEV2, why=no ruling says whether weight is a strict priority or a share of the time; ADS-04 serves the heaviest booking every time and breaks a tie by the order below)
 */
export const SERVED_STATUSES = ['scheduled', 'live'] as const;

/** Heaviest first; the rest of the order decides ties and never changes between calls. */
export const AD_TIE_BREAK = [
  { weight: 'desc' },
  { startsAt: 'asc' },
  { createdAt: 'asc' },
  { id: 'asc' },
] as const;
