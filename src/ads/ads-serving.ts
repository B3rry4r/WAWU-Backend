import type { PrismaService } from '../common/prisma/prisma.service';
import type { BlockedAccountService } from '../blocked-account/blocked-account.service';
import type { AdPlacementName } from './dto/ads.dto';

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

/** What a serving check needs: the database and the block list. */
export interface ServingDeps {
  prisma: PrismaService;
  blocked: BlockedAccountService;
}

/** A campaign that passed every rule above, with the fields a card carries. */
export interface ServableCampaign {
  id: string;
  advertiser: string;
  creative: {
    headline: string;
    subline: string | null;
    ctaLabel: string;
    ctaDestination: 'event';
    ctaDestinationId: string;
    artworkUrl: string | null;
  };
}

/**
 * THE ONE ELIGIBILITY RULE, rules 1 to 5 above, in the order of AD_TIE_BREAK.
 * GET /ads (ADS-04) serves the first of the answer; counting a view, tap or
 * skip (ADS-05) accepts a campaign only if it is in the answer for that
 * viewer at that instant. Both call this, so they cannot disagree.
 * `placement` and `campaignId` narrow the search; neither changes the rule.
 */
export async function servableCampaigns(
  deps: ServingDeps,
  viewerWawuId: string,
  now: Date,
  narrow: { placement?: AdPlacementName; campaignId?: string },
): Promise<ServableCampaign[]> {
  const candidates = await deps.prisma.adCampaign.findMany({
    where: {
      ...(narrow.placement ? { placement: narrow.placement } : {}),
      ...(narrow.campaignId ? { id: narrow.campaignId } : {}),
      status: { in: [...SERVED_STATUSES] },
      startsAt: { lte: now },
      endsAt: { gt: now },
      creative: { isNot: null },
    },
    orderBy: [...AD_TIE_BREAK],
    select: {
      id: true,
      advertiser: true,
      creative: {
        select: {
          headline: true,
          subline: true,
          ctaLabel: true,
          ctaDestination: true,
          ctaDestinationId: true,
          artworkUrl: true,
        },
      },
    },
  });
  if (candidates.length === 0) return [];

  const open = await openEventIds(
    deps,
    viewerWawuId,
    candidates.flatMap((c) =>
      c.creative?.ctaDestination === 'event'
        ? [c.creative.ctaDestinationId]
        : [],
    ),
    now,
  );

  const out: ServableCampaign[] = [];
  for (const c of candidates) {
    const creative = c.creative;
    // Anything this code cannot check is not served.
    if (!creative || creative.ctaDestination !== 'event') continue;
    if (!open.has(creative.ctaDestinationId)) continue;
    out.push({
      id: c.id,
      advertiser: c.advertiser,
      creative: { ...creative, ctaDestination: 'event' },
    });
  }
  return out;
}

/**
 * Of these Event ids, the ones a person can still open: published, not
 * cancelled, not finished (`endsAt ?? startsAt` not before now, as in
 * GET /events upcoming) and not hosted by somebody hidden from the viewer.
 */
async function openEventIds(
  deps: ServingDeps,
  viewerWawuId: string,
  ids: string[],
  now: Date,
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const hidden = await deps.blocked.hiddenFrom(viewerWawuId);
  const rows = await deps.prisma.event.findMany({
    where: {
      id: { in: ids },
      status: 'published',
      cancelledAt: null,
      hostWawuId: { notIn: hidden },
      OR: [{ endsAt: { gte: now } }, { endsAt: null, startsAt: { gte: now } }],
    },
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
}
