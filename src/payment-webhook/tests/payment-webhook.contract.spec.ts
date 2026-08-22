import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ConfigModule } from '@nestjs/config';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { PaymentWebhookModule } from '../payment-webhook.module';
import { CreatorSubscriptionModule } from '../../creator-subscription/creator-subscription.module';
import { FLUTTERWAVE_CLIENT as SUBSCRIPTION_FLUTTERWAVE_CLIENT } from '../../creator-subscription/flutterwave-client.interface';
import type { FlutterwaveClient as SubscriptionFlutterwaveClient } from '../../creator-subscription/flutterwave-client.interface';

/**
 * PaymentWebhook (contract).
 *
 * The defect this covers: before this module existed, every money flow was
 * confirmed only by the browser POSTing to a `/verify` endpoint. This suite
 * proves the provider can confirm instead — and that it can never confirm
 * twice, whether it races itself or races the browser.
 */

const SECRET_HASH = 'test-webhook-secret-hash';
const WEBHOOK_PATH = '/webhooks/flutterwave';

// Seeded WAWU IDs — mirror mock-wawu-id/server.js and prisma/seed.ts.
const USER_PLAIN = '00000000-0000-4000-8000-000000000001';

const MOCK_WAWU_ID_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_WAWU_ID_BASE = `http://localhost:${MOCK_WAWU_ID_PORT}`;

async function waitForHealth(url: string, timeoutMs = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function login(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_WAWU_ID_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) {
    throw new Error(`mock-wawu-id login failed for ${identifier}: ${res.status}`);
  }
  const body = (await res.json()) as { accessToken: string };
  return body.accessToken;
}

/** A realistic Flutterwave `charge.completed` body — deliberately carrying the
 *  extra fields a real delivery has, to prove nothing rejects them. */
function chargeCompleted(txRef: string, transactionId: string, amount: number) {
  return {
    event: 'charge.completed',
    'event.type': 'CARD_TRANSACTION',
    data: {
      id: transactionId,
      tx_ref: txRef,
      flw_ref: `FLW-MOCK-${transactionId}`,
      device_fingerprint: 'abcdef',
      amount,
      currency: 'NGN',
      charged_amount: amount,
      app_fee: 1,
      merchant_fee: 0,
      processor_response: 'Approved',
      auth_model: 'PIN',
      ip: '1.2.3.4',
      narration: 'WAWU',
      status: 'successful',
      payment_type: 'card',
      created_at: new Date().toISOString(),
      account_id: 1,
      customer: { id: 1, name: 'Test', email: 'user@test.wawu.dev' },
      card: { first_6digits: '553188', last_4digits: '2950', type: 'MASTERCARD' },
    },
  };
}

describe('PaymentWebhook (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mockWawuId: ChildProcess | undefined;
  let ownedMockWawuId = false;
  let subscriptionFlutterwave: SubscriptionFlutterwaveClient;
  let userToken: string;

  const originalSecretHash = process.env.FLUTTERWAVE_SECRET_HASH;

  /** tx_refs / ids created by this suite, torn down in afterAll. */
  const createdTxRefs: string[] = [];
  const throwawayUsers: string[] = [];
  const createdCreditPurchaseIds: string[] = [];

  beforeAll(async () => {
    process.env.FLUTTERWAVE_SECRET_HASH = SECRET_HASH;

    const alreadyUp = await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`, 1000);
    if (!alreadyUp) {
      mockWawuId = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '../../../mock-wawu-id'),
        env: { ...process.env, MOCK_WAWU_ID_PORT },
        stdio: 'ignore',
      });
      ownedMockWawuId = true;
      const up = await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`);
      if (!up) throw new Error('mock-wawu-id did not become healthy in time');
    }

    userToken = await login('user@test.wawu.dev');

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        PaymentWebhookModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();

    prisma = moduleRef.get(PrismaService);

    // The same MockFlutterwaveAdapter instance the CreatorSubscription flow
    // uses, so a charge opened here is one the settlement path can verify.
    subscriptionFlutterwave = moduleRef
      .select(CreatorSubscriptionModule)
      .get<SubscriptionFlutterwaveClient>(SUBSCRIPTION_FLUTTERWAVE_CLIENT);
  }, 30000);

  afterAll(async () => {
    if (prisma) {
      await prisma.paymentWebhookReceipt.deleteMany({
        where: { txRef: { in: createdTxRefs } },
      });
      await prisma.pendingCharge.deleteMany({
        where: { txRef: { in: createdTxRefs } },
      });
      if (createdCreditPurchaseIds.length) {
        await prisma.creditPurchase.deleteMany({
          where: { id: { in: createdCreditPurchaseIds } },
        });
      }
      if (throwawayUsers.length) {
        await prisma.creatorSubscription.deleteMany({
          where: { creatorWawuId: { in: throwawayUsers } },
        });
        await prisma.creatorState.deleteMany({
          where: { wawuUserId: { in: throwawayUsers } },
        });
        await prisma.userProfile.deleteMany({
          where: { wawuUserId: { in: throwawayUsers } },
        });
        await prisma.pendingCharge.deleteMany({
          where: { wawuUserId: { in: throwawayUsers } },
        });
      }
      // This suite grants real credits onto the seeded user's shared
      // CreditsState row — restore seed.ts's default (see README § Test
      // hygiene rules).
      await prisma.creditsState.updateMany({
        where: { userWawuId: USER_PLAIN },
        data: { creditBalance: 48 },
      });
    }

    if (originalSecretHash === undefined) {
      delete process.env.FLUTTERWAVE_SECRET_HASH;
    } else {
      process.env.FLUTTERWAVE_SECRET_HASH = originalSecretHash;
    }

    await app?.close();
    if (ownedMockWawuId && mockWawuId) mockWawuId.kill();
  });

  /**
   * Opens a real subscription charge for a throwaway creator, straight through
   * the same PendingCharge bridge POST /creator-subscription writes. No HTTP
   * and no seeded account touched, so the settlement assertions are exact.
   */
  async function openSubscriptionCharge(expectedAmountOverride?: number) {
    const wawuUserId = randomUUID();
    throwawayUsers.push(wawuUserId);
    const charge = subscriptionFlutterwave.initCharge({
      amount: 5999,
      purpose: 'subscribe-basic',
      wawuUserId,
      planId: 'plan-test',
    });
    createdTxRefs.push(charge.txRef);
    await prisma.pendingCharge.create({
      data: {
        txRef: charge.txRef,
        kind: 'subscribe',
        wawuUserId,
        expectedAmount: expectedAmountOverride ?? charge.amount,
        context: { tier: 'basic', planId: 'plan-test' },
      },
    });
    return { wawuUserId, txRef: charge.txRef };
  }

  /** Opens a real ₦500 / 50-credit purchase for the seeded plain user. */
  async function openCreditPurchase() {
    const res = await request(app.getHttpServer())
      .post('/credits/purchase')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ pack: 'starter' })
      .expect((r) => {
        if (r.status !== 200 && r.status !== 201) {
          throw new Error(`purchase init failed: ${r.status} ${r.text}`);
        }
      });
    const txRef = res.body.data.flutterwaveConfig.txRef as string;
    createdTxRefs.push(txRef);
    const row = await prisma.creditPurchase.findFirstOrThrow({
      where: { flutterwaveTxRef: txRef },
    });
    createdCreditPurchaseIds.push(row.id);
    return { txRef, purchaseId: row.id };
  }

  async function balance(): Promise<number> {
    const state = await prisma.creditsState.findUnique({
      where: { userWawuId: USER_PLAIN },
    });
    return state?.creditBalance ?? 0;
  }

  function deliver(body: unknown, hash: string | null = SECRET_HASH) {
    const req = request(app.getHttpServer()).post(WEBHOOK_PATH);
    if (hash !== null) req.set('verif-hash', hash);
    return req.send(body as object);
  }

  // ---------------------------------------------------------------- signature

  describe('signature verification', () => {
    it('rejects an unsigned delivery with 401 and records nothing', async () => {
      const { txRef } = await openSubscriptionCharge();

      await deliver(chargeCompleted(txRef, 'flw-tx-unsigned', 5999), null).expect(
        401,
      );

      expect(
        await prisma.paymentWebhookReceipt.count({ where: { txRef } }),
      ).toBe(0);
      // The charge is untouched: nothing was settled.
      expect(
        await prisma.pendingCharge.findUnique({ where: { txRef } }),
      ).not.toBeNull();
    });

    it('rejects a wrongly-signed delivery with 401 and records nothing', async () => {
      const { txRef } = await openSubscriptionCharge();

      await deliver(
        chargeCompleted(txRef, 'flw-tx-badhash', 5999),
        'not-the-secret-hash',
      ).expect(401);

      expect(
        await prisma.paymentWebhookReceipt.count({ where: { txRef } }),
      ).toBe(0);
      expect(
        await prisma.pendingCharge.findUnique({ where: { txRef } }),
      ).not.toBeNull();
    });

    it('rejects a hash of the right length but wrong bytes (constant-time compare still refuses)', async () => {
      const { txRef } = await openSubscriptionCharge();
      const sameLengthWrong = 'X'.repeat(SECRET_HASH.length);

      await deliver(
        chargeCompleted(txRef, 'flw-tx-samelen', 5999),
        sameLengthWrong,
      ).expect(401);

      expect(
        await prisma.paymentWebhookReceipt.count({ where: { txRef } }),
      ).toBe(0);
    });

    it('fails CLOSED when FLUTTERWAVE_SECRET_HASH is unset — an unconfigured server settles nothing', async () => {
      const { txRef } = await openSubscriptionCharge();
      delete process.env.FLUTTERWAVE_SECRET_HASH;
      try {
        // Even the "correct" hash cannot get in, because there is nothing to
        // compare against. The failure mode is closed, never open.
        await deliver(chargeCompleted(txRef, 'flw-tx-noconf', 5999)).expect(401);
        await deliver(chargeCompleted(txRef, 'flw-tx-noconf', 5999), null).expect(
          401,
        );
      } finally {
        process.env.FLUTTERWAVE_SECRET_HASH = SECRET_HASH;
      }

      expect(
        await prisma.paymentWebhookReceipt.count({ where: { txRef } }),
      ).toBe(0);
      expect(
        await prisma.creatorSubscription.findUnique({
          where: { creatorWawuId: (await prisma.pendingCharge.findUniqueOrThrow({ where: { txRef } })).wawuUserId },
        }),
      ).toBeNull();
    });
  });

  // ----------------------------------------------------------------- settling

  describe('settlement', () => {
    it('settles a pending charge with no browser involved (subscription granted end to end)', async () => {
      const { wawuUserId, txRef } = await openSubscriptionCharge();

      const res = await deliver(
        chargeCompleted(txRef, 'flw-tx-settle-1', 5999),
      ).expect(200);

      expect(res.body.data).toMatchObject({
        outcome: 'settled',
        flow: 'subscription-subscribe',
      });

      // Everything the browser's /verify would have granted, granted here.
      const subscription = await prisma.creatorSubscription.findUnique({
        where: { creatorWawuId: wawuUserId },
      });
      expect(subscription).toMatchObject({ tier: 'basic', status: 'active' });

      const creatorState = await prisma.creatorState.findUnique({
        where: { wawuUserId },
      });
      expect(creatorState?.subscriptionPaid).toBe(true);

      const profile = await prisma.userProfile.findUnique({
        where: { wawuUserId },
      });
      expect(profile?.accountType).toBe('creator');

      // The pending charge is consumed, and the delivery is on the record.
      expect(await prisma.pendingCharge.findUnique({ where: { txRef } })).toBeNull();
      const receipt = await prisma.paymentWebhookReceipt.findUniqueOrThrow({
        where: { deliveryKey: `charge.completed:${txRef}` },
      });
      expect(receipt.status).toBe('settled');
      expect(receipt.settledAt).not.toBeNull();
    });

    it('settles a credit purchase and grants the pack exactly once', async () => {
      const before = await balance();
      const { txRef, purchaseId } = await openCreditPurchase();

      const res = await deliver(
        chargeCompleted(txRef, 'flw-tx-credits-1', 500),
      ).expect(200);
      expect(res.body.data).toMatchObject({
        outcome: 'settled',
        flow: 'credit-purchase',
      });

      expect(await balance()).toBe(before + 50);
      const purchase = await prisma.creditPurchase.findUniqueOrThrow({
        where: { id: purchaseId },
      });
      expect(purchase.status).toBe('completed');
    });

    it('records an unknown tx_ref as unmatched rather than inventing a settlement', async () => {
      const txRef = `mock-${randomUUID()}`;
      createdTxRefs.push(txRef);

      const res = await deliver(
        chargeCompleted(txRef, 'flw-tx-unknown', 5999),
      ).expect(200);

      expect(res.body.data.outcome).toBe('unmatched');
      const receipt = await prisma.paymentWebhookReceipt.findUniqueOrThrow({
        where: { deliveryKey: `charge.completed:${txRef}` },
      });
      expect(receipt.status).toBe('unmatched');
      expect(receipt.settledAt).toBeNull();
    });

    it('ignores an event that is not charge.completed, leaving the charge pending', async () => {
      const { txRef } = await openSubscriptionCharge();

      const body = chargeCompleted(txRef, 'flw-tx-transfer', 5999);
      body.event = 'transfer.completed';

      const res = await deliver(body).expect(200);
      expect(res.body.data.outcome).toBe('ignored');
      expect(
        await prisma.pendingCharge.findUnique({ where: { txRef } }),
      ).not.toBeNull();
    });
  });

  // --------------------------------------------------------------- exactly-once

  describe('exactly-once', () => {
    it('settles a duplicate delivery exactly once (no second credit grant)', async () => {
      const before = await balance();
      const { txRef, purchaseId } = await openCreditPurchase();
      const body = chargeCompleted(txRef, 'flw-tx-dupe', 500);

      const first = await deliver(body).expect(200);
      expect(first.body.data.outcome).toBe('settled');

      const second = await deliver(body).expect(200);
      expect(second.body.data.outcome).toBe('duplicate');

      const third = await deliver(body).expect(200);
      expect(third.body.data.outcome).toBe('duplicate');

      // Three deliveries, one pack of credits.
      expect(await balance()).toBe(before + 50);
      expect(
        await prisma.paymentWebhookReceipt.count({ where: { txRef } }),
      ).toBe(1);
      const purchase = await prisma.creditPurchase.findUniqueOrThrow({
        where: { id: purchaseId },
      });
      expect(purchase.status).toBe('completed');
    });

    it('settles exactly once when N deliveries of the same charge arrive concurrently', async () => {
      const before = await balance();
      const { txRef } = await openCreditPurchase();
      const body = chargeCompleted(txRef, 'flw-tx-concurrent', 500);

      const responses = await Promise.all(
        Array.from({ length: 6 }, () => deliver(body)),
      );

      for (const r of responses) expect(r.status).toBe(200);
      const outcomes = responses.map(
        (r) => (r.body.data as { outcome: string }).outcome,
      );
      expect(outcomes.filter((o) => o === 'settled')).toHaveLength(1);

      expect(await balance()).toBe(before + 50);
      expect(
        await prisma.paymentWebhookReceipt.count({ where: { txRef } }),
      ).toBe(1);
    });

    it('settles exactly once when the webhook races the browser POST /verify', async () => {
      const before = await balance();
      const { txRef, purchaseId } = await openCreditPurchase();

      const [webhookRes, verifyRes] = await Promise.all([
        deliver(chargeCompleted(txRef, 'flw-tx-race', 500)),
        request(app.getHttpServer())
          .post('/credits/purchase/verify')
          .set('Authorization', `Bearer ${userToken}`)
          .send({ tx_ref: txRef, transaction_id: 'flw-tx-race' }),
      ]);

      expect(webhookRes.status).toBe(200);
      expect([200, 201]).toContain(verifyRes.status);

      // Two independent confirmation paths, one grant. The receipt table
      // cannot see the browser's call, so this is the settle path's own
      // conditional write doing the work.
      expect(await balance()).toBe(before + 50);
      const purchase = await prisma.creditPurchase.findUniqueOrThrow({
        where: { id: purchaseId },
      });
      expect(purchase.status).toBe('completed');
    });

    it('settles a subscription exactly once when the webhook races itself', async () => {
      const { wawuUserId, txRef } = await openSubscriptionCharge();
      const body = chargeCompleted(txRef, 'flw-tx-sub-race', 5999);

      const responses = await Promise.all([
        deliver(body),
        deliver(body),
        deliver(body),
      ]);
      for (const r of responses) expect(r.status).toBe(200);
      expect(
        responses
          .map((r) => (r.body.data as { outcome: string }).outcome)
          .filter((o) => o === 'settled'),
      ).toHaveLength(1);

      expect(
        await prisma.creatorSubscription.count({
          where: { creatorWawuId: wawuUserId },
        }),
      ).toBe(1);
      expect(await prisma.pendingCharge.findUnique({ where: { txRef } })).toBeNull();
    });
  });

  // ------------------------------------------------------------------- amount

  describe('amount', () => {
    it('refuses a payment below PendingCharge.expectedAmount and grants nothing', async () => {
      // The charge Flutterwave will confirm is ₦5,999; the server intended to
      // charge ₦18,999. This is the ₦1-buys-Pro attack, arriving by webhook.
      const { wawuUserId, txRef } = await openSubscriptionCharge(18999);

      const res = await deliver(
        chargeCompleted(txRef, 'flw-tx-underpaid', 18999),
      ).expect(200);

      expect(res.body.data.outcome).toBe('rejected');

      expect(
        await prisma.creatorSubscription.findUnique({
          where: { creatorWawuId: wawuUserId },
        }),
      ).toBeNull();
      expect(
        await prisma.creatorState.findUnique({ where: { wawuUserId } }),
      ).toBeNull();

      const receipt = await prisma.paymentWebhookReceipt.findUniqueOrThrow({
        where: { deliveryKey: `charge.completed:${txRef}` },
      });
      expect(receipt.status).toBe('rejected');
      expect(receipt.settledAt).toBeNull();
    });

    it('ignores the amount in the webhook body entirely — an inflated payload buys nothing', async () => {
      const { wawuUserId, txRef } = await openSubscriptionCharge(18999);

      // The body claims ₦18,999 was paid. Flutterwave says ₦5,999. The body
      // loses, because the body is never evidence.
      const res = await deliver(
        chargeCompleted(txRef, 'flw-tx-liar', 999999),
      ).expect(200);

      expect(res.body.data.outcome).toBe('rejected');
      expect(
        await prisma.creatorSubscription.findUnique({
          where: { creatorWawuId: wawuUserId },
        }),
      ).toBeNull();
    });
  });
});
