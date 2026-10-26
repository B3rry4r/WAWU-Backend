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
 *   4. it has a creative with artwork (R-59: a card is never drawn without a
 *      picture; campaigns saved before ADS-07 without one are skipped);
 *   5. what a tap opens is still open. A `link` card opens a web address and a
 *      `none` card opens nothing, so neither has anything to check (R-92: ads
 *      are not tied to events). For `event` (campaigns saved before R-92), the
 *      Event exists, is `published`, is not cancelled, has not finished (the
 *      same "upcoming" test GET /events uses) and its host is not hidden from
 *      the viewer by a block (the same rule GET /events/:id uses, so the
 *      button never leads to a 404).
 * Of the campaigns that pass, ONE is served for `tgif_card` and `today_slot`:
 * the highest weight first, then the order in AD_TIE_BREAK. The Explore slider
 * (`explore_slider`, ADS-07) serves ALL of them, in that same order. A campaign that fails (5) is skipped and the next
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
    /** What a tap does (R-92). */
    ctaDestination: 'event' | 'link' | 'none';
    /** The button's words. Null for `none`: no button is drawn. */
    ctaLabel: string | null;
    /** An Event id, for `event` only. */
    ctaDestinationId: string | null;
    /** The https address, for `link` only. */
    ctaUrl: string | null;
    artworkUrl: string;
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
      creative: { is: { artworkUrl: { not: null } } },
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
          ctaUrl: true,
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
      c.creative?.ctaDestination === 'event' && c.creative.ctaDestinationId
        ? [c.creative.ctaDestinationId]
        : [],
    ),
    now,
  );

  const out: ServableCampaign[] = [];
  for (const c of candidates) {
    const creative = c.creative;
    if (!creative || !creative.artworkUrl) continue;
    // Anything this code cannot check is not served: the fields a kind needs
    // are checked here as well as by the database, so a card is never drawn
    // half built.
    const served = {
      ...creative,
      artworkUrl: creative.artworkUrl,
    };
    if (creative.ctaDestination === 'event') {
      if (!creative.ctaLabel || !creative.ctaDestinationId) continue;
      if (!open.has(creative.ctaDestinationId)) continue;
    } else if (creative.ctaDestination === 'link') {
      if (!creative.ctaLabel || !creative.ctaUrl) continue;
    }
    out.push({ id: c.id, advertiser: c.advertiser, creative: served });
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
