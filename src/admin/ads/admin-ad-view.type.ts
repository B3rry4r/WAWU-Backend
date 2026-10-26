import type { AdminAdAuditModel } from '../../../generated/prisma/models';
import type {
  AdCampaignStatus,
  AdCtaDestination,
  AdPlacement,
  AdminAdAction,
  AdminRole,
  EventStatus,
} from '../../../generated/prisma/enums';
import type { AdPhase } from './ad-campaign-state';
import type { AdCounts, AdDayCounts } from '../../ads/ads-counts.type';

/**
 * The wire shapes for the admin ads surface. DECLARED views, not Prisma
 * re-exports, as in src/admin/events/admin-event-view.type.ts. Nothing here is
 * a price, an advertiser account or a payment: ads are invoiced by hand (R-15).
 *
 * Views, taps and skips are `delivery`, read from ADS-05's counts through
 * AdsCountsService; nothing here recounts them.
 */

/** The card, as the app draws it. */
export interface AdCreativeView {
  headline: string;
  subline: string | null;
  /** The button's words. Null for a `none` card, which draws no button. */
  ctaLabel: string | null;
  /** What a tap does (R-92): `link`, `none`, or `event` on campaigns that already use it. */
  ctaDestination: AdCtaDestination;
  /** The Event id, for an `event` card only; null otherwise. */
  ctaDestinationId: string | null;
  /**
   * The https address a `link` card opens, in its normal form. Present for a
   * `link` card only; left out for the other two, so an `event` card's view is
   * unchanged.
   */
  ctaUrl?: string;
  /**
   * The single picture of a booking saved before the two shapes (R-92); null
   * for a booking that holds a landscape or portrait picture. Such a booking
   * shows in its own `placement` only. New code reads `landscapeUrl` and
   * `portraitUrl`, which are filled for both kinds.
   */
  artworkUrl: string | null;
  /**
   * A signed link that shows the picture, for a picture uploaded through
   * `POST /admin/ads/artwork` (its `artworkUrl` is not readable by itself: the
   * bucket is private). Left out for a typed link, which `artworkUrl` already
   * shows.
   */
  artworkPreviewUrl?: string;
  /**
   * The landscape picture (16:9, 1920 x 1080): shown in the Explore slider AND
   * on the Today strip. For a booking saved before the two shapes it is its
   * single picture when that was for Explore or Today (and that booking still
   * shows in its own place only; see `shows` on the campaign). Null: no
   * landscape picture.
   */
  landscapeUrl: string | null;
  /** A signed link that shows `landscapeUrl` (a picture uploaded to the Hub). Left out for a typed link. */
  landscapePreviewUrl?: string;
  /**
   * The portrait picture (1080 x 2340, a phone screen): shown in the TGIF full
   * screen. For a booking saved before the two shapes it is its single picture
   * when that was for TGIF. Null: no portrait picture.
   */
  portraitUrl: string | null;
  /** A signed link that shows `portraitUrl` (a picture uploaded to the Hub). Left out for a typed link. */
  portraitPreviewUrl?: string;
}

/** The thing the card's button opens, as it stands now. Null when it no longer exists. */
export interface AdEventView {
  id: string;
  name: string;
  status: EventStatus;
  startsAt: Date;
  endsAt: Date | null;
  /**
   * Whether serving would still show a card that opens it: published, not
   * called off and not over. When this turns false the card is skipped by
   * serving; the campaign itself is left as it is.
   */
  open: boolean;
}

/** One campaign with its card: a row of the list, and the head of every other view. */
export interface AdCampaignView {
  id: string;
  advertiser: string;
  /**
   * Where a booking saved before the two shapes shows. For a booking with a
   * landscape or portrait picture it is only derived (explore_slider when it
   * has a landscape picture, else tgif_card) and decides nothing: read `shows`.
   */
  placement: AdPlacement;
  /**
   * The places this booking shows in, from the pictures it holds (R-92): a
   * landscape picture = explore_slider and today_slot, a portrait picture =
   * tgif_card. A booking saved before the two shapes shows in its own
   * `placement` only. Empty for a booking with no picture.
   */
  shows: AdPlacement[];
  /** The team's decision: draft, scheduled, live, paused or ended. */
  status: AdCampaignStatus;
  /** What the window is doing now: upcoming, running or over. */
  phase: AdPhase;
  /** UTC instants. Served when startsAt <= now < endsAt. */
  startsAt: Date;
  endsAt: Date;
  weight: number;
  creative: AdCreativeView | null;
  event: AdEventView | null;
  /**
   * True when this campaign has no artwork and is not ended: it was saved
   * before artwork became required (R-59), it is not served, and it needs a
   * picture before it can be (pause it if it is on air, then edit it). The
   * list filter `artwork=missing` returns exactly these.
   */
  needsArtwork: boolean;
  /**
   * True when serving would show this card to a person right now: status
   * scheduled or live, the window holds now, it has artwork, and its event is
   * open.
   */
  servingNow: boolean;
  /**
   * Views, taps and skips counted by ADS-05, and `ctr` (taps over views as a
   * fraction, null when there are no views). Zeros for a campaign nothing was
   * counted for. All days on a detail or a write; the days asked for on a
   * list row or a report.
   */
  delivery: AdCounts;
  createdAt: Date;
  updatedAt: Date;
}

/** Another booking that shows in one of the same places and whose window overlaps this one. */
export interface AdOverlapView {
  id: string;
  advertiser: string;
  status: AdCampaignStatus;
  startsAt: Date;
  endsAt: Date;
  weight: number;
}

/** One change from the audit trail. */
export interface AdAuditEntryView {
  id: string;
  action: AdminAdAction;
  previousStatus: AdCampaignStatus | null;
  newStatus: AdCampaignStatus | null;
  /** `{ field: { from, to } }` for what the action changed. */
  changes: Record<string, { from: unknown; to: unknown }> | null;
  adminId: string;
  adminEmail: string;
  adminRole: AdminRole;
  createdAt: Date;
}

/** One campaign in full, with everything ever done to it. */
export interface AdCampaignDetailView extends AdCampaignView {
  /**
   * Other drafts-excluded bookings (scheduled, live or paused) that show in
   * one of the places this one shows in, and whose window overlaps this one.
   * Overlap is allowed; serving picks one by weight.
   */
  overlapping: AdOverlapView[];
  /** Newest first. */
  history: AdAuditEntryView[];
}

/** What every write on a campaign returns. */
export interface AdCampaignChangeView {
  campaign: AdCampaignDetailView;
  audit: AdAuditEntryView;
}

/**
 * What `POST /admin/ads/artwork` returns (ADS-LINK): the picture is stored and
 * nothing is attached to a campaign yet.
 */
export interface AdArtworkUploadView {
  /** Save this as the card's `artworkUrl`. The bare address of the stored picture: serving signs it afresh. */
  artworkUrl: string;
  /** A signed link that shows the picture now. It expires; do not save it. */
  previewUrl: string;
  /** The size of the stored file in bytes. */
  bytes: number;
}

/** What deleting a draft returns. The campaign is gone; its history is not. */
export interface AdCampaignDeletedView {
  campaignId: string;
  audit: AdAuditEntryView;
}

/** GET /admin/ads/:id/report. */
export interface AdCampaignReportView {
  campaign: AdCampaignView;
  /** What `from` and `to` asked for and the UTC days they became. All null: every day. */
  range: {
    from: Date | null;
    to: Date | null;
    fromDay: string | null;
    toDay: string | null;
  };
  /** The counts over the range: the sum of `days`. */
  delivery: AdCounts;
  /** Oldest first. A day nothing was counted on has no entry. */
  days: AdDayCounts[];
  timing: {
    /** Whole minutes in the window. */
    windowMinutes: number;
    /** Whole minutes of the window that have passed, 0 before it and the whole window after. */
    elapsedMinutes: number;
    remainingMinutes: number;
  };
  /** What the team has done to it, from the audit trail. */
  activity: {
    changes: number;
    pauses: number;
    lastActionAt: Date | null;
  };
}

/** GET /admin/ads/report: the bookings in a range, counted. */
export interface AdSummaryReportView {
  generatedAt: Date;
  filters: {
    placement: AdPlacement | null;
    status: AdCampaignStatus | null;
    phase: AdPhase | null;
    artwork: 'missing' | null;
    from: Date | null;
    to: Date | null;
  };
  campaigns: number;
  /** Views, taps and skips of the campaigns counted above, over the range's UTC days. */
  delivery: AdCounts;
  deliveryByStatus: Record<AdCampaignStatus, AdCounts>;
  /**
   * Counts by place. A booking that shows in several places is added under
   * each of them, so the places can add up to more than `delivery`: the app
   * reports a view or tap per booking, not per place.
   */
  deliveryByPlacement: Record<AdPlacement, AdCounts>;
  byStatus: Record<AdCampaignStatus, number>;
  /** Bookings by the places they show in (R-92): one that shows in two places is counted in both. */
  byPlacement: Record<AdPlacement, number>;
  byPhase: Record<AdPhase, number>;
  /** Campaigns serving would show right now in each place, over everything (not only the filter). */
  servingNow: Record<AdPlacement, number>;
  /** Campaigns with no artwork that are not ended, over everything (not only the filter): what the team still has to fix (R-59). */
  needingArtwork: number;
}

export function toAdAuditEntryView(row: AdminAdAuditModel): AdAuditEntryView {
  return {
    id: row.id,
    action: row.action,
    previousStatus: row.previousStatus,
    newStatus: row.newStatus,
    changes: row.changes as AdAuditEntryView['changes'],
    adminId: row.adminId,
    adminEmail: row.adminEmail,
    adminRole: row.adminRole,
    createdAt: row.createdAt,
  };
}
