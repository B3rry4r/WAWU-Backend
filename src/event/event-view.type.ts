import type {
  EventCategory,
  EventFormat,
  EventStatus,
  EventType,
} from '../../generated/prisma/enums';

/**
 * The wire shapes for the app-facing Events surface.
 *
 * DECLARED, never a bare re-export of the Prisma model. Protected-surface
 * hazard H-1 records that most types in `src/common/types` are exactly that —
 * a re-export returned by spread — which is why a new column silently widens a
 * live response there. Nothing in this file is generated from a model, so a
 * column added to `Event` tomorrow reaches the wire only if someone adds it
 * here on purpose.
 *
 * ── WHAT IS DELIBERATELY ABSENT ──────────────────────────────────────────────
 * TICKETING IS BACK, by product-owner decision (29 Aug 2026), reversing the
 * cut that docs/01_SPEC.md recorded and the "there must never be a price
 * field here" note that used to sit in this comment. That note was correct
 * when written and is now wrong; leaving it would have the file argue with
 * itself.
 *
 * The shapes below still carry no money, and that is now a SEPARATION rather
 * than a prohibition. An event is the thing; tickets, orders and check-ins
 * are their own models with their own module, so an event that sells nothing
 * — still the common case — is unchanged. `goingCount` remains an interest
 * signal, a count of people rather than a count of sales, and `externalUrl`
 * is still there for an organiser who sells somewhere else.
 */

/** One speaker. `initials` is derived from `name`, never stored (law 13). */
export interface EventSpeakerView {
  name: string;
  title: string | null;
  /** Object-storage URL. Null renders as the initials chip instead. */
  photoUrl: string | null;
  /** Up to two letters, for the avatar chip the old EventsUI rendered. */
  initials: string;
  order: number;
}

/**
 * One event as any signed-in user sees it.
 *
 * `lastDecisionReason` is non-null ONLY when the caller is the host. A
 * rejection or takedown reason is written for the person who has to act on it;
 * echoing it to a stranger on a since-published event would publish a
 * moderator's private note.
 */
export interface EventView {
  id: string;
  hostWawuId: string;
  name: string;
  description: string;
  hostOrg: string;
  hostOrgBio: string | null;

  format: EventFormat;
  type: EventType;

  /** The authoritative instant. Clients format it; the server does not guess a zone. */
  startsAt: Date;
  endsAt: Date | null;
  /** Host-supplied display strings, e.g. "10:00 AM" and "WAT". */
  timeLabel: string | null;
  timezone: string | null;

  location: string;
  address: string | null;
  /** The organiser's own page. Any registration — paid or not — happens THERE. */
  externalUrl: string | null;
  /** Banner image, object-storage URL. */
  bannerUrl: string | null;
  /** What the event is about — the Events section's filter. */
  category: EventCategory;
  contactEmail: string | null;
  contactPhone: string | null;
  /** Set when the organiser called it off; every ticket is voided. */
  cancelledAt: Date | null;
  cancelReason: string | null;

  /** True when the host has posted a recap. Derived, matching the old EventItem.recap. */
  hasRecap: boolean;
  recapUrl: string | null;
  recapText: string | null;

  featured: boolean;
  status: EventStatus;

  /** How many people signalled interest. Never a ticket count, never money. */
  goingCount: number;
  /** Whether the CALLING user is one of them. */
  userGoing: boolean;

  speakers: EventSpeakerView[];
  createdAt: Date;
  /** Why the last rejection or takedown happened. Host-only; null for everyone else. */
  lastDecisionReason: string | null;
}

/** What POST/DELETE `/events/:id/going` return — the whole signal state, so a client never has to guess. */
export interface EventGoingView {
  eventId: string;
  userGoing: boolean;
  goingCount: number;
}

/** Two letters at most, from the first and last word of a name. */
export function initialsFor(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  const first = words[0][0] ?? '';
  const last = words.length > 1 ? (words[words.length - 1][0] ?? '') : '';
  return (first + last).toUpperCase();
}
