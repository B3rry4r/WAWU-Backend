// The real Google Play adapter (task IAP-01), against a local HTTP stand-in for
// Google (token endpoint, Android Publisher API, token signing keys). Nothing
// leaves the machine. Ports 8530-8531.

import { createServer, type IncomingMessage, type Server } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import * as jwt from 'jsonwebtoken';
import { RealGooglePlayClient } from '../clients/google-play.client';
import {
  GooglePushRefused,
  StorePurchaseNotFound,
  StoreUnreachable,
} from '../clients/store-clients';
import type { GooglePlayConfig } from '../store-config';

const PORT = 8530;
const BASE = `http://127.0.0.1:${PORT}`;
const PACKAGE = 'africa.wawu.test';
const AUDIENCE = 'https://hub.example.test/api/hub/webhooks/google-play';
const PUSH_EMAIL = 'pubsub-push@wawu-test.iam.gserviceaccount.com';

describe('IAP-01: the real Google Play adapter (stand-in server)', () => {
  const sa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const google = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const serviceKeyPem = sa.privateKey.export({
    type: 'pkcs8',
    format: 'pem',
  }) as string;
  const googleKeyPem = google.privateKey.export({
    type: 'pkcs8',
    format: 'pem',
  }) as string;
  const jwk = {
    ...google.publicKey.export({ format: 'jwk' }),
    kid: 'k1',
    alg: 'RS256',
    use: 'sig',
  };

  let server: Server;
  const seen: Array<{
    method: string;
    url: string;
    auth?: string;
    body: string;
  }> = [];
  let answers: Record<string, { status: number; body: unknown }> = {};
  let tokenCalls = 0;

  const config: GooglePlayConfig = {
    packageName: PACKAGE,
    serviceAccount: {
      client_email: 'hub@wawu-test.iam.gserviceaccount.com',
      private_key: serviceKeyPem,
      token_uri: `${BASE}/token`,
    },
    apiBase: BASE,
    pubsubAudience: AUDIENCE,
    pubsubServiceAccountEmail: PUSH_EMAIL,
    jwksUrl: `${BASE}/certs`,
  };

  const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let b = '';
      req.on('data', (c: Buffer) => (b += c.toString()));
      req.on('end', () => resolve(b));
    });

  beforeAll(async () => {
    server = createServer((req, res) => {
      void readBody(req).then((body) => {
        const url = req.url ?? '';
        seen.push({
          method: req.method ?? '',
          url,
          auth: req.headers.authorization,
          body,
        });
        const send = (status: number, json: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(json));
        };
        if (url === '/token') {
          tokenCalls += 1;
          // The Hub's assertion must be a JWT signed by the service account's key.
          const assertion = new URLSearchParams(body).get('assertion') ?? '';
          try {
            const claims = jwt.verify(assertion, sa.publicKey, {
              algorithms: ['RS256'],
            }) as jwt.JwtPayload;
            if (claims.iss !== config.serviceAccount.client_email)
              throw new Error('iss');
            if (
              claims.scope !==
              'https://www.googleapis.com/auth/androidpublisher'
            )
              throw new Error('scope');
          } catch {
            return send(400, { error: 'invalid_grant' });
          }
          return send(200, { access_token: 'access-1', expires_in: 3600 });
        }
        if (url === '/certs') return send(200, { keys: [jwk] });
        if (req.headers.authorization !== 'Bearer access-1')
          return send(401, {});
        const a = answers[`${req.method} ${url}`];
        return a ? send(a.status, a.body) : send(404, {});
      });
    });
    await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', r));
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });
  beforeEach(() => {
    seen.length = 0;
    answers = {};
  });

  const base = `/androidpublisher/v3/applications/${PACKAGE}`;

  it('reads a one-time product as the service account, from Google, and maps it', async () => {
    answers[
      `GET ${base}/purchases/products/wawu_credits_popular/tokens/tok-1`
    ] = {
      status: 200,
      body: {
        purchaseTimeMillis: '1767225600000',
        purchaseState: 0,
        consumptionState: 0,
        acknowledgementState: 0,
        orderId: 'GPA.1111-2222-3333-44444',
      },
    };
    const client = new RealGooglePlayClient(config);
    const p = await client.verifyOneTime('wawu_credits_popular', 'tok-1');
    expect(p).toMatchObject({
      platform: 'android',
      environment: 'production',
      storeProductId: 'wawu_credits_popular',
      storeTransactionId: 'GPA.1111-2222-3333-44444',
      subscriptionKey: null,
      state: 'purchased',
      needsAcknowledge: true,
    });
    expect(p.purchasedAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    // The call carried the token Google's token endpoint gave for the signed assertion.
    expect(
      seen.some(
        (s) =>
          s.url.includes('/purchases/products/') &&
          s.auth === 'Bearer access-1',
      ),
    ).toBe(true);
  });

  it('carries the account token the app bound the purchase to, and refuses a token bought for another product', async () => {
    answers[`GET ${base}/purchases/products/wawu_points_s/tokens/tok-b`] = {
      status: 200,
      body: {
        purchaseTimeMillis: '1',
        purchaseState: 0,
        orderId: 'O-b',
        productId: 'wawu_points_s',
        obfuscatedExternalAccountId: 'acct-token-1',
      },
    };
    const client = new RealGooglePlayClient(config);
    expect(
      (await client.verifyOneTime('wawu_points_s', 'tok-b')).accountToken,
    ).toBe('acct-token-1');
    // Google's answer names another product than the one the Hub asked about: not this purchase.
    answers[`GET ${base}/purchases/products/wawu_points_l/tokens/tok-b`] = {
      status: 200,
      body: {
        purchaseTimeMillis: '1',
        purchaseState: 0,
        orderId: 'O-b',
        productId: 'wawu_points_s',
      },
    };
    await expect(
      client.verifyOneTime('wawu_points_l', 'tok-b'),
    ).rejects.toBeInstanceOf(StorePurchaseNotFound);
    // No token on the purchase: null.
    answers[`GET ${base}/purchases/products/p/tokens/tok-n`] = {
      status: 200,
      body: { purchaseTimeMillis: '1', purchaseState: 0, orderId: 'O-n' },
    };
    expect((await client.verifyOneTime('p', 'tok-n')).accountToken).toBeNull();
  });

  it('reads the room a pass was bought for from the purchase profile id, or null (IAP-03 round 2)', async () => {
    answers[`GET ${base}/purchases/products/wawu_pass_30_a/tokens/tok-room`] = {
      status: 200,
      body: {
        purchaseTimeMillis: '1',
        purchaseState: 0,
        orderId: 'O-room',
        productId: 'wawu_pass_30_a',
        obfuscatedExternalAccountId: 'acct-token-1',
        obfuscatedExternalProfileId: '3f2b1c9e-7a44-4d0e-9a55-0c6d9f1b2a77',
      },
    };
    const client = new RealGooglePlayClient(config);
    expect(
      (await client.verifyOneTime('wawu_pass_30_a', 'tok-room')).roomToken,
    ).toBe('3f2b1c9e-7a44-4d0e-9a55-0c6d9f1b2a77');
    answers[`GET ${base}/purchases/products/wawu_pass_30_a/tokens/tok-noroom`] =
      {
        status: 200,
        body: {
          purchaseTimeMillis: '1',
          purchaseState: 0,
          orderId: 'O-noroom',
          productId: 'wawu_pass_30_a',
        },
      };
    expect(
      (await client.verifyOneTime('wawu_pass_30_a', 'tok-noroom')).roomToken,
    ).toBeNull();
  });

  it('reads the account token of a subscription from its external account identifiers', async () => {
    answers[`GET ${base}/purchases/subscriptionsv2/tokens/sub-tok`] = {
      status: 200,
      body: {
        latestOrderId: 'GPA.s..0',
        subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
        externalAccountIdentifiers: {
          obfuscatedExternalAccountId: 'acct-token-2',
        },
        lineItems: [
          {
            productId: 'wawu_tier_x',
            expiryTime: new Date(Date.now() + 86_400_000).toISOString(),
          },
        ],
      },
    };
    expect(
      (await new RealGooglePlayClient(config).verifySubscription('sub-tok'))
        .accountToken,
    ).toBe('acct-token-2');
  });

  it('maps a pending one-time purchase and a test purchase', async () => {
    answers[`GET ${base}/purchases/products/p/tokens/t2`] = {
      status: 200,
      body: {
        purchaseTimeMillis: '1',
        purchaseState: 2,
        purchaseType: 0,
        orderId: 'O2',
      },
    };
    const p = await new RealGooglePlayClient(config).verifyOneTime('p', 't2');
    expect(p.state).toBe('pending');
    expect(p.environment).toBe('sandbox');
    expect(p.needsAcknowledge).toBe(false);
  });

  it('reads a subscription (v2): the latest order, the expiry, the price', async () => {
    const expiry = new Date(Date.now() + 20 * 86_400_000).toISOString();
    answers[`GET ${base}/purchases/subscriptionsv2/tokens/sub-1`] = {
      status: 200,
      body: {
        latestOrderId: 'GPA.9999..1',
        startTime: '2026-01-01T00:00:00Z',
        subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
        acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
        lineItems: [
          {
            productId: 'wawu_tier_founding',
            expiryTime: expiry,
            autoRenewingPlan: {
              recurringPrice: {
                currencyCode: 'NGN',
                units: '4500',
                nanos: 500_000_000,
              },
            },
          },
        ],
      },
    };
    const p = await new RealGooglePlayClient(config).verifySubscription(
      'sub-1',
    );
    expect(p).toMatchObject({
      storeProductId: 'wawu_tier_founding',
      storeTransactionId: 'GPA.9999..1',
      subscriptionKey: 'sub-1',
      state: 'purchased',
      currency: 'NGN',
      priceMicros: 4_500_500_000n,
      needsAcknowledge: true,
    });
    expect(p.expiresAt?.toISOString()).toBe(expiry);
  });

  it('a lapsed or on-hold subscription is not in force', async () => {
    for (const [i, state] of [
      'SUBSCRIPTION_STATE_EXPIRED',
      'SUBSCRIPTION_STATE_ON_HOLD',
    ].entries()) {
      answers[`GET ${base}/purchases/subscriptionsv2/tokens/s${i}`] = {
        status: 200,
        body: {
          latestOrderId: 'O',
          subscriptionState: state,
          lineItems: [
            {
              productId: 'x',
              expiryTime: new Date(Date.now() - 1000).toISOString(),
            },
          ],
        },
      };
      const p = await new RealGooglePlayClient(config).verifySubscription(
        `s${i}`,
      );
      expect(p.state).toBe('cancelled');
    }
  });

  it('a purchase Google does not know is StorePurchaseNotFound; a refused service account or a server error is StoreUnreachable', async () => {
    const client = new RealGooglePlayClient(config);
    await expect(client.verifyOneTime('p', 'nope')).rejects.toBeInstanceOf(
      StorePurchaseNotFound,
    );
    answers[`GET ${base}/purchases/products/p/tokens/boom`] = {
      status: 500,
      body: {},
    };
    await expect(client.verifyOneTime('p', 'boom')).rejects.toBeInstanceOf(
      StoreUnreachable,
    );
  });

  it('a transport failure is StoreUnreachable, never a verdict on the purchase', async () => {
    const dead = new RealGooglePlayClient({
      ...config,
      serviceAccount: {
        ...config.serviceAccount,
        token_uri: 'http://127.0.0.1:8531/token',
      },
    });
    await expect(dead.verifyOneTime('p', 't')).rejects.toBeInstanceOf(
      StoreUnreachable,
    );
  });

  it('consumes a pack and acknowledges a subscription on the right paths, and reuses the access token', async () => {
    answers[
      `POST ${base}/purchases/products/wawu_points_s/tokens/tok:consume`
    ] = { status: 204, body: {} };
    answers[
      `POST ${base}/purchases/subscriptions/wawu_pass_30/tokens/tok2:acknowledge`
    ] = { status: 204, body: {} };
    const client = new RealGooglePlayClient(config);
    const before = tokenCalls;
    await client.consume('wawu_points_s', 'tok');
    await client.acknowledgeSubscription('wawu_pass_30', 'tok2');
    expect(tokenCalls - before).toBe(1);
  });

  describe('the Pub/Sub push token', () => {
    const sign = (over: object = {}, key = googleKeyPem) =>
      jwt.sign({ email: PUSH_EMAIL, email_verified: true, ...over }, key, {
        algorithm: 'RS256',
        keyid: 'k1',
        issuer: 'https://accounts.google.com',
        audience: AUDIENCE,
        expiresIn: 300,
        ...(over as { _opts?: object })._opts,
      });

    it('accepts a token Google signed for this endpoint as the subscription account', async () => {
      const client = new RealGooglePlayClient(config);
      await expect(
        client.verifyPushToken(`Bearer ${sign()}`),
      ).resolves.toBeUndefined();
    });

    it.each([
      ['no header', undefined],
      ['not a bearer token', 'Basic abc'],
      ['garbage', 'Bearer not-a-jwt'],
    ])('refuses %s', async (_name, header) => {
      await expect(
        new RealGooglePlayClient(config).verifyPushToken(header),
      ).rejects.toBeInstanceOf(GooglePushRefused);
    });

    it('refuses a token for another audience, another account, an unverified email, or another key', async () => {
      const client = new RealGooglePlayClient(config);
      const other = generateKeyPairSync('rsa', {
        modulusLength: 2048,
      }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
      const wrongAudience = jwt.sign(
        { email: PUSH_EMAIL, email_verified: true },
        googleKeyPem,
        {
          algorithm: 'RS256',
          keyid: 'k1',
          issuer: 'https://accounts.google.com',
          audience: 'https://elsewhere.example',
          expiresIn: 300,
        },
      );
      for (const t of [
        wrongAudience,
        sign({ email: 'someone@else.example' }),
        sign({ email_verified: false }),
        sign({}, other),
      ])
        await expect(
          client.verifyPushToken(`Bearer ${t}`),
        ).rejects.toBeInstanceOf(GooglePushRefused);
    });

    it('refuses everything until the audience and the account are both set', async () => {
      const unset = new RealGooglePlayClient({
        ...config,
        pubsubAudience: null,
      });
      await expect(
        unset.verifyPushToken(`Bearer ${sign()}`),
      ).rejects.toBeInstanceOf(GooglePushRefused);
    });
  });
});
