/** Response shapes of the push token routes (task INBOX-03). One named interface each. */

/** POST /push-tokens. The token is never sent back. `registered` is false only for an account whose deletion has been asked for: nothing was stored. */
export interface PushTokenRegistered {
  registered: boolean;
}

/** DELETE /push-tokens. `removed` is false when the caller had no such token (an answer, not an error: removing twice is fine). */
export interface PushTokenRemoved {
  removed: boolean;
}
