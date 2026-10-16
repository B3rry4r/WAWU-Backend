/**
 * Response shapes for the caller's own lists (task ME-10): the Me menu's
 * counts (M7), Saved (M30), My purchases (M29), Notifications (M31, M32) and
 * this month's earnings (M7, M18). One named type each, so the contract
 * carries every shape by name (docs/contract/CONVENTIONS.md section 0, G-1).
 *
 * Money is integer kobo in fields ending `Kobo` (CONVENTIONS section 1).
 * Lists are cursor pages (section 6): `nextCursor` is opaque, `null` on the
 * last page, and the order is newest first.
 */
import type { FeedCreator } from '../content-piece/feed-cards.service';

/** A person as these lists show one: real name (else handle), avatar, ticks. */
export type MePerson = FeedCreator;

/* ------------------------------------------------------------------ */
/* GET /me/counts (M7)                                                  */
/* ------------------------------------------------------------------ */

/** The Me menu's figures, in one read (M7). Each is a count of rows the caller can see. */
export interface MeCountsView {
  /** Pieces bought: completed content purchases. M7 "My purchases 12". */
  purchases: number;
  /** Saved content, events and creators, counted as GET /me/saved lists them. M7 "Saved 31". */
  saved: number;
  /** Unread notifications. M7 "Notifications 3 new". */
  unreadNotifications: number;
}

/* ------------------------------------------------------------------ */
/* GET /me/saved (M30)                                                  */
/* ------------------------------------------------------------------ */

export type SavedKind = 'content' | 'event' | 'creator';

/** A saved piece (M30: "Agency breakdown ₦2,500", "Free", "Bought"). */
export interface SavedContentView {
  id: string;
  title: string;
  contentType: 'video' | 'course' | 'audio' | 'pdf' | 'image' | 'template';
  accessType: 'free' | 'paid';
  /** The price in kobo; null when the piece is free. */
  priceKobo: number | null;
  /** The piece's preview picture, a fresh link; null when it has none. */
  thumbnailUrl: string | null;
  /** True when the caller has a completed purchase of it (M30 "Bought"). */
  bought: boolean;
  creator: MePerson;
}

/** A saved event (M30: "Lagos Creators Meetup · Sat 4 Oct"). */
export interface SavedEventView {
  id: string;
  name: string;
  /** ISO 8601 UTC. */
  startsAt: string;
  endsAt: string | null;
  location: string;
  bannerUrl: string | null;
  /** `cancelled` stays listed so a person sees what became of it. */
  status: 'published' | 'cancelled';
}

/** One row of Saved: exactly one of `content`, `event`, `creator` is set, by `kind`. */
export interface SavedEntryView {
  /** The save's own id (stable for paging), not the thing's. */
  id: string;
  kind: SavedKind;
  /** When it was saved, ISO 8601 UTC. */
  savedAt: string;
  content: SavedContentView | null;
  event: SavedEventView | null;
  creator: MePerson | null;
}

export interface SavedPage {
  items: SavedEntryView[];
  nextCursor: string | null;
}

/** PUT and DELETE /me/saved/creators/:wawuId. */
export interface SavedCreatorState {
  creatorWawuId: string;
  saved: boolean;
}

/* ------------------------------------------------------------------ */
/* GET /me/purchases (M29) and lesson progress                          */
/* ------------------------------------------------------------------ */

/** Lessons in a course piece and how many of them the caller finished (M29 "3 of 12 done"). */
export interface LessonProgressView {
  total: number;
  done: number;
}

export interface PurchasedPieceView {
  id: string;
  title: string;
  /** Picks the row's action on M29: video Watch, pdf Read, course Resume, template Download. */
  contentType: 'video' | 'course' | 'audio' | 'pdf' | 'image' | 'template';
  thumbnailUrl: string | null;
  creator: MePerson;
}

export interface PurchaseEntryView {
  /** The purchase's id. */
  id: string;
  /** When it was bought, ISO 8601 UTC (M29 "26 Sep"). */
  purchasedAt: string;
  content: PurchasedPieceView;
  /** Set for a course piece; null for every other type. */
  lessons: LessonProgressView | null;
}

export interface PurchasePage {
  items: PurchaseEntryView[];
  nextCursor: string | null;
}

/** PUT and DELETE /me/lessons/:lessonId/done. */
export interface LessonDoneState {
  lessonId: string;
  contentId: string;
  done: boolean;
  lessons: LessonProgressView;
}

/* ------------------------------------------------------------------ */
/* GET /me/notifications (M31, M32)                                     */
/* ------------------------------------------------------------------ */

/** M31's filter chips. `all` is every kind. */
export type NotificationCategory = 'money' | 'messages' | 'content' | 'other';

/**
 * What opening the notification opens. `id` is the thing's id: a piece, a
 * paid question (DirectMessage), a room, or a person's wawuId.
 */
export interface NotificationTargetView {
  kind: 'content' | 'paid_question' | 'community' | 'profile';
  id: string;
  /** The piece's title or the room's name, as it is now; null for a question or a person. */
  title: string | null;
  /** A paid question's reply deadline (M31 "1h 12m left"), ISO 8601 UTC; null otherwise. */
  deadlineAt: string | null;
}

export interface NotificationFeedItem {
  id: string;
  kind: string;
  category: NotificationCategory;
  title: string;
  body: string;
  tone: string;
  /** The money the notification reports, in kobo (sale, tip, paid question, refund); null otherwise. */
  amountKobo: number | null;
  /** WAWU Credits, a count, never naira (credits_low). */
  creditsCount: number | null;
  actionLabel: string | null;
  imageUrl: string | null;
  /** An in-app path, set only on announcements, reminders and room approvals. */
  actionHref: string | null;
  read: boolean;
  /** ISO 8601 UTC. */
  createdAt: string;
  /** Null when the notification names nothing (older rows too); the app then routes by `kind`. */
  target: NotificationTargetView | null;
  /** The other person in it (buyer, tipper, follower, asker, rater); null when none, or hidden by a block. */
  actor: MePerson | null;
}

export interface NotificationFeedPage {
  items: NotificationFeedItem[];
  nextCursor: string | null;
  /** Every unread notification, whatever the filter. */
  unreadCount: number;
}

/* ------------------------------------------------------------------ */
/* GET /me/earnings and /me/earnings/sales (M7, M18)                    */
/* ------------------------------------------------------------------ */

/** One Africa/Lagos month's earnings. */
export interface EarningsMonthView {
  /** YYYY-MM, Africa/Lagos. */
  month: string;
  earnedKobo: number;
}

/**
 * What the caller earned in a month, from their own completed sales. Never a
 * balance: the wallet's balance is the provider's (CONVENTIONS section 1).
 */
export interface MyEarningsView {
  /** YYYY-MM, Africa/Lagos: the month asked for, this month by default. */
  month: string;
  /** The creator's share of that month's completed sales, in kobo. */
  earnedKobo: number;
  /** How many completed sales made it. */
  salesCount: number;
  previousMonth: string;
  previousEarnedKobo: number;
  /** Whole-percent change on the previous month (M18 "+18%"); null when the previous month earned nothing. */
  changePct: number | null;
  /** The twelve months ending with `month`, oldest first (M18's bars). */
  months: EarningsMonthView[];
}

export type EarningStream =
  'content' | 'tip' | 'paid_question' | 'community_credits';

/** One completed sale and what the creator earned from it. */
export interface EarningSaleView {
  id: string;
  stream: EarningStream;
  /** The creator's share, in kobo. */
  earnedKobo: number;
  /** When it was earned, ISO 8601 UTC. */
  occurredAt: string;
  /** The piece's title, or the room's name for credits; null for a tip or a paid question. */
  title: string | null;
  /** The piece sold; null for every other stream. */
  contentId: string | null;
}

export interface EarningSalePage {
  /** YYYY-MM, Africa/Lagos. */
  month: string;
  items: EarningSaleView[];
  nextCursor: string | null;
}
