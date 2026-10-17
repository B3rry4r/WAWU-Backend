import { randomUUID } from 'node:crypto';
import {
  api,
  type BillHarness,
  bootBillApp,
  type Person,
  purchaseRow,
  TOKEN,
} from '../../../test/bills/wallet-bill-harness';
import { body } from '../../../test/payments/poll-helpers';
import { WalletBillService } from '../wallet-bill.service';
import type {
  WalletBillQuoteView,
  WalletBillView,
} from '../wallet-bill-view.type';

/**
 * FIX-42 (BILLS-04 follow-ups, lead rulings 16 Oct 2026), over the repo's
 * Fintava double and a real database:
 *
 * 1. The earlier same-meter bill's delivery time, plus the history skew, is
 *    where a second bill's record may start: with clock skew and no ids the
 *    second bill stays processing.
 * 2. The half-hourly look for late successes: newest failures first, the
 *    merchant history read back to the oldest failure, an index on
 *    failedAt, only the running provider's payments, one pass at a time.
 */

const AMOUNT = 1_000_000;
const START = 9_000_000;
const note = (label: string, v: unknown) =>
  process.stdout.write(`\nFIX42 ${label}: ${JSON.stringify(v)}\n`);
const electricity = (meter: string) => ({
  category: 'electricity',
  code: 'Ikeja_Electric_Bill_Payment',
  accountNumber: meter,
  amountKobo: AMOUNT,
});
let meterSeq = 0;
const freshMeter = () =>
  `0${String(Date.now()).slice(-6)}${String((meterSeq += 1)).padStart(4, '0')}`;

jest.setTimeout(180_000);

describe('FIX-42: bills follow-ups', () => {
  let h: BillHarness;
  let r: ReturnType<typeof api>;
  let svc: WalletBillService;
  let routes0: unknown[] = [];
  let meter = freshMeter();
  const doubleRoutes = () =>
    (h.double as unknown as { routes: unknown[] }).routes;

  const mk = async (p: Person, m = meter) =>
    body<WalletBillQuoteView>(await r.create(p, electricity(m)).expect(201))
      .data!;
  const pb = (q: WalletBillQuoteView) => ({
    billId: q.bill.id,
    expectedTotalKobo: q.payment.totalKobo,
    quoteToken: q.payment.quoteToken,
  });
  const row = (id: string) =>
    h.prisma.walletBill.findUniqueOrThrow({ where: { id } });
  const hold = (id: string) =>
    h.prisma.walletHold.findFirst({ where: { targetId: id } });
  const historyCalls = () =>
    h.double.seen.filter((s) => s.path === '/txn/merchant').length;
  const lateNotes = async (paymentId: string) =>
    (
      await h.prisma.walletPayment.findUniqueOrThrow({
        where: { id: paymentId },
      })
    ).discrepancy ?? '';

  const made: Array<{ billId: string; paymentId: string }> = [];
  /** A bill that failed and was refunded, written straight to the database. */
  async function failedBill(
    p: Person,
    o: {
      meter: string;
      sentAt: Date;
      failedAt: Date;
      provider?: string;
    },
  ) {
    const id = randomUUID();
    const paymentId = randomUUID();
    await h.prisma.walletPayment.create({
      data: {
        id: paymentId,
        payerWawuUserId: p.id,
        kind: 'bill',
        targetId: id,
        title: 'Ikeja Electric',
        priceKobo: BigInt(AMOUNT + 10_000),
        providerFeeKobo: 1575n,
        wawuFeeKobo: 0n,
        totalKobo: BigInt(AMOUNT + 11_575),
        payeeShareKobo: 0n,
        wawuShareKobo: BigInt(AMOUNT + 10_000),
        customerReference: `wawu-pay-${paymentId}`,
        merchantAccountNumber: '9000000001',
        provider: o.provider ?? 'fintava',
        status: 'completed',
        completedAt: o.sentAt,
        createdAt: o.sentAt,
      },
    });
    made.push({ billId: id, paymentId });
    return h.prisma.walletBill.create({
      data: {
        id,
        wawuUserId: p.id,
        category: 'electricity',
        billerCode: 'Ikeja_Electric_Bill_Payment',
        title: 'Ikeja Electric',
        planType: 'prepaid',
        accountNumber: o.meter,
        amountKobo: BigInt(AMOUNT),
        billChargeKobo: 10_000n,
        serviceFeeKobo: 0n,
        status: 'failed',
        reference: `WAW-BIL-${id.slice(0, 8)}`,
        paymentId,
        purchaseSentAt: o.sentAt,
        failedAt: o.failedAt,
        failureReason: 'The biller refused it.',
        createdAt: o.sentAt,
      },
    });
  }
  /** The record Fintava would list for a purchase of `meterNumber`, made at `at`. */
  const record = (meterNumber: string, at: Date, over = {}) =>
    purchaseRow({
      amount: '10000.00',
      meternumber: meterNumber,
      metertoken: TOKEN,
      createdAt: at.toISOString(),
      ...over,
    });

  beforeAll(async () => {
    h = await bootBillApp('fix42');
    r = api(h);
    svc = h.app.get(WalletBillService);
    routes0 = [...doubleRoutes()];
  });
  afterAll(async () => {
    await h.close();
  });
  afterEach(async () => {
    // Failures a spec wrote by hand must not crowd the next spec's pass.
    const ids = made.splice(0);
    await h.prisma.fintavaLedgerEntry.deleteMany({
      where: {
        customerReference: { in: ids.map((m) => `wawu-bill-${m.billId}`) },
      },
    });
    await h.prisma.walletBill.deleteMany({
      where: { id: { in: ids.map((m) => m.billId) } },
    });
    await h.prisma.walletPayment.deleteMany({
      where: { id: { in: ids.map((m) => m.paymentId) } },
    });
  });
  beforeEach(() => {
    (h.double as unknown as { routes: unknown[] }).routes = [...routes0];
    meter = freshMeter();
    h.book.mode = 'ok';
    h.book.purchases.length = 0;
    h.book.history.length = 0;
    h.double.seen.length = 0;
    h.wallets.mode = 'live';
    h.wallets.sends.length = 0;
    h.logger.lines.length = 0;
  });

  describe('1. the guard against the earlier bill is not fooled by a skewed clock', () => {
    it.each([0, 500, 3000])(
      'the first bill answered with no ids, Fintava %i ms ahead: the second (504, nothing bought) stays processing with its hold held',
      async (skew) => {
        const p = await h.buyer(START);
        h.double.on('POST', '/billing/electricity', () => {
          h.book.purchases.push({
            path: '/billing/electricity',
            body: {},
            amountKobo: AMOUNT,
          });
          return {
            status: 200,
            body: {
              data: { amount: AMOUNT / 100, metertoken: TOKEN },
              status: 200,
              message: 'ok',
            },
          };
        });
        const qa = await mk(p);
        await r.pay(p, pb(qa)).expect(201);
        const a = await row(qa.bill.id);
        expect(a.status).toBe('delivered');
        expect(a.fintavaTransactionId).toBeNull();
        // The first bill's record, as Fintava's clock (`skew` ms ahead) made it.
        const made =
          (a.purchaseSentAt!.getTime() + a.deliveredAt!.getTime()) / 2 + skew;
        h.book.history.push(record(meter, new Date(made)));
        h.double.on('POST', '/billing/electricity', () => ({
          status: 504,
          body: 'gateway timeout',
          contentType: 'text/plain',
        }));
        const qb = await mk(p);
        await r.pay(p, pb(qb)).expect(201);
        await h.sweepLater(3 * 60_000);
        const b = await row(qb.bill.id);
        note(`guard skew=${skew}`, {
          status: b.status,
          token: b.token,
          hold: (await hold(qb.bill.id))?.status,
        });
        expect(b.status).not.toBe('delivered');
        expect(b.token).toBeNull();
        expect((await hold(qb.bill.id))?.status).toBe('held');
      },
    );
  });

  describe('2. the late-success look', () => {
    it('looks at the newest failures first: with more failures than one pass reads, the newest is found', async () => {
      const p = await h.buyer(START);
      const now = new Date();
      const sentAt = (i: number) => new Date(now.getTime() - (4 + i) * 60_000);
      // 51 older failures, then the newest one, whose purchase did happen.
      for (let i = 0; i < 51; i += 1) {
        await failedBill(p, {
          meter: freshMeter(),
          sentAt: sentAt(100 - i),
          failedAt: new Date(sentAt(100 - i).getTime() + 30_000),
        });
      }
      const newest = await failedBill(p, {
        meter,
        sentAt: new Date(now.getTime() - 3 * 60_000),
        failedAt: new Date(now.getTime() - 2 * 60_000),
      });
      h.book.history.push(
        record(meter, new Date(now.getTime() - 3 * 60_000 + 5_000)),
      );
      await svc.scanLateSuccesses(now);
      expect(await lateNotes(newest.paymentId!)).toMatch(/refunded/);
      expect(historyCalls()).toBeGreaterThan(0);
    });

    it('reads Fintava history back to the oldest failure, not only the newest 100 records', async () => {
      const p = await h.buyer(START);
      const now = new Date();
      const sent = new Date(now.getTime() - 3 * 3_600_000);
      const failed = await failedBill(p, {
        meter,
        sentAt: sent,
        failedAt: new Date(sent.getTime() + 60_000),
      });
      // 150 later records for other meters in front of ours, newest first.
      const rows = Array.from({ length: 150 }, (_, i) =>
        record(
          `09${String(i).padStart(9, '0')}`,
          new Date(now.getTime() - 60_000 - i * 1_000),
          { amount: '55.00' },
        ),
      );
      rows.push(record(meter, new Date(sent.getTime() + 5_000)));
      h.book.history.push(...rows);
      h.double.on('GET', '/txn/merchant', (req) => {
        const take = Number(req.query.take ?? 10);
        const page = Number(req.query.page ?? 1);
        const all = (h.book.history as Array<{ createdAt: string }>)
          .slice()
          .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
        const pageCount = Math.max(1, Math.ceil(all.length / take));
        return {
          status: 200,
          body: {
            data: all.slice((page - 1) * take, page * take),
            meta: {
              page: String(page),
              take: String(take),
              itemCount: all.length,
              pageCount,
              hasPreviousPage: page > 1,
              hasNextPage: page < pageCount,
            },
          },
        };
      });
      await svc.scanLateSuccesses(now);
      note('paged calls', historyCalls());
      expect(await lateNotes(failed.paymentId!)).toMatch(/refunded/);
      expect(historyCalls()).toBeGreaterThan(1);
    });

    it('has an index on failedAt', async () => {
      const found = await h.prisma.$queryRaw<Array<{ indexdef: string }>>`
        SELECT indexdef FROM pg_indexes
         WHERE tablename = 'WalletBill' AND indexdef ILIKE '%"failedAt"%'`;
      expect(found.length).toBeGreaterThan(0);
    });

    it('under another provider it never calls Fintava for a Fintava bill and writes no ledger row; a bill of the other provider is left alone', async () => {
      const p = await h.buyer(START);
      const now = new Date();
      const sent = new Date(now.getTime() - 5 * 60_000);
      const own = await failedBill(p, {
        meter,
        sentAt: sent,
        failedAt: new Date(sent.getTime() + 30_000),
      });
      h.book.history.push(record(meter, new Date(sent.getTime() + 5_000)));
      const running = (svc as unknown as { provider: { name: string } })
        .provider;
      // A server that runs Nuvion, with this Fintava bill left in its database.
      (svc as unknown as { provider: { name: string } }).provider = {
        name: 'nuvion',
      };
      try {
        await svc.scanLateSuccesses(now);
      } finally {
        (svc as unknown as { provider: unknown }).provider = running;
      }
      expect(historyCalls()).toBe(0);
      expect(
        await h.prisma.fintavaLedgerEntry.count({
          where: { customerReference: `wawu-bill-${own.id}` },
        }),
      ).toBe(0);
      expect(await lateNotes(own.paymentId!)).not.toMatch(/refunded/);

      // And a Fintava server leaves a Nuvion payment's bill alone.
      const other = await failedBill(p, {
        meter: freshMeter(),
        sentAt: sent,
        failedAt: new Date(sent.getTime() + 30_000),
        provider: 'nuvion',
      });
      h.book.history.length = 0;
      h.book.history.push(
        record(
          (await row(other.id)).accountNumber!,
          new Date(sent.getTime() + 5_000),
        ),
      );
      h.double.seen.length = 0;
      await svc.scanLateSuccesses(now);
      expect(await lateNotes(other.paymentId!)).not.toMatch(/refunded/);
      expect(
        await h.prisma.fintavaLedgerEntry.count({
          where: { customerReference: `wawu-bill-${other.id}` },
        }),
      ).toBe(0);
    });

    it('runs one pass at a time: a second call while one is running does nothing, and a second server that claims from the same state does not look', async () => {
      const p = await h.buyer(START);
      const now = new Date();
      const sent = new Date(now.getTime() - 5 * 60_000);
      const failed = await failedBill(p, {
        meter,
        sentAt: sent,
        failedAt: new Date(sent.getTime() + 30_000),
      });
      h.book.history.push(record(meter, new Date(sent.getTime() + 5_000)));
      // Two calls in one process.
      await Promise.all([
        svc.scanLateSuccesses(now),
        svc.scanLateSuccesses(now),
      ]);
      expect(historyCalls()).toBe(1);
      expect(await lateNotes(failed.paymentId!)).toMatch(/refunded/);

      // Two servers that read the same failures before either claimed them.
      const second = await failedBill(p, {
        meter: freshMeter(),
        sentAt: sent,
        failedAt: new Date(sent.getTime() + 40_000),
      });
      const snapshot = [await row(second.id)];
      const claim = (s: WalletBillService) =>
        (
          s as unknown as {
            claimLatePass: (rows: unknown[]) => Promise<boolean>;
          }
        ).claimLatePass(snapshot);
      const twin = Object.assign(
        Object.create(Object.getPrototypeOf(svc) as object) as object,
        svc,
      );
      expect([await claim(svc), await claim(twin)]).toEqual([true, false]);
    });
  });

  it('a view of a bill still reads as before (sanity)', async () => {
    const p = await h.buyer(START);
    const q = await mk(p);
    const paid = await r.pay(p, pb(q)).expect(201);
    expect(body<WalletBillView>(paid).data!.status).toBe('delivered');
  });
});
