/**
 * Phone push settings (INBOX-03).
 *
 * Pushing is OFF unless the server is told to push. A staging or developer
 * machine that has copied production's database must never send a real phone
 * a notification by accident, so the only way on is `PUSH_ENABLED=true`
 * (written out, nothing else counts). Expo's access token is optional: Expo
 * asks for one only when the project turned on its enhanced security.
 *
 * Every number below is a default for a figure Expo does not fix; each is
 * overridable in config where an operator may want to move it.
 */

/** Expo's push service. A host other than these two is refused at send time. */
export const EXPO_PUSH_HOST = 'exp.host';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export const PUSH_CONFIG_KEYS = {
  /** `true` turns the sender and the receipt job on. Anything else is off. */
  enabled: 'PUSH_ENABLED',
  /** Optional. Sent as `Authorization: Bearer` when Expo's enhanced security is on. */
  accessToken: 'EXPO_ACCESS_TOKEN',
  /** Optional. Defaults to `https://exp.host`; only a local address may use plain http. */
  baseUrl: 'EXPO_PUSH_BASE_URL',
} as const;

/**
 * The most messages Expo takes in one send request, and the most receipt ids
 * in one receipt request. Both are Expo's own figures, the ones its server
 * SDK carries as `pushNotificationChunkLimit` (100) and
 * `pushNotificationReceiptChunkLimit` (300).
 */
export const EXPO_SEND_CHUNK = 100;
export const EXPO_RECEIPT_CHUNK = 300;

/**
 * Expo refuses a message whose payload passes 4096 bytes (MessageTooBig in
 * its error list). The body is cut to fit rather than lose the push.
 */
export const EXPO_MAX_PAYLOAD_BYTES = 4096;

/**
 * The kinds of token Expo issues: `ExponentPushToken[...]` and
 * `ExpoPushToken[...]` (the same test its server SDK applies to the string).
 */
export const EXPO_TOKEN_PATTERN = /^Expo(?:nent)?PushToken\[[^\]\s]{1,200}\]$/;

/**
 * PROVISIONAL(PUSH-TOKEN-CAP, owner=YOU, why=nobody has said how many phones one person may have)
 *
 * The most push tokens one person keeps. A new phone beyond it pushes out the
 * one seen longest ago, so signing in on a new phone never fails.
 */
export const PUSH_MAX_TOKENS_PER_USER = 10;

/**
 * PROVISIONAL(PUSH-TIMING, owner=YOU, why=Expo publishes no figures for backoff or send time and the task only asks for a push within a minute)
 *
 * Every figure below that sets how fast or how patiently the sender works:
 * the sweep, the look-back, the retries, the receipt checks and the lock.
 *
 * How often each hub instance looks for notifications to push. A push reaches
 * Expo within about this long after the notification is written.
 */
export const PUSH_SWEEP_SECONDS = 10;

/**
 * How far back the sweep reads notifications. The unique key on a delivery
 * makes a notification seen twice harmless, so this only has to be longer
 * than a notification can sit uncommitted and shorter than a push is worth
 * sending.
 */
export const PUSH_LOOKBACK_MINUTES = 15;

/**
 * A send Expo refused with 429 or 5xx, or that could not reach Expo, is tried
 * again after `retryBaseSeconds` doubled for each earlier attempt, up to
 * `maxAttempts` tries in all. Past that the delivery is `failed`.
 */
export const PUSH_RETRY = { maxAttempts: 5, retryBaseSeconds: 5 } as const;

/**
 * When to ask Expo for a receipt: `firstCheckSeconds` after the send, then
 * every `retrySeconds` while Expo has none, until `giveUpHours` after the
 * send (Expo keeps a receipt for about a day), when the delivery is marked
 * `expired`.
 */
export const PUSH_RECEIPTS = {
  firstCheckSeconds: 60,
  retrySeconds: 300,
  giveUpHours: 24,
} as const;

/**
 * A delivery held for sending longer than this was dropped by an instance
 * that stopped mid-send. It is marked `failed`, never sent again: Expo may
 * already have taken it, and a missing push is better than a double one (the
 * notification is still in the app).
 */
export const PUSH_LOCK_SECONDS = 120;

/**
 * PROVISIONAL(PUSH-TTL, owner=YOU, why=Expo defaults to four weeks and that is too long for a reply or a refund)
 *
 * How long Expo keeps trying to hand a push to a phone that is off.
 */
export const PUSH_TTL_SECONDS = 86_400;

/**
 * PROVISIONAL(PUSH-RETENTION, owner=YOU, why=no retention period for a dead token or a send log is set)
 *
 * A token Expo reported dead is disabled at once and deleted this many days
 * later.
 */
export const PUSH_DISABLED_KEEP_DAYS = 30;

/** How long one request to Expo may take before it is treated as unanswered. */
export const PUSH_REQUEST_TIMEOUT_MS = 20_000;

/** The deliveries one sweep tick sends, and the receipts one tick asks about. */
export const PUSH_BATCH_LIMIT = 500;

export interface PushSettings {
  /** True only when `PUSH_ENABLED` is exactly `true`. */
  on: boolean;
  /** `https://exp.host`, or a local address for a test double. */
  baseUrl: string;
  accessToken: string | null;
}

/** Thrown at boot when `EXPO_PUSH_BASE_URL` names somewhere a token must not go. */
export class PushConfigError extends Error {}

/**
 * Reads the settings from the environment on every call, so a test (or an
 * operator's restart) sees the current values. A base URL that is set is
 * checked: Expo's own host over https, or a local address.
 */
export function loadPushSettings(
  env: NodeJS.ProcessEnv = process.env,
): PushSettings {
  const raw = (env[PUSH_CONFIG_KEYS.baseUrl] ?? '').trim();
  const baseUrl =
    raw === '' ? `https://${EXPO_PUSH_HOST}` : raw.replace(/\/+$/, '');
  assertAllowedBaseUrl(baseUrl);
  const token = (env[PUSH_CONFIG_KEYS.accessToken] ?? '').trim();
  return {
    on: (env[PUSH_CONFIG_KEYS.enabled] ?? '').trim() === 'true',
    baseUrl,
    accessToken: token === '' ? null : token,
  };
}

export function assertAllowedBaseUrl(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new PushConfigError(`${PUSH_CONFIG_KEYS.baseUrl} is not a URL.`);
  }
  const local = LOCAL_HOSTS.has(url.hostname);
  const expo = url.protocol === 'https:' && url.hostname === EXPO_PUSH_HOST;
  if (!local && !expo) {
    throw new PushConfigError(
      `${PUSH_CONFIG_KEYS.baseUrl} must be https://${EXPO_PUSH_HOST} or a local address.`,
    );
  }
}
