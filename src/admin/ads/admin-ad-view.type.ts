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

/**
 * The wire shapes for the admin ads surface. DECLARED views, not Prisma
 * re-exports, as in src/admin/events/admin-event-view.type.ts. Nothing here is
 * a price, an advertiser account or a payment: ads are invoiced by hand (R-15).
 *
 * Views, taps and skips are not here. ADS-05 counts them in tables that do not
 * exist yet, and a field nothing writes is never shipped; ADS-05 adds them to
 * the report views when it adds the tables (BACKEND_GAPS.md).
 */

/** The card, as the app draws it. */
export interface AdCreativeView {
  headline: string;
  subline: string | null;
  ctaLabel: string;
  ctaDestination: AdCtaDestination;
  ctaDestinationId: string;
  artworkUrl: string | null;
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
  placement: AdPlacement;
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
   * True when serving would show this card to a person right now: status
   * scheduled or live, the window holds now, and its event is open.
   */
  servingNow: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Another booking on the same placement whose window overlaps this one. */
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
   * Other drafts-excluded bookings (scheduled, live or paused) on this
   * placement whose window overlaps this one. Overlap is allowed; serving
   * picks one by weight.
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

/** What deleting a draft returns. The campaign is gone; its history is not. */
export interface AdCampaignDeletedView {
  campaignId: string;
  audit: AdAuditEntryView;
}

/** GET /admin/ads/:id/report. */
export interface AdCampaignReportView {
  campaign: AdCampaignView;
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
    from: Date | null;
    to: Date | null;
  };
  campaigns: number;
  byStatus: Record<AdCampaignStatus, number>;
  byPlacement: Record<AdPlacement, number>;
  byPhase: Record<AdPhase, number>;
  /** Campaigns serving would show right now, over everything (not only the filter). */
  servingNow: Record<AdPlacement, number>;
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
