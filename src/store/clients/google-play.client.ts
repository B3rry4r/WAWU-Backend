import { Injectable } from '@nestjs/common';
import jwksClient from 'jwks-rsa';
import * as jwt from 'jsonwebtoken';
import type { GooglePlayConfig } from '../store-config';
import {
  GooglePushRefused,
  StorePurchaseNotFound,
  StoreUnreachable,
  type GooglePlayClient,
  type VerifiedStorePurchase,
} from './store-clients';

/** Seconds the service account's access token is asked to live (Google caps it at an hour). */
const TOKEN_SECONDS = 3000;
/** Milliseconds a call to Google may take. */
const CALL_TIMEOUT_MS = 15_000;
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

interface Money {
  currencyCode?: string;
  units?: string;
  nanos?: number;
}

function microsOf(m: Money | undefined): {
  currency: string | null;
  micros: bigint | null;
} {
  if (!m || typeof m.currencyCode !== 'string')
    return { currency: null, micros: null };
  try {
    const units = BigInt(m.units ?? '0');
    const nanos = BigInt(Math.trunc(m.nanos ?? 0));
    return {
      currency: m.currencyCode,
      micros: units * 1_000_000n + nanos / 1000n,
    };
  } catch {
    return { currency: m.currencyCode, micros: null };
  }
}

/**
 * Google Play's server API as the Hub's service account (task IAP-01, R-86):
 * `purchases.products` for the packs, `purchases.subscriptionsv2` for tiers and
 * passes. The access token comes from the service account's key (a signed JWT
 * exchanged at the key file's own `token_uri`); nothing is cached beyond the
 * token's own life. Each call has a timeout, and a transport failure is
 * `StoreUnreachable`, never a verdict on the purchase.
 *
 * Nothing here holds a database transaction: it only talks to Google.
 */
@Injectable()
export class RealGooglePlayClient implements GooglePlayClient {
  private token: { value: string; until: number } | null = null;
  private keys: ReturnType<typeof jwksClient> | null = null;

  constructor(private readonly config: GooglePlayConfig) {}

  async verifyOneTime(
    storeProductId: string,
    purchaseToken: string,
  ): Promise<VerifiedStorePurchase> {
    const body = await this.call<{
      purchaseTimeMillis?: string;
      purchaseState?: number;
      consumptionState?: number;
      acknowledgementState?: number;
      orderId?: string;
      purchaseType?: number;
      refundableQuantity?: number;
      productId?: string;
      obfuscatedExternalAccountId?: string;
    }>(
      'GET',
      `purchases/products/${enc(storeProductId)}/tokens/${enc(purchaseToken)}`,
    );
    // The answer names the product the token was bought for. A token bought
    // for another product is not this purchase, whatever the URL asked.
    if (typeof body.productId === 'string' && body.productId !== storeProductId)
      throw new StorePurchaseNotFound(
        'The purchase token is for another product.',
      );
    const state =
      body.purchaseState === 0
        ? 'purchased'
        : body.purchaseState === 2
          ? 'pending'
          : 'cancelled';
    return {
      platform: 'android',
      // purchaseType 0 is a test purchase (a licence tester); absent is a real one.
      environment: body.purchaseType === 0 ? 'sandbox' : 'production',
      storeProductId: body.productId ?? storeProductId,
      accountToken: accountTokenOf(body.obfuscatedExternalAccountId),
      storeTransactionId:
        typeof body.orderId === 'string' && body.orderId !== ''
          ? body.orderId
          : purchaseToken,
      subscriptionKey: null,
      purchasedAt: new Date(Number(body.purchaseTimeMillis ?? 0)),
      expiresAt: null,
      currency: null,
      priceMicros: null,
      state,
      needsAcknowledge:
        state === 'purchased' &&
        (body.acknowledgementState === 0 || body.consumptionState === 0),
    };
  }

  async verifySubscription(
    purchaseToken: string,
  ): Promise<VerifiedStorePurchase> {
    const body = await this.call<{
      latestOrderId?: string;
      startTime?: string;
      subscriptionState?: string;
      acknowledgementState?: string;
      testPurchase?: object;
      externalAccountIdentifiers?: { obfuscatedExternalAccountId?: string };
      lineItems?: Array<{
        productId?: string;
        expiryTime?: string;
        autoRenewingPlan?: { recurringPrice?: Money };
        prepaidPlan?: unknown;
      }>;
    }>('GET', `purchases/subscriptionsv2/tokens/${enc(purchaseToken)}`);
    const line = body.lineItems?.[0];
    if (!line || typeof line.productId !== 'string' || !body.latestOrderId)
      throw new StorePurchaseNotFound();
    const expiresAt = line.expiryTime ? new Date(line.expiryTime) : null;
    const s = body.subscriptionState ?? '';
    const live =
      s === 'SUBSCRIPTION_STATE_ACTIVE' ||
      s === 'SUBSCRIPTION_STATE_CANCELED' ||
      s === 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD';
    const state =
      s === 'SUBSCRIPTION_STATE_PENDING'
        ? 'pending'
        : live && expiresAt !== null && expiresAt.getTime() > Date.now()
          ? 'purchased'
          : 'cancelled';
    const { currency, micros } = microsOf(
      line.autoRenewingPlan?.recurringPrice,
    );
    return {
      platform: 'android',
      environment: body.testPurchase ? 'sandbox' : 'production',
      storeProductId: line.productId,
      accountToken: accountTokenOf(
        body.externalAccountIdentifiers?.obfuscatedExternalAccountId,
      ),
      storeTransactionId: body.latestOrderId,
      subscriptionKey: purchaseToken,
      purchasedAt: body.startTime ? new Date(body.startTime) : new Date(),
      expiresAt,
      currency,
      priceMicros: micros,
      state,
      needsAcknowledge:
        state === 'purchased' &&
        body.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_PENDING',
    };
  }

  async consume(storeProductId: string, purchaseToken: string): Promise<void> {
    await this.call(
      'POST',
      `purchases/products/${enc(storeProductId)}/tokens/${enc(purchaseToken)}:consume`,
    );
  }

  async acknowledgeSubscription(
    storeProductId: string,
    purchaseToken: string,
  ): Promise<void> {
    await this.call(
      'POST',
      `purchases/subscriptions/${enc(storeProductId)}/tokens/${enc(purchaseToken)}:acknowledge`,
      {},
    );
  }

  async verifyPushToken(authorization: string | undefined): Promise<void> {
    const { pubsubAudience, pubsubServiceAccountEmail } = this.config;
    if (!pubsubAudience || !pubsubServiceAccountEmail)
      throw new GooglePushRefused();
    const m = /^Bearer (.+)$/.exec(authorization ?? '');
    if (!m) throw new GooglePushRefused();
    this.keys ??= jwksClient({
      jwksUri: this.config.jwksUrl,
      cache: true,
      cacheMaxAge: 3_600_000,
      rateLimit: true,
    });
    const keys = this.keys;
    try {
      const claims = await new Promise<jwt.JwtPayload>((resolve, reject) => {
        jwt.verify(
          m[1],
          (header, cb) => {
            keys
              .getSigningKey(header.kid)
              .then((k) => cb(null, k.getPublicKey()))
              .catch((e: unknown) => cb(e as Error));
          },
          {
            algorithms: ['RS256'],
            audience: pubsubAudience,
            issuer: ['https://accounts.google.com', 'accounts.google.com'],
          },
          (err, decoded) =>
            err || typeof decoded !== 'object' || decoded === null
              ? reject(err ?? new Error('no claims'))
              : resolve(decoded),
        );
      });
      if (
        claims.email !== pubsubServiceAccountEmail ||
        claims.email_verified !== true
      )
        throw new GooglePushRefused();
    } catch (e) {
      if (e instanceof GooglePushRefused) throw e;
      throw new GooglePushRefused();
    }
  }

  // -------------------------------------------------------------------------

  private async accessToken(): Promise<string> {
    const now = Date.now();
    if (this.token && this.token.until > now + 60_000) return this.token.value;
    const sa = this.config.serviceAccount;
    const iat = Math.floor(now / 1000);
    const assertion = jwt.sign(
      {
        iss: sa.client_email,
        scope: SCOPE,
        aud: sa.token_uri,
        iat,
        exp: iat + TOKEN_SECONDS,
      },
      sa.private_key,
      { algorithm: 'RS256' },
    );
    const res = await this.fetchJson(sa.token_uri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    });
    const body = res.body as { access_token?: string; expires_in?: number };
    if (res.status !== 200 || typeof body.access_token !== 'string')
      throw new StoreUnreachable(
        'Google did not give the Hub an access token.',
      );
    this.token = {
      value: body.access_token,
      until: now + (body.expires_in ?? 3000) * 1000,
    };
    return this.token.value;
  }

  /** One call to the Android Publisher API. 404 and 410 mean the purchase is not known to the store. */
  private async call<T = unknown>(
    method: 'GET' | 'POST',
    path: string,
    body?: object,
  ): Promise<T> {
    const token = await this.accessToken();
    const base = `${this.config.apiBase.replace(/\/$/, '')}/androidpublisher/v3/applications/${enc(this.config.packageName)}`;
    const res = await this.fetchJson(`${base}/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 404 || res.status === 410 || res.status === 400)
      throw new StorePurchaseNotFound();
    if (res.status === 401 || res.status === 403)
      throw new StoreUnreachable("Google refused the Hub's service account.");
    if (res.status < 200 || res.status >= 300)
      throw new StoreUnreachable(`Google answered ${res.status}.`);
    return res.body as T;
  }

  private async fetchJson(
    url: string,
    init: RequestInit,
  ): Promise<{ status: number; body: unknown }> {
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch {
      throw new StoreUnreachable();
    }
    const text = await res.text().catch(() => '');
    let body: unknown = {};
    if (text !== '') {
      try {
        body = JSON.parse(text);
      } catch {
        body = {};
      }
    }
    return { status: res.status, body };
  }
}

/** The account id a purchase was bound to, or null when it carries none. */
function accountTokenOf(v: string | undefined): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function enc(v: string): string {
  return encodeURIComponent(v);
}
