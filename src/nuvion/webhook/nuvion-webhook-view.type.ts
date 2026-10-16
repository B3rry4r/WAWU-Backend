/**
 * What `POST /webhooks/nuvion` answers (task NUV-01). Nuvion reads only the
 * HTTP status (a 2xx stops its retries); the body is for whoever reads the
 * delivery log in Nuvion's dashboard (`GET /webhook-logs`).
 */
export interface NuvionWebhookAck {
  /**
   * `recorded`: stored for the first time. `duplicate`: this event (by its
   * id, or by its signed timestamp and body) was already stored; nothing
   * was written.
   */
  outcome: 'recorded' | 'duplicate';
  /** The event name as stored; null when the delivery named none. */
  event: string | null;
}
