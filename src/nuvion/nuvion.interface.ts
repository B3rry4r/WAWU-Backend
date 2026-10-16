/**
 * Nuvion's wire shapes that every call shares (task NUV-01), from Nuvion's
 * own docs (the lead's scratchpad `nuvion/docs/pagination.md`,
 * `errors.md`). The shapes of each resource (entities, accounts, transfers)
 * belong to the area that reads them (src/nuvion/areas/), field by field.
 */

/** Every answer: `{ status, message, data }` (pagination.md, "Response envelope"). */
export interface NuvionEnvelope<T = unknown> {
  status: 'success' | 'error';
  message: string | null;
  data: T;
}

/** `data.meta.pagination` on a list (pagination.md). */
export interface NuvionPagination {
  order: 'asc' | 'desc' | null;
  hasNext: boolean;
  hasPrevious: boolean;
  limit: number | null;
  nextCursor: string | null;
  previousCursor: string | null;
}

/** One page of a list, read from `data.data` and `data.meta.pagination`. */
export interface NuvionListPage<T = unknown> {
  items: T[];
  pagination: NuvionPagination;
}

/** What a successful call answered, with Nuvion's request id when it sent one. */
export interface NuvionAnswer<T = unknown> {
  httpStatus: number;
  data: T;
  message: string | null;
  requestId: string | null;
}

/** The query a list takes (pagination.md, "Request parameters"). */
export interface NuvionListQuery {
  /** 1 to 100; Nuvion's default is 20. */
  limit?: number;
  cursor?: string;
  [key: string]: string | number | boolean | undefined;
}

/**
 * The events Nuvion documents (webhooks__overview.md, "Event types";
 * api-reference__webhooks.md, `enabled_events`). A delivery naming any
 * other well-formed event is stored `pending` all the same, and handed to
 * a handler once one lists it (lead ruling 6): nothing Nuvion sends is
 * dropped because its docs had not named it yet.
 */
export const NUVION_WEBHOOK_EVENTS = [
  'entities.created',
  'entities.updated',
  'accounts.created',
  'accounts.updated',
  'accounts.deleted',
  'account_details.created',
  'account_details.updated',
  'account_details.deleted',
  'inflows.completed',
  'inflows.failed',
  'outflows.created',
  'outflows.completed',
  'outflows.failed',
  'outflows.cancelled',
  'outflows.refunded',
  'funding_sessions.updated',
  'payment_intent.completed',
  'payment_intent.failed',
  'payment_intent.cancelled',
  'payment_dispute.created',
  'payment_dispute.completed',
  'payment_refund.completed',
  'payment_refund.failed',
  'cards.created',
  'cards.frozen',
  'cards.unfrozen',
  'cards.deleted',
] as const;
export type NuvionWebhookEventName = (typeof NUVION_WEBHOOK_EVENTS)[number];
