import type {
  AdminRole,
  NotificationAudience,
  NotificationCampaignStatus,
} from '../../../generated/prisma/enums';

/**
 * Wire shapes for the admin campaign surface.
 *
 * DECLARED views, not Prisma re-exports, same as every other admin resource
 * here (protected-surface hazard H-1). Nothing on the campaign row is secret,
 * but a re-export means the next column added to the model is published to
 * the dashboard by accident rather than by decision.
 */

/** One campaign, as the dashboard lists and reads it. */
export interface AdminCampaignView {
  id: string;
  title: string;
  body: string;
  imageUrl: string | null;
  actionLabel: string | null;
  actionHref: string | null;
  tone: string;
  audience: NotificationAudience;
  status: NotificationCampaignStatus;
  /**
   * How many accounts the audience matched when it was dispatched. Zero on a
   * draft, because nothing has been resolved yet - not "no recipients".
   */
  recipientCount: number;
  /**
   * How many notification rows were actually written. Always <=
   * recipientCount; the difference is everybody with "Offers and news"
   * switched off.
   */
  deliveredCount: number;
  failureReason: string | null;
  createdByAdminEmail: string;
  createdByAdminRole: AdminRole;
  dispatchedByAdminEmail: string | null;
  dispatchedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * One audience option with its LIVE size.
 *
 * The count is a real `COUNT(*)` run when the dashboard asks, never a stored
 * or estimated figure. `optedIn` is the same population minus everybody who
 * has switched "Offers and news" off, so an admin sees what a send will
 * actually reach before pressing the button rather than after.
 */
export interface AdminAudienceView {
  audience: NotificationAudience;
  label: string;
  description: string;
  size: number;
  optedIn: number;
}

/** What one dispatch did. */
export interface AdminCampaignDispatchView {
  campaign: AdminCampaignView;
  recipientCount: number;
  deliveredCount: number;
  /** recipientCount - deliveredCount, named so nobody has to work it out. */
  suppressedByPreference: number;
}
