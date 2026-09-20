import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { AdminAuthModule } from '../../auth/admin-auth.module';
import { AdminPaymentsModule } from '../admin-payments.module';
import { CreditPurchaseModule } from '../../../credit-purchase/credit-purchase.module';
import { FLUTTERWAVE_CLIENT } from '../../../credit-purchase/flutterwave-client.interface';
import type { FlutterwaveClient } from '../../../credit-purchase/flutterwave-client.interface';

/**
 * Contract tests for the admin payment-reconciliation surface
 * (admin-surface-extension Phase 6).
 *
 * The load-bearing assertion in this file is the re-verify one. Everything
 * else here is a read, and a read that is wrong shows a wrong number on a
 * screen. Re-verify moves money: it re-runs the REAL settlement path for a
 * charge that got stuck, and the thing that must be proved is that it settles
 * a genuinely stuck receipt EXACTLY once — that the grant happened, and that
 * doing it again does not grant a second time.
 *
 * That is proved twice over, at two different layers:
 *
 *  1. Through the endpoint: the second call is refused (409) and the grant is
 *     asserted unchanged.
 *  2. THROUGH the endpoint's own guard: the receipt is forced back to a
 *     reverifiable status directly in the database, so the second re-verify
 *     actually reaches the settlement path — and still grants nothing, because
 *     the exactly-once guarantee lives in the settle paths' conditional writes
 *     (the claiming `pendingCharge.deleteMany`), not in this endpoint's status
 *     check. Layer 2 is the one that would catch a re-verify that had quietly
 *     reimplemented settlement.
 *
 * Also proved: the queue filters and paginates, `unresolved` is the README's
 * three-status reconciliation queue, the detail carries a freshly-computed
 * reason it did not match, every non-finance admin role is refused, and a WAWU
 * ID user token cannot reach any of it.
 *
 * Fixtures live under this suite's own `af……` id prefix and `apx-` tx_ref
 * prefix, and are swept in afterAll (README § Test hygiene). No seeded row is
 * mutated.
 */

const MOCK_WAWU_ID_URL = process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';

/** Seeded plain (non-creator) WAWU ID user. mock-wawu-id keys its login on the email, not the sub. */
const USER_PLAIN_EMAIL = 'user@test.wawu.dev';

// ── suite-owned admin fixtures ──────────────────────────────────────────────
const ADMIN_SUPER_ID = 'af000000-0000-4000-8000-000000000001';
const ADMIN_FINANCE_ID = 'af000000-0000-4000-8000-000000000002';
const ADMIN_SUPPORT_ID = 'af000000-0000-4000-8000-000000000003';
const ADMIN_REVIEWER_ID = 'af000000-0000-4000-8000-000000000004';
const ADMIN_IDS = [ADMIN_SUPER_ID, ADMIN_FINANCE_ID, ADMIN_SUPPORT_ID, ADMIN_REVIEWER_ID];

const SUPER_EMAIL = 'payments-super@admin.test.wawu.dev';
const FINANCE_EMAIL = 'payments-finance@admin.test.wawu.dev';
const SUPPORT_EMAIL = 'payments-support@admin.test.wawu.dev';
const REVIEWER_EMAIL = 'payments-reviewer@admin.test.wawu.dev';
const PASSWORD = 'admin-payments-contract-password';

const TEST_ACCESS_SECRET = 'admin-payments-access-secret-0123456789abc';
const TEST_REFRESH_SECRET = 'admin-payments-refresh-secret-0123456789abc';

// ── suite-owned receipt fixtures ────────────────────────────────────────────
/** Every static receipt this suite owns; the tx_ref prefix scopes list assertions off a shared database. */
const TX_PREFIX = 'apx-';

const RECEIPT_UNMATCHED = 'af000000-0000-4000-8000-0000000000a1';
const RECEIPT_REJECTED = 'af000000-0000-4000-8000-0000000000a2';
const RECEIPT_FAILED = 'af000000-0000-4000-8000-0000000000a3';
const RECEIPT_SETTLED = 'af000000-0000-4000-8000-0000000000a4';
const RECEIPT_RECEIVED = 'af000000-0000-4000-8000-0000000000a5';
const RECEIPT_IGNORED = 'af000000-0000-4000-8000-0000000000a6';
const STATIC_RECEIPT_IDS = [
  RECEIPT_UNMATCHED,
  RECEIPT_REJECTED,
  RECEIPT_FAILED,
  RECEIPT_SETTLED,
  RECEIPT_RECEIVED,
  RECEIPT_IGNORED,
];
const UNKNOWN_RECEIPT = 'af000000-0000-4000-8000-0000000000ff';

/** A realistic Flutterwave `charge.completed` body — the shape actually stored in `payload`. */
function chargeCompletedPayload(txRef: string, transactionId: string, amount: number) {
  return {
    event: 'charge.completed',
    'event.type': 'CARD_TRANSACTION',
    data: {
      id: transactionId,
      tx_ref: txRef,
      flw_ref: `FLW-MOCK-${transactionId}`,
      amount,
      currency: 'NGN',
      charged_amount: amount,
      status: 'successful',
      payment_type: 'card',
      created_at: '2026-08-01T10:00:00.000Z',
      customer: { id: 1, name: 'Test Buyer', email: 'buyer@test.wawu.dev' },
      card: { first_6digits: '553188', last_4digits: '2950', type: 'MASTERCARD' },
    },
  };
}

async function loginToWawuId(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_WAWU_ID_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) {
    throw new Error(`mock-wawu-id login failed for ${identifier}: ${res.status}`);
  }
  return ((await res.json()) as { accessToken: string }).accessToken;
}

describe('Admin payments reconciliation contract', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let creditsFlutterwave: FlutterwaveClient;

  let superToken: string;
  let financeToken: string;
  let supportToken: string;
  let reviewerToken: string;
  let userToken: string;

  const envSnapshot: Record<string, string | undefined> = {};

  /** Throwaway ids created by the settlement tests, torn down in afterAll. */
  const createdTxRefs: string[] = [];
  const createdReceiptIds: string[] = [];
  const createdCreditPurchaseIds: string[] = [];
  const throwawayUsers: string[] = [];

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function adminLogin(email: string): Promise<string> {
    const res = await http()
      .post('/api/hub/admin/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return res.body.data.accessToken as string;
  }

  /** Puts the static receipt fixtures back at their starting state. */
  async function resetReceiptFixtures(): Promise<void> {
    await prisma.paymentWebhookReceipt.deleteMany({ where: { id: { in: STATIC_RECEIPT_IDS } } });
    await prisma.paymentWebhookReceipt.createMany({
      data: [
        {
          id: RECEIPT_UNMATCHED,
          deliveryKey: `charge.completed:${TX_PREFIX}unmatched`,
          event: 'charge.completed',
          txRef: `${TX_PREFIX}unmatched`,
          transactionId: 'flw-tx-apx-unmatched',
          status: 'unmatched',
          flow: null,
          detail: 'No money flow owns this tx_ref',
          payload: chargeCompletedPayload(`${TX_PREFIX}unmatched`, 'flw-tx-apx-unmatched', 5999),
          receivedAt: new Date('2026-08-01T00:00:00.000Z'),
        },
        {
          id: RECEIPT_REJECTED,
          deliveryKey: `charge.completed:${TX_PREFIX}rejected`,
          event: 'charge.completed',
          txRef: `${TX_PREFIX}rejected`,
          transactionId: 'flw-tx-apx-rejected',
          status: 'rejected',
          flow: 'subscription-subscribe',
          detail: 'Payment verification failed',
          payload: chargeCompletedPayload(`${TX_PREFIX}rejected`, 'flw-tx-apx-rejected', 1),
          receivedAt: new Date('2026-08-02T00:00:00.000Z'),
        },
        {
          id: RECEIPT_FAILED,
          deliveryKey: `charge.completed:${TX_PREFIX}failed`,
          event: 'charge.completed',
          txRef: `${TX_PREFIX}failed`,
          transactionId: 'flw-tx-apx-failed',
          status: 'failed',
          flow: null,
          detail: 'Could not reach Flutterwave',
          payload: chargeCompletedPayload(`${TX_PREFIX}failed`, 'flw-tx-apx-failed', 500),
          receivedAt: new Date('2026-08-03T00:00:00.000Z'),
        },
        {
          id: RECEIPT_SETTLED,
          deliveryKey: `charge.completed:${TX_PREFIX}settled`,
          event: 'charge.completed',
          txRef: `${TX_PREFIX}settled`,
          transactionId: 'flw-tx-apx-settled',
          status: 'settled',
          flow: 'credit-purchase',
          detail: null,
          payload: chargeCompletedPayload(`${TX_PREFIX}settled`, 'flw-tx-apx-settled', 500),
          receivedAt: new Date('2026-08-04T00:00:00.000Z'),
          settledAt: new Date('2026-08-04T00:00:05.000Z'),
        },
        {
          id: RECEIPT_RECEIVED,
          deliveryKey: `charge.completed:${TX_PREFIX}received`,
          event: 'charge.completed',
          txRef: `${TX_PREFIX}received`,
          transactionId: 'flw-tx-apx-received',
          status: 'received',
          flow: null,
          detail: null,
          payload: chargeCompletedPayload(`${TX_PREFIX}received`, 'flw-tx-apx-received', 500),
          receivedAt: new Date('2026-08-05T00:00:00.000Z'),
        },
        {
          id: RECEIPT_IGNORED,
          // WAS transfer.completed, chosen as an example of an event we do
          // not settle. It IS one now: transfers settle creator wallet
          // movements. This fixture needs an event that is still genuinely
          // unhandled, or it stops testing what it is named after.
          deliveryKey: `charge.pending:${TX_PREFIX}ignored`,
          event: 'charge.pending',
          txRef: `${TX_PREFIX}ignored`,
          transactionId: 'flw-tx-apx-ignored',
          status: 'ignored',
          flow: null,
          detail: 'Event charge.pending is not a settlement event',
          payload: chargeCompletedPayload(`${TX_PREFIX}ignored`, 'flw-tx-apx-ignored', 500),
          receivedAt: new Date('2026-08-06T00:00:00.000Z'),
        },
      ],
    });
  }

  /**
   * A GENUINELY stuck receipt: a real subscription charge opened through the
   * same PendingCharge bridge `POST /creator-subscription` writes, plus a
   * receipt recorded `unmatched` — the exact shape a webhook takes when it
   * beats its own PendingCharge insert into the database.
   *
   * Nothing about it is faked. The tx_ref is a real one the Flutterwave client
   * has seen `initCharge` for, so the settle path's re-verification against
   * Flutterwave genuinely succeeds rather than being stubbed past.
   */
  /** The `starter` pack, from CreditPurchaseService's own PACK_TABLE. */
  const CREDIT_PACK_AMOUNT = 500;
  const CREDIT_PACK_CREDITS = 50;

  const creditBalanceOf = async (userWawuId: string): Promise<number> =>
    (await prisma.creditsState.findUnique({ where: { userWawuId } }))
      ?.creditBalance ?? 0;

  async function openStuckCreditPurchaseReceipt(storedAmountOverride?: number) {
    const wawuUserId = randomUUID();
    throwawayUsers.push(wawuUserId);

    const charge = creditsFlutterwave.initCharge({
      amount: CREDIT_PACK_AMOUNT,
      purpose: 'credit-purchase',
      wawuUserId,
    });
    createdTxRefs.push(charge.txRef);

    // What CreditPurchaseService.create writes, written directly: no HTTP and
    // no seeded account touched, so the settlement assertions are exact.
    // `storedAmountOverride` raises the amount the server expects ABOVE what
    // Flutterwave will confirm, which is what the underpayment test needs.
    const purchase = await prisma.creditPurchase.create({
      data: {
        userWawuId: wawuUserId,
        pack: 'starter',
        creditsGranted: CREDIT_PACK_CREDITS,
        flutterwaveTxRef: charge.txRef,
        amount: storedAmountOverride ?? CREDIT_PACK_AMOUNT,
        status: 'pending',
      },
    });
    createdCreditPurchaseIds.push(purchase.id);

    const transactionId = `flw-tx-${charge.txRef}`;
    const receipt = await prisma.paymentWebhookReceipt.create({
      data: {
        deliveryKey: `charge.completed:${charge.txRef}`,
        event: 'charge.completed',
        txRef: charge.txRef,
        transactionId,
        status: 'unmatched',
        detail: 'No money flow owns this tx_ref',
        payload: chargeCompletedPayload(charge.txRef, transactionId, CREDIT_PACK_AMOUNT),
      },
    });
    createdReceiptIds.push(receipt.id);

    return {
      wawuUserId,
      txRef: charge.txRef,
      receiptId: receipt.id,
      purchaseId: purchase.id,
    };
  }

  beforeAll(async () => {
    for (const key of ['ADMIN_JWT_SECRET', 'ADMIN_JWT_REFRESH_SECRET']) {
      envSnapshot[key] = process.env[key];
    }
    process.env.ADMIN_JWT_SECRET = TEST_ACCESS_SECRET;
    process.env.ADMIN_JWT_REFRESH_SECRET = TEST_REFRESH_SECRET;

    userToken = await loginToWawuId(USER_PLAIN_EMAIL);

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        AdminAuthModule,
        // Pulls PaymentWebhookModule, and with it every real money module, so
        // re-verify runs the REAL settlement path rather than a stub.
        AdminPaymentsModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/hub');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();

    prisma = moduleRef.get(PrismaService);

    // The same MockFlutterwaveAdapter instance the CreditPurchase flow uses,
    // so a charge opened here is one the settlement path can verify.
    creditsFlutterwave = moduleRef
      .select(CreditPurchaseModule)
      .get<FlutterwaveClient>(FLUTTERWAVE_CLIENT);

    const argon2 = await import('argon2');
    const passwordHash = await argon2.hash(PASSWORD);
    await prisma.adminUser.deleteMany({ where: { id: { in: ADMIN_IDS } } });
    await prisma.adminUser.createMany({
      data: [
        { id: ADMIN_SUPER_ID, email: SUPER_EMAIL, name: 'Payments Super', role: 'superadmin', passwordHash },
        { id: ADMIN_FINANCE_ID, email: FINANCE_EMAIL, name: 'Payments Finance', role: 'finance', passwordHash },
        { id: ADMIN_SUPPORT_ID, email: SUPPORT_EMAIL, name: 'Payments Support', role: 'support', passwordHash },
        { id: ADMIN_REVIEWER_ID, email: REVIEWER_EMAIL, name: 'Payments Reviewer', role: 'reviewer', passwordHash },
      ],
    });

    superToken = await adminLogin(SUPER_EMAIL);
    financeToken = await adminLogin(FINANCE_EMAIL);
    supportToken = await adminLogin(SUPPORT_EMAIL);
    reviewerToken = await adminLogin(REVIEWER_EMAIL);
  }, 30000);

  beforeEach(async () => {
    await resetReceiptFixtures();
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.paymentWebhookReceipt.deleteMany({ where: { id: { in: STATIC_RECEIPT_IDS } } });
      await prisma.paymentWebhookReceipt.deleteMany({ where: { id: { in: createdReceiptIds } } });
      await prisma.pendingCharge.deleteMany({ where: { txRef: { in: createdTxRefs } } });
      if (createdCreditPurchaseIds.length) {
        await prisma.creditPurchase.deleteMany({
          where: { id: { in: createdCreditPurchaseIds } },
        });
      }
      if (throwawayUsers.length) {
        await prisma.creditsState.deleteMany({ where: { userWawuId: { in: throwawayUsers } } });
        await prisma.creatorState.deleteMany({ where: { wawuUserId: { in: throwawayUsers } } });
        await prisma.userProfile.deleteMany({ where: { wawuUserId: { in: throwawayUsers } } });
        await prisma.pendingCharge.deleteMany({ where: { wawuUserId: { in: throwawayUsers } } });
      }
      await prisma.adminUser.deleteMany({ where: { id: { in: ADMIN_IDS } } });
    }
    await app?.close();
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  // ── GET /admin/payments/receipts ──────────────────────────────────────────

  describe('GET /api/hub/admin/payments/receipts', () => {
    const list = (token: string, query: Record<string, unknown> = {}) =>
      http()
        .get('/api/hub/admin/payments/receipts')
        .query({ txRef: TX_PREFIX, perPage: 100, ...query })
        .set(auth(token));

    it('returns the standard paginated envelope, newest first', async () => {
      const res = await list(financeToken).expect(200);

      expect(res.body).toMatchObject({ statusCode: 200, message: 'OK' });
      expect(res.body.pagination).toMatchObject({ currentPage: 1, perPage: 100 });

      const ids: string[] = res.body.data.map((r: { id: string }) => r.id);
      for (const id of STATIC_RECEIPT_IDS) expect(ids).toContain(id);

      // Newest first is the default: the ignored fixture is the most recent.
      expect(ids.indexOf(RECEIPT_IGNORED)).toBeLessThan(ids.indexOf(RECEIPT_UNMATCHED));
    });

    it('honours ?sort=oldest', async () => {
      const res = await list(financeToken, { sort: 'oldest' }).expect(200);
      const ids: string[] = res.body.data.map((r: { id: string }) => r.id);
      expect(ids.indexOf(RECEIPT_UNMATCHED)).toBeLessThan(ids.indexOf(RECEIPT_IGNORED));
    });

    it('carries the fields a reconciliation screen renders, and NOT the raw payload', async () => {
      const res = await list(financeToken).expect(200);
      const row = res.body.data.find((r: { id: string }) => r.id === RECEIPT_UNMATCHED);

      expect(row).toMatchObject({
        deliveryKey: `charge.completed:${TX_PREFIX}unmatched`,
        event: 'charge.completed',
        txRef: `${TX_PREFIX}unmatched`,
        transactionId: 'flw-tx-apx-unmatched',
        status: 'unmatched',
        flow: null,
        detail: 'No money flow owns this tx_ref',
        settledAt: null,
        reverifiable: true,
      });
      expect(typeof row.waitingHours).toBe('number');
      // The raw provider body is a detail-only disclosure.
      expect(row).not.toHaveProperty('payload');
    });

    it('marks a settled receipt as NOT reverifiable, so the dashboard can disable the control', async () => {
      const res = await list(financeToken).expect(200);
      const byId = (id: string) => res.body.data.find((r: { id: string }) => r.id === id);

      expect(byId(RECEIPT_SETTLED).reverifiable).toBe(false);
      expect(byId(RECEIPT_RECEIVED).reverifiable).toBe(false);
      expect(byId(RECEIPT_UNMATCHED).reverifiable).toBe(true);
      expect(byId(RECEIPT_REJECTED).reverifiable).toBe(true);
      expect(byId(RECEIPT_FAILED).reverifiable).toBe(true);
      expect(byId(RECEIPT_IGNORED).reverifiable).toBe(true);
    });

    it('filters by a single status', async () => {
      const res = await list(financeToken, { status: 'unmatched' }).expect(200);
      const ids: string[] = res.body.data.map((r: { id: string }) => r.id);
      expect(ids).toEqual([RECEIPT_UNMATCHED]);
    });

    it("?status=unresolved is the README's reconciliation queue: unmatched + rejected + failed", async () => {
      const res = await list(financeToken, { status: 'unresolved' }).expect(200);
      const ids: string[] = res.body.data.map((r: { id: string }) => r.id);

      expect(ids.sort()).toEqual([RECEIPT_UNMATCHED, RECEIPT_REJECTED, RECEIPT_FAILED].sort());
      expect(ids).not.toContain(RECEIPT_SETTLED);
      expect(ids).not.toContain(RECEIPT_RECEIVED);
      expect(ids).not.toContain(RECEIPT_IGNORED);
    });

    it('filters by flow', async () => {
      const res = await list(financeToken, { flow: 'credit-purchase' }).expect(200);
      const ids: string[] = res.body.data.map((r: { id: string }) => r.id);
      expect(ids).toEqual([RECEIPT_SETTLED]);
    });

    it('matches a tx_ref partially and case-insensitively', async () => {
      const res = await http()
        .get('/api/hub/admin/payments/receipts')
        .query({ txRef: 'APX-UNMATCH', perPage: 100 })
        .set(auth(financeToken))
        .expect(200);
      const ids: string[] = res.body.data.map((r: { id: string }) => r.id);
      expect(ids).toEqual([RECEIPT_UNMATCHED]);
    });

    it('paginates', async () => {
      const first = await list(financeToken, { perPage: 2, page: 1 }).expect(200);
      const second = await list(financeToken, { perPage: 2, page: 2 }).expect(200);

      expect(first.body.data).toHaveLength(2);
      expect(first.body.pagination).toMatchObject({ currentPage: 1, perPage: 2, nextPage: 2 });
      expect(first.body.pagination.total).toBe(STATIC_RECEIPT_IDS.length);

      const firstIds = first.body.data.map((r: { id: string }) => r.id);
      const secondIds = second.body.data.map((r: { id: string }) => r.id);
      expect(secondIds).toHaveLength(2);
      expect(firstIds.some((id: string) => secondIds.includes(id))).toBe(false);
    });

    it('rejects an unknown query parameter (forbidNonWhitelisted)', async () => {
      await list(financeToken, { bogus: 'x' }).expect(400);
    });

    it('rejects an unknown status filter', async () => {
      await list(financeToken, { status: 'nonsense' }).expect(400);
    });

    it('is refused to support and reviewer, and to a WAWU ID user token', async () => {
      await list(supportToken).expect(403);
      await list(reviewerToken).expect(403);
      await list(userToken).expect(401);
      await http().get('/api/hub/admin/payments/receipts').expect(401);
    });

    it('is open to superadmin as well as finance', async () => {
      await list(superToken).expect(200);
    });
  });

  // ── GET /admin/payments/receipts/:id ──────────────────────────────────────

  describe('GET /api/hub/admin/payments/receipts/:id', () => {
    it('returns the charge block lifted out of the stored payload', async () => {
      const res = await http()
        .get(`/api/hub/admin/payments/receipts/${RECEIPT_UNMATCHED}`)
        .set(auth(financeToken))
        .expect(200);

      expect(res.body.data.charge).toEqual({
        flwRef: 'FLW-MOCK-flw-tx-apx-unmatched',
        amount: 5999,
        chargedAmount: 5999,
        currency: 'NGN',
        chargeStatus: 'successful',
        paymentType: 'card',
        customerEmail: 'buyer@test.wawu.dev',
        chargeCreatedAt: '2026-08-01T10:00:00.000Z',
      });
      // The raw delivery is the reconciliation evidence and is present here.
      expect(res.body.data.payload).toMatchObject({ event: 'charge.completed' });
    });

    it('says WHY it did not match, and that nothing owns the tx_ref now', async () => {
      const res = await http()
        .get(`/api/hub/admin/payments/receipts/${RECEIPT_UNMATCHED}`)
        .set(auth(financeToken))
        .expect(200);

      expect(res.body.data.diagnosis).toEqual({
        recordedReason: 'No money flow owns this tx_ref',
        currentlyOwnedBy: null,
        looksSettleableNow: false,
        reverifiable: true,
        reverifyBlockedReason: null,
      });
    });

    it('reports a stuck receipt as settleable NOW, because a flow owns the tx_ref today', async () => {
      const { receiptId } = await openStuckCreditPurchaseReceipt();

      const res = await http()
        .get(`/api/hub/admin/payments/receipts/${receiptId}`)
        .set(auth(financeToken))
        .expect(200);

      // This is the whole value of the diagnosis: the row says `unmatched`
      // because the webhook beat its own PendingCharge insert, and nothing
      // stored on it will ever say the charge turned up a second later.
      expect(res.body.data.diagnosis).toMatchObject({
        currentlyOwnedBy: 'credit-purchase',
        looksSettleableNow: true,
        reverifiable: true,
      });
    });

    it('explains why a settled receipt cannot be re-verified', async () => {
      const res = await http()
        .get(`/api/hub/admin/payments/receipts/${RECEIPT_SETTLED}`)
        .set(auth(financeToken))
        .expect(200);

      expect(res.body.data.diagnosis.reverifiable).toBe(false);
      expect(res.body.data.diagnosis.reverifyBlockedReason).toContain('already been settled');
    });

    it('404s on an unknown receipt', async () => {
      await http()
        .get(`/api/hub/admin/payments/receipts/${UNKNOWN_RECEIPT}`)
        .set(auth(financeToken))
        .expect(404);
    });

    it('is refused to support and reviewer, and to a WAWU ID user token', async () => {
      const path = `/api/hub/admin/payments/receipts/${RECEIPT_UNMATCHED}`;
      await http().get(path).set(auth(supportToken)).expect(403);
      await http().get(path).set(auth(reviewerToken)).expect(403);
      await http().get(path).set(auth(userToken)).expect(401);
      await http().get(path).expect(401);
    });
  });

  // ── POST /admin/payments/receipts/:id/reverify ────────────────────────────

  describe('POST /api/hub/admin/payments/receipts/:id/reverify', () => {
    const reverify = (token: string, id: string) =>
      http().post(`/api/hub/admin/payments/receipts/${id}/reverify`).set(auth(token));

    /**
     * THE load-bearing test. A genuinely stuck charge — a real PendingCharge
     * the webhook recorded as `unmatched` — is settled by a re-verify, and the
     * grant happens exactly once.
     */
    it('settles a genuinely stuck receipt, and grants EXACTLY once', async () => {
      const { wawuUserId, receiptId, purchaseId } =
        await openStuckCreditPurchaseReceipt();

      // Nothing has been granted yet.
      expect(await creditBalanceOf(wawuUserId)).toBe(0);

      // ---- first re-verify: the grant ------------------------------------
      const first = await reverify(financeToken, receiptId).expect(200);
      expect(first.body.data).toMatchObject({
        outcome: 'settled',
        flow: 'credit-purchase',
        granted: true,
      });
      expect(first.body.data.receipt).toMatchObject({ id: receiptId, status: 'settled' });
      expect(first.body.data.receipt.settledAt).not.toBeNull();

      // Everything the browser's own /verify would have granted, granted here.
      expect(await creditBalanceOf(wawuUserId)).toBe(CREDIT_PACK_CREDITS);
      expect(
        (await prisma.creditPurchase.findUniqueOrThrow({ where: { id: purchaseId } }))
          .status,
      ).toBe('completed');

      // ---- LAYER 1: the endpoint refuses a second re-verify ---------------
      const second = await reverify(financeToken, receiptId).expect(409);
      expect(second.body.message).toContain('already been settled');

      // ---- LAYER 2: force past the guard, and STILL no second grant -------
      // The receipt is pushed back to a reverifiable status directly in the
      // database, so this call genuinely re-enters the settlement path. If
      // re-verify had reimplemented settlement rather than reusing it, this is
      // where a second pack of credits would appear.
      await prisma.paymentWebhookReceipt.update({
        where: { id: receiptId },
        data: { status: 'failed', detail: 'forced back for the exactly-once assertion' },
      });

      await reverify(financeToken, receiptId).expect(200);

      // The purchase row is already `completed`, and that status is the claim
      // the settle path checks before crediting anything. One pack, still.
      expect(await creditBalanceOf(wawuUserId)).toBe(CREDIT_PACK_CREDITS);
    });

    it('does not grant when the charge is genuinely underpaid — the stored-amount control still holds', async () => {
      // The server stored an expectation of ₦18,999; Flutterwave will report
      // the ₦500 that was actually charged. There is no admin control that
      // can wave this through, which is the entire reason this endpoint
      // re-runs verification instead of offering "mark as paid".
      const { wawuUserId, receiptId } = await openStuckCreditPurchaseReceipt(18999);

      const res = await reverify(superToken, receiptId).expect(200);
      expect(res.body.data).toMatchObject({ outcome: 'rejected', granted: false });
      expect(res.body.data.detail).toContain('verification failed');

      expect(await creditBalanceOf(wawuUserId)).toBe(0);
      const receipt = await prisma.paymentWebhookReceipt.findUniqueOrThrow({
        where: { id: receiptId },
      });
      expect(receipt.status).toBe('rejected');
      expect(receipt.settledAt).toBeNull();
    });

    it('re-ignores an event that was never a settlement event', async () => {
      const res = await reverify(financeToken, RECEIPT_IGNORED).expect(200);
      expect(res.body.data).toMatchObject({ outcome: 'ignored', granted: false });
      expect(res.body.data.detail).toContain('not a settlement event');
    });

    it('refuses a receipt that is mid-flight', async () => {
      const res = await reverify(financeToken, RECEIPT_RECEIVED).expect(409);
      expect(res.body.message).toContain('being settled right now');
    });

    it('404s on an unknown receipt', async () => {
      await reverify(financeToken, UNKNOWN_RECEIPT).expect(404);
    });

    it('is refused to support and reviewer, and to a WAWU ID user token', async () => {
      await reverify(supportToken, RECEIPT_UNMATCHED).expect(403);
      await reverify(reviewerToken, RECEIPT_UNMATCHED).expect(403);
      await reverify(userToken, RECEIPT_UNMATCHED).expect(401);
      await http()
        .post(`/api/hub/admin/payments/receipts/${RECEIPT_UNMATCHED}/reverify`)
        .expect(401);
    });

    it('leaves the receipt untouched when the caller was refused', async () => {
      await reverify(supportToken, RECEIPT_UNMATCHED).expect(403);
      const receipt = await prisma.paymentWebhookReceipt.findUniqueOrThrow({
        where: { id: RECEIPT_UNMATCHED },
      });
      expect(receipt.status).toBe('unmatched');
      expect(receipt.detail).toBe('No money flow owns this tx_ref');
    });
  });
});
