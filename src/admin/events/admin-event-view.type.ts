import type { AdminEventReviewModel } from '../../../generated/prisma/models';
import type {
  AccountType,
  EventFormat,
  EventStatus,
  EventType,
  TicketTier,
} from '../../../generated/prisma/enums';
import type { EventSpeakerView } from '../../event/event-view.type';

/**
 * The wire shapes for the admin Events surface.
 *
 * DECLARED views, not Prisma re-exports — same rule as
 * `src/admin/content-review/admin-content-view.type.ts` and for the same
 * reason (protected-surface hazard H-1). These are also deliberately NOT the
 * app's `EventView`: an admin sees the host block, the moderation history and
 * `lastDecisionReason` unconditionally, none of which the app's shape carries
 * for a stranger.
 *
 * As on the app side: no price, amount, currency, ticket or purchase field
 * exists here and none may be added. Events take no money in this product.
 */

/** Who submitted this, in the words the app itself uses for them. */
export interface AdminEventHostView {
  wawuUserId: string;
  handle: string | null;
  accountType: AccountType | null;
}

/** One row of an admin events list. */
export interface AdminEventListItemView {
  id: string;
  name: string;
  description: string;
  hostOrg: string;
  hostOrgBio: string | null;
  format: EventFormat;
  type: EventType;
  startsAt: Date;
  endsAt: Date | null;
  timeLabel: string | null;
  timezone: string | null;
  location: string;
  address: string | null;
  externalUrl: string | null;
  hasRecap: boolean;
  recapUrl: string | null;
  recapText: string | null;
  featured: boolean;
  status: EventStatus;
  /** The reason for the last rejection or takedown. Shown to the host too. */
  lastDecisionReason: string | null;
  /** People who signalled interest. Never a ticket count — nothing was sold. */
  goingCount: number;
  speakers: EventSpeakerView[];
  createdAt: Date;
  updatedAt: Date;
  /** Whole hours since submission — how a queue is triaged when it is oldest-first. */
  waitingHours: number;
  host: AdminEventHostView;
}

/** One decision from the audit trail. */
export interface AdminEventReviewEntryView {
  id: string;
  action: AdminEventReviewModel['action'];
  previousStatus: EventStatus;
  newStatus: EventStatus;
  previousFeatured: boolean;
  newFeatured: boolean;
  reason: string | null;
  reviewedByAdminId: string;
  reviewedByAdminEmail: string;
  reviewedByAdminRole: AdminEventReviewModel['reviewedByAdminRole'];
  reviewedAt: Date;
}

/** Full detail for one event, including everything ever decided about it. */
export interface AdminEventDetailView extends AdminEventListItemView {
  /** Newest decision first. Empty until this event has been moderated. */
  reviewHistory: AdminEventReviewEntryView[];
}

/**
 * One ticket type as a reviewer sees it (R-42, F2): the tier, its name, its
 * price in naira (the same whole-naira figure the public tiers carry) and
 * how many there are and have sold. A reviewer approving an event approves
 * what it charges, so the prices are on the screen they decide from.
 */
export interface AdminEventTicketTypeView {
  id: string;
  tier: TicketTier;
  name: string;
  priceNaira: number;
  quantity: number;
  sold: number;
}

/** GET /admin/events/queue: a queue row, with the event's ticket types. */
export interface AdminEventQueueItemView extends AdminEventListItemView {
  ticketTypes: AdminEventTicketTypeView[];
}

/** GET /admin/events/:id: the detail, with the event's ticket types. */
export interface AdminEventReviewDetailView extends AdminEventDetailView {
  ticketTypes: AdminEventTicketTypeView[];
}

/** What every write endpoint on this surface returns. */
export interface AdminEventDecisionView {
  event: AdminEventDetailView;
  review: AdminEventReviewEntryView;
}

export function toAdminEventReviewEntryView(
  row: AdminEventReviewModel,
): AdminEventReviewEntryView {
  return {
    id: row.id,
    action: row.action,
    previousStatus: row.previousStatus,
    newStatus: row.newStatus,
    previousFeatured: row.previousFeatured,
    newFeatured: row.newFeatured,
    reason: row.reason,
    reviewedByAdminId: row.reviewedByAdminId,
    reviewedByAdminEmail: row.reviewedByAdminEmail,
    reviewedByAdminRole: row.reviewedByAdminRole,
    reviewedAt: row.reviewedAt,
  };
}
