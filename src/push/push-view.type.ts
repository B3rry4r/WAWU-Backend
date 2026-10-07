/** Response shapes of the push token routes (task INBOX-03). One named interface each. */

/** POST /push-tokens. The token is never sent back. */
export interface PushTokenRegistered {
  registered: true;
}

/** DELETE /push-tokens. `removed` is false when the caller had no such token (an answer, not an error: removing twice is fine). */
export interface PushTokenRemoved {
  removed: boolean;
}
