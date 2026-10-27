import { Inject, Injectable, Logger } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import type { StorePlatform } from '../../../generated/prisma/enums';
import type { LadderStep } from '../store-ladder';
import { buyProductId } from '../store-ladder';

/**
 * Changing the Nigeria prices of the `wawu.buy.<naira>` products in Google Play and
 * App Store Connect through the stores' own APIs (STORE-CUT30, R-101 point 9).
 *
 * Only when the server has the keys for that store. The keys here are NOT the
 * ones that verify purchases: changing a price needs the store's publishing
 * API (Google: a service account allowed to manage in-app products; Apple: an
 * App Store Connect API key with the App Manager role). Without them the Hub
 * changes its own price list and tells the owner, in a notice, to change the
 * store's prices by hand. Names are in the README ("Store price changes").
 */

export const STORE_PRICE_CONFIG = 'STORE_PRICE_CONFIG';

export interface GooglePriceConfig {
  packageName: string;
  serviceAccount: {
    client_email: string;
    private_key: string;
    token_uri: string;
  };
  apiBase: string;
}

export interface ApplePriceConfig {
  appId: string;
  issuerId: string;
  keyId: string;
  /** The `.p8` key, PEM text. */
  privateKey: string;
  apiBase: string;
}

export interface StorePriceConfig {
  google: GooglePriceConfig | null;
  apple: ApplePriceConfig | null;
}

const GOOGLE_API = 'https://androidpublisher.googleapis.com';
const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const APPLE_API = 'https://api.appstoreconnect.apple.com';

function text(env: NodeJS.ProcessEnv, key: string): string | null {
  const v = env[key];
  return v !== undefined && v.trim() !== '' ? v.trim() : null;
}

function serviceAccountOf(raw: string | null) {
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

/** Reads the price-change keys from the environment. A store is `null` until everything it needs is set. */
export function loadStorePriceConfig(
  env: NodeJS.ProcessEnv = process.env,
): StorePriceConfig {
  const packageName = text(env, 'STORE_PRICE_GOOGLE_PACKAGE_NAME');
  const serviceAccount = serviceAccountOf(
    text(env, 'STORE_PRICE_GOOGLE_SERVICE_ACCOUNT_JSON'),
  );
  const appId = text(env, 'STORE_PRICE_APPLE_APP_ID');
  const issuerId = text(env, 'STORE_PRICE_APPLE_ISSUER_ID');
  const keyId = text(env, 'STORE_PRICE_APPLE_KEY_ID');
  const privateKey = text(env, 'STORE_PRICE_APPLE_PRIVATE_KEY');
  return {
    google:
      packageName !== null && serviceAccount !== null
        ? {
            packageName,
            serviceAccount,
            apiBase: text(env, 'STORE_PRICE_GOOGLE_API_BASE') ?? GOOGLE_API,
          }
        : null,
    apple:
      appId !== null &&
      /^\d+$/.test(appId) &&
      issuerId !== null &&
      keyId !== null &&
      privateKey !== null
        ? {
            appId,
            issuerId,
            keyId,
            privateKey: privateKey.replace(/\\n/g, '\n'),
            apiBase: text(env, 'STORE_PRICE_APPLE_API_BASE') ?? APPLE_API,
          }
        : null,
  };
}

/** What changing a store's prices came to: `no_keys` (nothing was tried), or how many changed. */
export interface PriceSyncResult {
  state: 'no_keys' | 'done' | 'partial' | 'failed';
  /** The store product ids that were changed. */
  changed: string[];
  /** The store product ids that were not, to change by hand. */
  failed: string[];
}

const TIMEOUT_MS = 20_000;

async function call(
  url: string,
  init: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const t = await res.text().catch(() => '');
  let body: unknown = {};
  try {
    body = t === '' ? {} : JSON.parse(t);
  } catch {
    body = {};
  }
  return { status: res.status, body };
}

/** Google Play: Android Publisher `inappproducts.patch`, the Nigeria (NG) price of one product. */
async function googleSet(
  c: GooglePriceConfig,
  token: string,
  step: LadderStep,
): Promise<void> {
  const sku = buyProductId(step.listNaira);
  const url = `${c.apiBase.replace(/\/$/, '')}/androidpublisher/v3/applications/${encodeURIComponent(c.packageName)}/inappproducts/${encodeURIComponent(sku)}?autoConvertMissingPrices=false`;
  const res = await call(url, {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      packageName: c.packageName,
      sku,
      prices: {
        NG: {
          currency: 'NGN',
          priceMicros: String(BigInt(step.storeNaira) * 1_000_000n),
        },
      },
    }),
  });
  if (res.status < 200 || res.status >= 300)
    throw new Error(`Google answered ${res.status}`);
}

async function googleToken(c: GooglePriceConfig): Promise<string> {
  const sa = c.serviceAccount;
  const iat = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    {
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/androidpublisher',
      aud: sa.token_uri,
      iat,
      exp: iat + 3000,
    },
    sa.private_key,
    { algorithm: 'RS256' },
  );
  const res = await call(sa.token_uri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });
  const b = res.body as { access_token?: string };
  if (res.status !== 200 || typeof b.access_token !== 'string')
    throw new Error('Google gave no access token');
  return b.access_token;
}

interface AscDoc {
  data?: Array<{ id?: string; attributes?: { customerPrice?: string } }>;
  links?: { next?: string };
}

/** App Store Connect: find the product, find the Nigeria price point for the price, set the base price. */
async function appleSet(
  c: ApplePriceConfig,
  token: string,
  step: LadderStep,
): Promise<void> {
  const base = c.apiBase.replace(/\/$/, '');
  const headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  };
  const sku = buyProductId(step.listNaira);
  const found = await call(
    `${base}/v1/apps/${encodeURIComponent(c.appId)}/inAppPurchasesV2?filter[productId]=${encodeURIComponent(sku)}&limit=1`,
    { method: 'GET', headers },
  );
  const iapId = (found.body as AscDoc).data?.[0]?.id;
  if (found.status !== 200 || typeof iapId !== 'string')
    throw new Error(`App Store Connect does not know ${sku}`);
  let url: string | undefined =
    `${base}/v2/inAppPurchases/${encodeURIComponent(iapId)}/pricePoints?filter[territory]=NGA&limit=200`;
  let pricePointId: string | null = null;
  for (let page = 0; url !== undefined && page < 20; page += 1) {
    const res = await call(url, { method: 'GET', headers });
    if (res.status !== 200) throw new Error(`Apple answered ${res.status}`);
    const doc = res.body as AscDoc;
    const hit = (doc.data ?? []).find(
      (p) => Number(p.attributes?.customerPrice) === step.storeNaira,
    );
    if (hit?.id) {
      pricePointId = hit.id;
      break;
    }
    url = doc.links?.next;
  }
  if (pricePointId === null)
    throw new Error(`Apple has no ${step.storeNaira} naira price point`);
  const set = await call(`${base}/v1/inAppPurchasePriceSchedules`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      data: {
        type: 'inAppPurchasePriceSchedules',
        relationships: {
          inAppPurchase: { data: { type: 'inAppPurchases', id: iapId } },
          baseTerritory: { data: { type: 'territories', id: 'NGA' } },
          manualPrices: {
            data: [{ type: 'inAppPurchasePrices', id: '${price0}' }],
          },
        },
      },
      included: [
        {
          type: 'inAppPurchasePrices',
          id: '${price0}',
          attributes: { startDate: null },
          relationships: {
            inAppPurchasePricePoint: {
              data: { type: 'inAppPurchasePricePoints', id: pricePointId },
            },
          },
        },
      ],
    }),
  });
  if (set.status < 200 || set.status >= 300)
    throw new Error(`Apple answered ${set.status}`);
}

function appleToken(c: ApplePriceConfig): string {
  const iat = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { iss: c.issuerId, iat, exp: iat + 1200, aud: 'appstoreconnect-v1' },
    c.privateKey,
    { algorithm: 'ES256', keyid: c.keyId },
  );
}

@Injectable()
export class StorePriceSync {
  private readonly logger = new Logger(StorePriceSync.name);

  constructor(
    @Inject(STORE_PRICE_CONFIG) private readonly config: StorePriceConfig,
  ) {}

  /** True when the server holds the keys to change this store's prices. */
  hasKeys(platform: StorePlatform): boolean {
    return (
      (platform === 'android' ? this.config.google : this.config.apple) !== null
    );
  }

  /**
   * Sets the Nigeria price of every product of `ladder` in the store, one at a
   * time (idempotent: a price set again is the same price). A product that
   * cannot be changed is named in `failed`; the rest are still tried.
   */
  async apply(
    platform: StorePlatform,
    ladder: readonly LadderStep[],
  ): Promise<PriceSyncResult> {
    const changed: string[] = [];
    const failed: string[] = [];
    if (!this.hasKeys(platform)) return { state: 'no_keys', changed, failed };
    let set: (step: LadderStep) => Promise<void>;
    try {
      if (platform === 'android') {
        const c = this.config.google as GooglePriceConfig;
        const token = await googleToken(c);
        set = (s) => googleSet(c, token, s);
      } else {
        const c = this.config.apple as ApplePriceConfig;
        const token = appleToken(c);
        set = (s) => appleSet(c, token, s);
      }
    } catch (e) {
      this.logger.error(
        `store price change (${platform}): could not sign in to the store (${e instanceof Error ? e.message.slice(0, 120) : 'error'})`,
      );
      return {
        state: 'failed',
        changed,
        failed: ladder.map((s) => buyProductId(s.listNaira)),
      };
    }
    for (const step of ladder) {
      const id = buyProductId(step.listNaira);
      try {
        await set(step);
        changed.push(id);
      } catch (e) {
        failed.push(id);
        this.logger.error(
          `store price change (${platform}): ${id} was not changed (${e instanceof Error ? e.message.slice(0, 120) : 'error'})`,
        );
      }
    }
    return {
      state:
        failed.length === 0
          ? 'done'
          : changed.length === 0
            ? 'failed'
            : 'partial',
      changed,
      failed,
    };
  }
}
