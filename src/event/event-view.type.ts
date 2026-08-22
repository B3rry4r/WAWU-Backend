import type {
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
 * There is no price, amount, currency, ticket, purchase, order or credit field
 * on any shape below, and there must never be one. docs/01_SPEC.md cut event
 * TICKETS; reinstating Events (product-owner decision, 22 Aug 2026) did not
 * reinstate those. `goingCount` is an interest signal — a count of people, not
 * a count of sales — and `externalUrl` is where the organiser's own
 * registration lives, off this platform. If a field here starts to look like
 * ticketing, that is a spec conflict and the spec wins.
 */

/** One speaker. `initials` is derived from `name`, never stored (law 13). */
export interface EventSpeakerView {
  name: string;
  title: string | null;
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
