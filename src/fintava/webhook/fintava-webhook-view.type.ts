/**
 * What `POST /webhooks/fintava` answers (task MONEY-07). Fintava reads only
 * the HTTP status (200 stops its retries); the body is for whoever looks at
 * the delivery log on its dashboard.
 */
export interface FintavaWebhookAck {
  /**
   * `recorded`: stored for the first time. `duplicate`: this event, with
   * this reference and status, was already stored (a retry or a replay);
   * nothing was written.
   */
  outcome: 'recorded' | 'duplicate';
  /** The event name as stored (lower case); null when the delivery named none. */
  event: string | null;
}
