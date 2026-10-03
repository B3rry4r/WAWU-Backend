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
    // One server for the whole file (FIX-02). Unlistened, supertest opens a
    // server per request and the first concurrent request to finish closes
    // it under the others, resetting any still queued (read ECONNRESET).
    await app.listen(0, '127.0.0.1');

    prisma = moduleRef.get(PrismaService);
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
   * A PendingCharge no flow owns, for the signature tests.
   *
   * Those tests assert that a REFUSED delivery settles nothing, so the charge
   * only has to exist and still be there afterwards. This used to be a real
   * subscription charge; there is no subscription flow any more, and a charge
   * nobody can settle is the stricter fixture for "settled nothing" anyway.
   */
  async function openUnroutedCharge() {
    const wawuUserId = randomUUID();
    throwawayUsers.push(wawuUserId);
    const txRef = `mock-unrouted-${randomUUID()}`;
    createdTxRefs.push(txRef);
    await prisma.pendingCharge.create({
      data: {
        txRef,
        kind: 'dm',
        wawuUserId,
        expectedAmount: 5999,
        context: {},
      },
    });
    return { wawuUserId, txRef };
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
      const { txRef } = await openUnroutedCharge();

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
      const { txRef } = await openUnroutedCharge();

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
      const { txRef } = await openUnroutedCharge();
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
      const { txRef } = await openUnroutedCharge();
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
      // The charge is still sitting there unsettled, which is the whole point.
      expect(
        await prisma.pendingCharge.findUnique({ where: { txRef } }),
      ).not.toBeNull();
    });
  });

  // ----------------------------------------------------------------- settling

  describe('settlement', () => {
    it('settles a credit purchase with no browser involved, and records the delivery', async () => {
      const before = await balance();
      const { txRef, purchaseId } = await openCreditPurchase();

      const res = await deliver(
        chargeCompleted(txRef, 'flw-tx-credits-1', 500),
      ).expect(200);
      expect(res.body.data).toMatchObject({
        outcome: 'settled',
        flow: 'credit-purchase',
      });

      // Everything the browser's /verify would have granted, granted here.
      expect(await balance()).toBe(before + 50);
      const purchase = await prisma.creditPurchase.findUniqueOrThrow({
        where: { id: purchaseId },
      });
      expect(purchase.status).toBe('completed');

      // And the delivery is on the record.
      const receipt = await prisma.paymentWebhookReceipt.findUniqueOrThrow({
        where: { deliveryKey: `charge.completed:${txRef}` },
      });
      expect(receipt.status).toBe('settled');
      expect(receipt.settledAt).not.toBeNull();
    });

    it('routes a SHOP order to its own flow instead of leaving a paid buyer unmatched', async () => {
      // Shop and event tickets were both built after this router and neither
      // was added to it. Until that was fixed, a shopper whose browser never
      // came back had paid and received nothing: the delivery was recorded
      // `unmatched` and no second path existed to settle it.
      //
      // This asserts the ROUTING, which is what was missing. Whether the
      // charge then verifies with Flutterwave is the settle step's own
      // business and is covered by the shop's contract tests.
      const product = await prisma.product.create({
        data: {
          name: 'Webhook test mic',
          slug: `webhook-test-mic-${randomUUID().slice(0, 8)}`,
          description: 'Seeded for the webhook routing test.',
          category: 'audio_music',
          subcategory: 'microphones',
          priceNaira: 1000,
          stock: 5,
          status: 'live',
        },
      });
      const txRef = `wawu-shop-${randomUUID()}`;
      createdTxRefs.push(txRef);
      const order = await prisma.shopOrder.create({
        data: {
          buyerWawuId: USER_PLAIN,
          subtotalNaira: 1000,
          totalNaira: 1000,
          status: 'pending',
          flutterwaveTxRef: txRef,
          deliveryName: 'Test Buyer',
          deliveryPhone: '08030000000',
          deliveryAddress: '1 Test Street',
          deliveryCity: 'Lagos',
          deliveryState: 'Lagos',
        },
      });

      const res = await deliver(chargeCompleted(txRef, 'flw-tx-shop-1', 1000)).expect(200);
      expect(res.body.data.flow).toBe('shop-order');
      expect(res.body.data.outcome).not.toBe('unmatched');

      await prisma.shopOrder.delete({ where: { id: order.id } });
      await prisma.product.delete({ where: { id: product.id } });
    });

    it('routes an EVENT TICKET order to its own flow', async () => {
      // Seeded here rather than relying on one existing: this suite must not
      // pass or fail on what happens to be in the database.
      const event = await prisma.event.create({
        data: {
          hostWawuId: USER_PLAIN,
          name: 'Webhook test event',
          description: 'Seeded for the webhook routing test.',
          hostOrg: 'WAWU QA',
          format: 'online',
          type: 'workshop',
          startsAt: new Date(Date.now() + 86400000),
          location: 'Online',
          status: 'published',
        },
      });
      const ticketType = await prisma.eventTicketType.create({
        data: { eventId: event.id, name: 'Webhook test tier', priceNaira: 1000, quantity: 10, tier: 'regular' },
      });
      const txRef = `wawu-ticket-${randomUUID()}`;
      createdTxRefs.push(txRef);
      const order = await prisma.eventOrder.create({
        data: {
          eventId: event.id,
          ticketTypeId: ticketType.id,
          buyerWawuId: USER_PLAIN,
          quantity: 1,
          amountNaira: 1000,
          commissionRate: 0.15,
          status: 'pending',
          flutterwaveTxRef: txRef,
        },
      });

      const res = await deliver(chargeCompleted(txRef, 'flw-tx-ticket-1', 1000)).expect(200);
      expect(res.body.data.flow).toBe('event-ticket-order');
      expect(res.body.data.outcome).not.toBe('unmatched');

      await prisma.eventOrder.delete({ where: { id: order.id } });
      await prisma.eventTicketType.delete({ where: { id: ticketType.id } });
      await prisma.event.delete({ where: { id: event.id } });
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
      const { txRef } = await openUnroutedCharge();

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

  });

  // ------------------------------------------------------------------- amount

  describe('amount', () => {
    /**
     * Raises what the server expects to be paid ABOVE what Flutterwave will
     * confirm, so the verify comparison has to refuse. `CreditPurchase.amount`
     * is the stored expectation the settle path checks (`result.amount >=
     * purchase.amount` in CreditPurchaseService.verifyPurchase).
     */
    async function openUnderpaidCreditPurchase() {
      const { txRef, purchaseId } = await openCreditPurchase();
      await prisma.creditPurchase.update({
        where: { id: purchaseId },
        data: { amount: 18999 },
      });
      return { txRef, purchaseId };
    }

    it('refuses a payment below the amount the server stored, and grants nothing', async () => {
      // The charge Flutterwave will confirm is ₦500; the server intended to
      // charge ₦18,999. This is the ₦1-buys-everything attack, by webhook.
      const before = await balance();
      const { txRef, purchaseId } = await openUnderpaidCreditPurchase();

      const res = await deliver(
        chargeCompleted(txRef, 'flw-tx-underpaid', 18999),
      ).expect(200);

      expect(res.body.data.outcome).toBe('rejected');
      expect(await balance()).toBe(before);
      expect(
        (await prisma.creditPurchase.findUniqueOrThrow({ where: { id: purchaseId } }))
          .status,
      ).not.toBe('completed');

      const receipt = await prisma.paymentWebhookReceipt.findUniqueOrThrow({
        where: { deliveryKey: `charge.completed:${txRef}` },
      });
      expect(receipt.status).toBe('rejected');
      expect(receipt.settledAt).toBeNull();
    });

    it('ignores the amount in the webhook body entirely — an inflated payload buys nothing', async () => {
      const before = await balance();
      const { txRef } = await openUnderpaidCreditPurchase();

      // The body claims ₦999,999 was paid. Flutterwave says ₦500. The body
      // loses, because the body is never evidence.
      const res = await deliver(
        chargeCompleted(txRef, 'flw-tx-liar', 999999),
      ).expect(200);

      expect(res.body.data.outcome).toBe('rejected');
      expect(await balance()).toBe(before);
    });
  });
});
