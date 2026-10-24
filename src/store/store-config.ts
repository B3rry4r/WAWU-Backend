import type { StorePlatform } from '../../generated/prisma/enums';

/** The Nest token the parsed store settings are provided under. */
export const STORE_CONFIG = 'STORE_CONFIG';

/** The store's cut when nothing is set: 15%, in basis points (R-86, Default (lead), owner may override). */
export const DEFAULT_STORE_FEE_BPS = 1500;

/** The service account Google Play's server API is called as. */
export interface GoogleServiceAccount {
  client_email: string;
  private_key: string;
  /** Where the JWT is exchanged for an access token. Google's own unless the key file says otherwise. */
  token_uri: string;
}

export interface GooglePlayConfig {
  packageName: string;
  serviceAccount: GoogleServiceAccount;
  /** The Android Publisher API's origin. Google's unless a stand-in is named. */
  apiBase: string;
  /**
   * The Pub/Sub push subscription's identity. The notification route refuses
   * every request until BOTH are set: the token's audience (the endpoint's own
   * URL) and the service account the subscription signs as.
   */
  pubsubAudience: string | null;
  pubsubServiceAccountEmail: string | null;
  /** Where Google's token signing keys are read from. */
  jwksUrl: string;
}

export interface AppStoreConfig {
  bundleId: string;
  issuerId: string;
  keyId: string;
  /** The `.p8` key, PEM text. */
  privateKey: string;
  /** `Production` or `Sandbox`. In Production a sandbox transaction is also accepted (App Review). */
  environment: 'Production' | 'Sandbox';
  /** Apple's root certificates the signed answers' chain must end in (PEM, one or more). */
  rootCertificates: Buffer[];
  /** The app's Apple id, required by the signed-data check in Production. */
  appAppleId: number | null;
}

export interface StoreConfig {
  google: GooglePlayConfig | null;
  apple: AppStoreConfig | null;
  /** The store's cut per platform, in basis points. */
  feeBps: Record<StorePlatform, number>;
}

const GOOGLE_API = 'https://androidpublisher.googleapis.com';
const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';

function text(env: NodeJS.ProcessEnv, key: string): string | null {
  const v = env[key];
  return v !== undefined && v.trim() !== '' ? v.trim() : null;
}

function feeOf(env: NodeJS.ProcessEnv, key: string): number {
  const raw = text(env, key);
  if (raw === null) return DEFAULT_STORE_FEE_BPS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 10_000)
    throw new Error(
      `${key} must be a whole number of basis points, 0 to 10000.`,
    );
  return n;
}

/** The service account key, as the JSON text or as that text in base64. Null when it is not set or not usable. */
function serviceAccountOf(raw: string | null): GoogleServiceAccount | null {
  if (raw === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    try {
      json = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    } catch {
      return null;
    }
  }
  if (typeof json !== 'object' || json === null) return null;
  const o = json as Record<string, unknown>;
  if (typeof o.client_email !== 'string' || typeof o.private_key !== 'string')
    return null;
  return {
    client_email: o.client_email,
    private_key: o.private_key,
    token_uri:
      typeof o.token_uri === 'string' && o.token_uri !== ''
        ? o.token_uri
        : GOOGLE_TOKEN_URI,
  };
}

function pemBlocks(raw: string | null): Buffer[] {
  if (raw === null) return [];
  const text = raw.replace(/\\n/g, '\n');
  const blocks =
    text.match(
      /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
    ) ?? [];
  return blocks.map((b) => Buffer.from(b, 'utf8'));
}

/**
 * Reads the store settings from the environment (IAP-01). Nothing here is a
 * secret that is written anywhere: a store is `null` until everything it needs
 * is set, and every store route then answers `store_not_configured`. The cut
 * is read here, per platform: `STORE_FEE_BPS_ANDROID` and `STORE_FEE_BPS_IOS`,
 * 1500 (15%) when unset.
 */
export function loadStoreConfig(
  env: NodeJS.ProcessEnv = process.env,
): StoreConfig {
  const packageName = text(env, 'GOOGLE_PLAY_PACKAGE_NAME');
  const serviceAccount = serviceAccountOf(
    text(env, 'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON'),
  );
  const google: GooglePlayConfig | null =
    packageName !== null && serviceAccount !== null
      ? {
          packageName,
          serviceAccount,
          apiBase: text(env, 'GOOGLE_PLAY_API_BASE') ?? GOOGLE_API,
          pubsubAudience: text(env, 'GOOGLE_PLAY_PUBSUB_AUDIENCE'),
          pubsubServiceAccountEmail: text(
            env,
            'GOOGLE_PLAY_PUBSUB_SERVICE_ACCOUNT_EMAIL',
          ),
          jwksUrl: text(env, 'GOOGLE_PLAY_JWKS_URL') ?? GOOGLE_JWKS,
        }
      : null;

  const bundleId = text(env, 'APPLE_BUNDLE_ID');
  const issuerId = text(env, 'APPLE_ISSUER_ID');
  const keyId = text(env, 'APPLE_KEY_ID');
  const privateKey = text(env, 'APPLE_PRIVATE_KEY');
  const environment = text(env, 'APPLE_ENVIRONMENT');
  const roots = pemBlocks(text(env, 'APPLE_ROOT_CERTIFICATES'));
  const appAppleIdRaw = text(env, 'APPLE_APP_ID');
  const appAppleId =
    appAppleIdRaw !== null && /^\d+$/.test(appAppleIdRaw)
      ? Number(appAppleIdRaw)
      : null;
  const envOk = environment === 'Production' || environment === 'Sandbox';
  const apple: AppStoreConfig | null =
    bundleId !== null &&
    issuerId !== null &&
    keyId !== null &&
    privateKey !== null &&
    envOk &&
    roots.length > 0 &&
    (environment === 'Sandbox' || appAppleId !== null)
      ? {
          bundleId,
          issuerId,
          keyId,
          privateKey: privateKey.replace(/\\n/g, '\n'),
          environment,
          rootCertificates: roots,
          appAppleId,
        }
      : null;

  return {
    google,
    apple,
    feeBps: {
      android: feeOf(env, 'STORE_FEE_BPS_ANDROID'),
      ios: feeOf(env, 'STORE_FEE_BPS_IOS'),
    },
  };
}
