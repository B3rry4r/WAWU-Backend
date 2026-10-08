/**
 * One stored Nuvion delivery as a handler sees it (task NUV-01). `data` is
 * the body's `data` exactly as stored (NUL characters replaced); a handler
 * reads it field by field and, as Nuvion advises, fetches the resource
 * again before it acts on money (`GET /transfers/{id}`, guides).
 */
export interface NuvionDelivery {
  /** NuvionWebhookEvent.id. */
  id: string;
  /** `x-nuvion-event-id`. */
  eventId: string;
  /**
   * The event's name, lower case: one of NUVION_WEBHOOK_EVENTS, or one
   * Nuvion sends without documenting it (stored `pending` all the same).
   */
  event: string;
  resourceId: string | null;
  entityId: string | null;
  data: unknown;
  receivedAt: Date;
  /** Tries so far, this one included. */
  attempts: number;
}

/**
 * What a handler did with one delivery:
 * - `done`: handled, or not this handler's (another payment type, say);
 * - `wait`: not now (Nuvion could not be asked, the row it updates is not
 *   there yet); tried again later, backing off;
 * - `failed`: it can never be used; kept for review with `note`.
 * `note` is our own words: never a BVN, NIN, PIN, document or Nuvion text.
 */
export type NuvionHandlerResult =
  | { outcome: 'done'; note: string }
  | { outcome: 'wait'; note: string }
  | { outcome: 'failed'; note: string };

/**
 * A handler of Nuvion events (task NUV-01's registry). Each later task
 * (NUV-02 to NUV-08) owns one handler file in this folder and fills it; the
 * receiver and the dispatcher never change. A handler must be idempotent:
 * Nuvion may deliver an event twice (webhooks__overview.md, "Idempotency"),
 * and a delivery is tried again after any handler waits.
 */
export interface NuvionEventHandler {
  /** The task that owns it, for notes and logs. */
  readonly task: string;
  /**
   * The events it handles, by name as stored (lower case). Several handlers
   * may share an event. Documented names are NUVION_WEBHOOK_EVENTS; a name
   * Nuvion sends undocumented may be listed too, and its rows already
   * stored are handed over on the next sweep.
   */
  readonly events: readonly string[];
  handle(delivery: NuvionDelivery): Promise<NuvionHandlerResult>;
}
