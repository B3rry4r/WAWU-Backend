/**
 * EMAIL-01 and EMAIL-02 settings and fixed figures. A campaign goes out
 * through WAWU ID's mail relay (WAWU_ID_BASE_URL and WAWU_ID_INTERNAL_SERVICE_KEY,
 * already set on the server), which sends from WAWU ID's own MAIL_FROM. Only a
 * Hub that also has RESEND_API_KEY sends straight to Resend, from
 * EMAIL_CAMPAIGN_FROM. HUB_PUBLIC_URL (already set for the data export email)
 * is the address the unsubscribe link points at.
 */

/** Used when EMAIL_CAMPAIGN_FROM is unset: the sender WAWU ID already uses. */
export const DEFAULT_EMAIL_CAMPAIGN_FROM =
  'Who Made This? <noreply@wawuafrica.com>';

/** The link every email carries and {{join_link}} fills in. */
export const JOIN_LINK = 'https://wawuafrica.com/join';

/** The two brands an email can be sent as. A missing brand reads as `wmt`. */
export const EMAIL_BRANDS = ['wmt', 'voices'] as const;
export type EmailBrand = (typeof EMAIL_BRANDS)[number];

export function brandOf(value: string | null | undefined): EmailBrand {
  return value === 'voices' ? 'voices' : 'wmt';
}

/** What {{app_link}} and, since EMAIL-03, {{join_link}} fill in, per brand. */
export const APP_LINKS: Record<EmailBrand, string> = {
  wmt: 'https://usewmt.com',
  voices: 'https://usevoices.com',
};

/** The Voices wordmark (white, for the green band), served by WAWU ID. */
export const VOICES_LOGO_URL =
  'https://id.wawuafrica.com/assets/voices/logo-wordmark-white.png';

/** The sender when a Hub with its own RESEND_API_KEY sends a Voices email. */
export const DEFAULT_EMAIL_CAMPAIGN_FROM_VOICES =
  'Voices <noreply@wawuafrica.com>';

/** The logo at the top of every email (a public file on wawuafrica.com). */
export const EMAIL_LOGO_URL = 'https://wawuafrica.com/who-made-this-white.png';

/**
 * At most this many requests to the email provider in any one second.
 * Resend allows 10 a second for the whole team, and WAWU ID's sign-in codes
 * share it (EMAIL-03: lowered from 8).
 */
export const MAX_SENDS_PER_SECOND = 5;

/** One recipient is tried this many times for a transient failure, then marked failed. */
export const MAX_SEND_ATTEMPTS = 3;

/** First wait before a retry; it doubles each time. */
export const RETRY_BASE_MS = 500;

/** The largest CSV the upload accepts. */
export const MAX_CSV_BYTES = 5 * 1024 * 1024;

/** The most recipients one campaign may hold. */
export const MAX_CAMPAIGN_RECIPIENTS = 20_000;

/** How long one call to WAWU ID's relay is waited for. */
export const RELAY_TIMEOUT_MS = 20_000;

/** WAWU ID's address from WAWU_ID_BASE_URL, without a trailing slash; empty when unset. */
export function relayBaseUrl(env: {
  get(key: string): string | undefined;
}): string {
  return (env.get('WAWU_ID_BASE_URL')?.trim() ?? '').replace(/\/+$/, '');
}

/** The shared internal service key; empty when unset (there is no development fallback here). */
export function relayServiceKey(env: {
  get(key: string): string | undefined;
}): string {
  return env.get('WAWU_ID_INTERNAL_SERVICE_KEY')?.trim() ?? '';
}

/** Resend's address. Anything else is refused unless it is a local address. */
export const RESEND_DEFAULT_BASE_URL = 'https://api.resend.com';

export function emailFrom(env: {
  get(key: string): string | undefined;
}): string {
  const set = env.get('EMAIL_CAMPAIGN_FROM')?.trim();
  return set ? set : DEFAULT_EMAIL_CAMPAIGN_FROM;
}

export function emailFromFor(
  env: { get(key: string): string | undefined },
  brand: EmailBrand,
): string {
  if (brand === 'voices') {
    const set = env.get('EMAIL_CAMPAIGN_FROM_VOICES')?.trim();
    return set ? set : DEFAULT_EMAIL_CAMPAIGN_FROM_VOICES;
  }
  return emailFrom(env);
}

/**
 * A Voices address and key, or null when either is unset (Voices is not live).
 * VOICES_API_BASE_URL is the Voices API root INCLUDING its /api/v1 prefix (for
 * example https://api.example.com/api/v1): only a trailing slash is removed and
 * nothing is added. The audience is GET <base>/internal/mail/audience with the
 * key in the X-Service-Key header.
 */
export function voicesApi(env: {
  get(key: string): string | undefined;
}): { base: string; key: string } | null {
  const base = (env.get('VOICES_API_BASE_URL')?.trim() ?? '').replace(
    /\/+$/,
    '',
  );
  const key = env.get('VOICES_INTERNAL_SERVICE_KEY')?.trim() ?? '';
  return base && key ? { base, key } : null;
}

export const VOICES_NOT_LIVE =
  'Voices is not live yet, so its members cannot be listed.';

/** The Resend webhook signing secret (`whsec_...`); empty when unset. */
export function resendWebhookSecret(env: {
  get(key: string): string | undefined;
}): string {
  return env.get('RESEND_WEBHOOK_SECRET')?.trim() ?? '';
}

/** The provider base address: Resend, or a local address (a test stand-in). */
export function resendBaseUrl(env: {
  get(key: string): string | undefined;
}): string {
  const set = env.get('RESEND_BASE_URL')?.trim();
  if (!set) return RESEND_DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(set);
  } catch {
    throw new Error('RESEND_BASE_URL is not a web address.');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.hostname !== 'api.resend.com' && !local) {
    throw new Error(
      'RESEND_BASE_URL may only be api.resend.com or a local address.',
    );
  }
  return set.replace(/\/+$/, '');
}
