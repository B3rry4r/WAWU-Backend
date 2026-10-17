import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import {
  api,
  bootTierApp,
  installFintava,
  type Person,
  type TierHarness,
} from '../../../../test/plans/tier-purchase-harness';
import { body } from '../../../../test/payments/poll-helpers';
import { loadPlansConfig, priceIn } from '../../plans-config';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { PlanTransferService } from '../plan-transfer.service';
import {
  EXPIRED_MESSAGE,
  PAYMENT_FAILED_WAITING_MESSAGE,
  settleKeyOf,
  TRANSFER_DEFAULTS,
} from '../plan-transfer-order';
import type {
  PlanPurchaseQuoteView,
  PlanPurchaseView,
  PlanTransferOrderView,
} from '../plan-purchase-view.type';

/**
 * TIER-05 round 2: the sweep looks at every waiting order, a payment made is
 * never reported as "nothing was taken", the settlement key is one a person
 * cannot send, and a payment that failed returns the order to waiting. On the
 * Fintava double (the default provider); no Fintava, Nuvion or wawuafrica.com
 * host is called.
 */

jest.setTimeout(240_000);

const config = loadPlansConfig();
const byPrice = [...config.tiers].sort((a, b) => a.price.kobo - b.price.kobo);
const small = byPrice[0];
const big = byPrice[byPrice.length - 1];
const smallPrice = priceIn(small.price, 'NGN');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Pay by bank transfer at checkout (TIER-05 round 2), Fintava double', () => {
  let h: TierHarness;
  let call: ReturnType<typeof api>;
  let transfers: PlanTransferService;
  let prisma: PrismaService;
  const synthetic: string[] = [];

  beforeAll(async () => {
    h = await bootTierApp('t05r2');
    call = api(h);
    prisma = h.prisma;
    transfers = h.get(PlanTransferService);
  });
  afterEach(async () => {
    installFintava(h.double, h.wallets);
    // Whatever a test left waiting must not be settled by the next test's sweep.
    await prisma.planTransferOrder.deleteMany({
      where: { status: 'awaiting', wawuUserId: { in: h.users } },
    });
  });
  afterAll(async () => {
    await prisma.planTransferOrder.deleteMany({
      where: { wawuUserId: { in: [...h.users, ...synthetic] } },
    });
    await h.close();
  });

  type Terms = {
    kind: 'tier' | 'renew' | 'upgrade';
    tierId: string;
    bump?: boolean;
  };
  const T: Terms = { kind: 'tier', tierId: small.id };
  const data = <T>(res: Response) => body<T>(res).data!;

  async function person(kobo: number): Promise<Person> {
    const p = await h.buyer(kobo);
    await prisma.fintavaWallet.update({
      where: { wawuUserId: p.id },
      data: { accountName: 'Ada Tester' },
    });
    return p;
  }
  const bal = (p: Person) => h.wallets.kobo.get(p.accountNumber) ?? 0;
  const sends = (p: Person) =>
    h.wallets.sends.filter((s) => s.from === p.accountNumber);
  async function quoted(p: Person, t: Terms) {
    const res = await call.quote(p, t);
    expect(res.status).toBe(200);
    return data<PlanPurchaseQuoteView>(res);
  }
  const req = (
    t: Terms,
    q: PlanPurchaseQuoteView,
    method: 'wallet' | 'transfer',
  ) => ({
    ...t,
    method,
    expectedTotalKobo: q.payment.totalKobo,
    quoteToken: q.payment.quoteToken,
  });
  async function order(p: Person, t: Terms) {
    const res = await call.buy(p, req(t, await quoted(p, t), 'transfer'));
    expect(res.status).toBe(201);
    return data<PlanTransferOrderView>(res);
  }
  /** Money arriving: the provider's balance and the ledger row the webhook writes. */
  async function credit(p: Person, kobo: number) {
    h.wallets.kobo.set(p.accountNumber, bal(p) + kobo);
    await prisma.fintavaLedgerEntry.create({
      data: {
        walletKind: 'user',
        wawuUserId: p.id,
        accountNumber: p.accountNumber,
        direction: 'in',
        status: 'completed',
        category: 'top_up',
        amountKobo: BigInt(kobo),
        totalKobo: BigInt(kobo),
        source: 'webhook',
        occurredAt: new Date(),
        provider: 'fintava',
      },
    });
    await sleep(5);
  }
  const statusOf = async (p: Person, id: string) =>
    data<PlanPurchaseView>(await call.read(p, id));
  const orderRow = (id: string) =>
    prisma.planTransferOrder.findUniqueOrThrow({ where: { id } });
  const paymentsOf = (p: Person) =>
    prisma.walletPayment.findMany({
      where: { payerWawuUserId: p.id },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        status: true,
        kind: true,
        targetId: true,
        openKey: true,
      },
    });

  /** `count` waiting orders of people with no wallet, oldest first, none due for `restMs`. */
  async function unfunded(count: number, restMs: number): Promise<string[]> {
    const oldest = Date.now() - 2 * 86_400_000;
    const ids: string[] = [];
    const rows = Array.from({ length: count }, (_, i) => {
      const uid = randomUUID();
      synthetic.push(uid);
      ids.push(uid);
      return {
        wawuUserId: uid,
        paymentKind: 'tier',
        targetId: `tier-${small.id}`,
        priceKobo: smallPrice,
        providerFeeKobo: 100,
        totalKobo: smallPrice + 100,
        status: 'awaiting',
        openKey: `${uid}:round2`,
        expiresAt: new Date(Date.now() + 3_600_000),
        nextCheckAt: new Date(Date.now() + restMs),
        createdAt: new Date(oldest + i * 1_000),
      };
    });
    await prisma.planTransferOrder.createMany({ data: rows });
    return ids;
  }
  const unfundedLeft = (ids: string[]) =>
    prisma.planTransferOrder.count({
      where: { wawuUserId: { in: ids }, status: 'awaiting' },
    });

  // -------------------------------------------------------------------------
  // 1. Every waiting order is looked at
  // -------------------------------------------------------------------------

  it('seventy unfunded orders waiting ahead of one whose money landed: the funded one pays on the next sweep', async () => {
    const ids = await unfunded(70, 4 * 60_000);
    const p = await person(0);
    const placed = await order(p, T);
    await credit(p, placed.transfer!.totalKobo);

    const report = await transfers.sweep();

    expect(report.paid).toBe(1);
    expect(sends(p)).toHaveLength(1);
    expect((await orderRow(placed.id)).status).toBe('settled');
    // Not one of the seventy was settled, closed or touched.
    expect(await unfundedLeft(ids)).toBe(70);
    await h.sweepLater(10 * 60_000);
    expect((await statusOf(p, placed.id)).status).toBe('paid');
    await prisma.planTransferOrder.deleteMany({
      where: { wawuUserId: { in: ids } },
    });
  });

  it('five hundred unfunded orders and five funded ones: all five pay within one sweep, and a bystander is never held up by the provider', async () => {
    const ids = await unfunded(500, 4 * 60_000);
    const funded: Person[] = [];
    for (let i = 0; i < 5; i += 1) {
      const p = await person(0);
      const placed = await order(p, T);
      await credit(p, placed.transfer!.totalKobo);
      funded.push(p);
    }
    const bystander = await person(0);
    // A slow provider: every balance read takes a second.
    h.double.on(
      'GET',
      /^\/customer\/wallet\/balance\//,
      (r: { path: string }) => {
        const account = h.wallets.byId.get(r.path.split('/').pop()!);
        const naira = (h.wallets.kobo.get(account ?? '') ?? 0) / 100;
        return {
          status: 200,
          delayMs: 1_000,
          body: {
            data: {
              balance: { bookedBalance: naira, availableBalance: naira },
              tier: 'TIER_2',
            },
            status: 200,
            message: 'ok',
          },
        };
      },
    );

    const started = Date.now();
    const sweep = transfers.sweep();
    await sleep(500);
    const latencies: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const at = Date.now();
      expect((await call.tier(bystander)).status).toBe(200);
      latencies.push(Date.now() - at);
      await sleep(200);
    }
    const report = await sweep;

    expect(Math.max(...latencies)).toBeLessThan(1_000);
    expect(report.paid).toBe(5);
    for (const p of funded) expect(sends(p)).toHaveLength(1);
    expect(await unfundedLeft(ids)).toBe(500);
    // One sweep's budget, however many orders wait.
    expect(Date.now() - started).toBeLessThan(TRANSFER_DEFAULTS.sweepBudgetMs);
    await prisma.planTransferOrder.deleteMany({
      where: { wawuUserId: { in: ids } },
    });
  });

  it('five hundred orders whose recheck came, ahead of five whose money landed: the five are settled first and all pay in one sweep', async () => {
    // People with no wallet, so each settles at once (closed); what matters is
    // that the five funded ones, newer than every one of them, are not behind.
    const ids = await unfunded(500, -60_000);
    const funded: Person[] = [];
    for (let i = 0; i < 5; i += 1) {
      const p = await person(0);
      const placed = await order(p, T);
      await credit(p, placed.transfer!.totalKobo);
      funded.push(p);
    }

    const report = await transfers.sweep();

    expect(report.paid).toBe(5);
    for (const p of funded) expect(sends(p)).toHaveLength(1);
    // The rest was taken in the same pass, or is still due for the next one.
    const closed = await prisma.planTransferOrder.count({
      where: { wawuUserId: { in: ids }, status: 'closed' },
    });
    expect(closed + (await unfundedLeft(ids))).toBe(500);
    expect(report.closed).toBe(closed);
    await prisma.planTransferOrder.deleteMany({
      where: { wawuUserId: { in: ids } },
    });
  });

  it('an order the sweep checked and found unfunded is not read again until a new credit or its recheck', async () => {
    const p = await person(0);
    const placed = await order(p, T);
    await credit(p, 1_000);
    expect((await transfers.sweep()).waiting).toBe(1);
    const reads = () =>
      h.double.seen.filter((r) => /\/customer\/wallet\/balance\//.test(r.path))
        .length;
    const before = reads();
    expect((await transfers.sweep()).waiting).toBe(0);
    expect(reads()).toBe(before);
    await credit(p, placed.transfer!.totalKobo);
    expect((await transfers.sweep()).paid).toBe(1);
    expect(sends(p)).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // 2. A payment that was made is never reported as "nothing was taken"
  // -------------------------------------------------------------------------

  it('the payment was made, linking failed, and the window lapsed before the retry: the order is linked and paid, never expired', async () => {
    const p = await person(0);
    const placed = await order(p, T);
    await credit(p, placed.transfer!.totalKobo);
    const link = jest
      .spyOn(
        transfers as unknown as { link: (...a: unknown[]) => Promise<boolean> },
        'link',
      )
      .mockRejectedValueOnce(new Error('connection lost'));
    try {
      expect(await transfers.settleOrder(placed.id)).toBe('retry');
    } finally {
      link.mockRestore();
    }
    expect(sends(p)).toHaveLength(1);
    expect((await orderRow(placed.id)).status).toBe('awaiting');
    await prisma.planTransferOrder.update({
      where: { id: placed.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    const report = await transfers.sweep(new Date(Date.now() + 5_000));

    expect(report.expired).toBe(0);
    const row = await orderRow(placed.id);
    expect(row.status).toBe('settled');
    expect(row.paymentId).not.toBeNull();
    await h.sweepLater(10 * 60_000);
    const view = await statusOf(p, placed.id);
    expect(view.status).toBe('paid');
    expect(view.statusMessage ?? '').not.toContain('Nothing was taken');
    expect(sends(p)).toHaveLength(1);
    expect(await paymentsOf(p)).toHaveLength(1);
  });

  it('a lapsed order whose key names no payment expires, nothing taken', async () => {
    const p = await person(0);
    const placed = await order(p, T);
    await prisma.planTransferOrder.update({
      where: { id: placed.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    const report = await transfers.sweep(new Date(Date.now() + 5_000));
    expect(report.expired).toBeGreaterThanOrEqual(1);
    const row = await orderRow(placed.id);
    expect(row.status).toBe('expired');
    expect(row.statusMessage).toBe(EXPIRED_MESSAGE);
    expect(sends(p)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 3. The settlement key is one a person cannot send
  // -------------------------------------------------------------------------

  it("a wallet purchase sent with the old shape of the settlement key is not the order's payment", async () => {
    const p = await person(50_000_000);
    const placed = await order(p, T);
    const other: Terms = { kind: 'tier', tierId: big.id };
    const bought = await call.buy(
      p,
      req(other, await quoted(p, other), 'wallet'),
      { key: `transfer-${placed.id}` },
    );
    expect(bought.status).toBe(201);
    const [otherPayment] = await paymentsOf(p);
    expect(otherPayment.targetId).toBe(`tier-${big.id}`);
    expect(sends(p)).toHaveLength(1);

    // The sweep reaches the order. It is not linked to the other item's
    // payment, whatever key that payment was made under (the larger plan the
    // person now holds also makes the small one not payable: closed).
    await transfers.sweep(new Date(Date.now() + 5 * 60_000));
    const row = await orderRow(placed.id);
    expect(row.paymentId).toBeNull();
    expect(row.status).not.toBe('settled');
    expect(await paymentsOf(p)).toHaveLength(1);
    expect(sends(p)).toHaveLength(1);
  });

  it('the settlement key is refused as a person-sent Idempotency-Key, in the money error shape', async () => {
    const p = await person(50_000_000);
    const placed = await order(p, T);
    const q = await quoted(p, T);
    const res = await call.buy(p, req(T, q, 'wallet'), {
      key: settleKeyOf(placed.id),
    });
    expect(res.status).toBe(400);
    expect(body<unknown>(res).reason).toMatchObject({
      code: 'idempotency_key_required',
    });
    expect(sends(p)).toHaveLength(0);
    expect(await paymentsOf(p)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 4. A payment that failed returns the order to waiting
  // -------------------------------------------------------------------------

  const refuseSends = () =>
    h.double.on('POST', '/transaction/wallet-to-wallet', () => ({
      status: 400,
      body: {
        status: 400,
        message: ['Receiver account is not allowed to receive'],
        error: 'Bad Request',
      },
    }));

  it('a refusal the Hub does not know returns the order to waiting, unlinked; the next try pays once', async () => {
    const p = await person(0);
    const placed = await order(p, T);
    await credit(p, placed.transfer!.totalKobo);
    refuseSends();

    expect(await transfers.settleOrder(placed.id)).toBe('retry');

    const waiting = await orderRow(placed.id);
    expect(waiting.status).toBe('awaiting');
    expect(waiting.paymentId).toBeNull();
    expect(waiting.statusMessage).toBe(PAYMENT_FAILED_WAITING_MESSAGE);
    expect(waiting.nextCheckAt!.getTime()).toBeGreaterThan(Date.now());
    expect((await paymentsOf(p)).map((x) => x.status)).toEqual(['failed']);
    const view = await statusOf(p, placed.id);
    expect(view.status).toBe('awaiting_transfer');
    expect(sends(p)).toHaveLength(0);
    expect(bal(p)).toBeGreaterThanOrEqual(placed.transfer!.totalKobo);
    // It rests: sweeps before the next check make no second payment.
    const resting = await transfers.sweep(new Date(Date.now() + 5_000));
    expect(resting.retry + resting.paid + resting.pending).toBe(0);
    expect(await paymentsOf(p)).toHaveLength(1);

    // The provider takes it now: the retry is one payment, the only one made.
    installFintava(h.double, h.wallets);
    const report = await transfers.sweep(new Date(Date.now() + 10 * 60_000));
    expect(report.paid + report.pending).toBe(1);
    await h.sweepLater(10 * 60_000);
    expect(sends(p)).toHaveLength(1);
    expect((await paymentsOf(p)).map((x) => x.status)).toEqual([
      'failed',
      'completed',
    ]);
    expect((await statusOf(p, placed.id)).status).toBe('paid');
    // And no third try.
    await transfers.sweep(new Date(Date.now() + 20 * 60_000));
    expect(sends(p)).toHaveLength(1);
    expect(await paymentsOf(p)).toHaveLength(2);
  });

  it('a refusal after the window lapsed expires the order, nothing taken, and tries nothing more', async () => {
    const p = await person(0);
    const placed = await order(p, T);
    await credit(p, placed.transfer!.totalKobo);
    refuseSends();
    // Taken just before the window ends, refused just after it.
    const near = new Date(Date.now() + 60_000);
    await prisma.planTransferOrder.update({
      where: { id: placed.id },
      data: { expiresAt: near },
    });
    expect(
      await transfers.settleOrder(placed.id, new Date(near.getTime() - 1)),
    ).toBe('retry');
    expect((await orderRow(placed.id)).status).toBe('awaiting');
    // The window runs out before the retry.
    const report = await transfers.sweep(new Date(near.getTime() + 60_000));
    expect(report.expired).toBe(1);
    const row = await orderRow(placed.id);
    expect(row.status).toBe('expired');
    expect(row.paymentId).toBeNull();
    expect(sends(p)).toHaveLength(0);
    expect(await paymentsOf(p)).toHaveLength(1);
  });

  it('a failed payment found when the claim was recovered is let go of, never linked', async () => {
    const p = await person(0);
    const placed = await order(p, T);
    await credit(p, placed.transfer!.totalKobo);
    refuseSends();
    // The process dies after the refusal was recorded and before the order moved.
    const waitAgain = jest
      .spyOn(
        transfers as unknown as {
          waitAgain: (...a: unknown[]) => Promise<void>;
        },
        'waitAgain',
      )
      .mockRejectedValue(new Error('killed'));
    try {
      await transfers.settleOrder(placed.id).catch(() => undefined);
    } finally {
      waitAgain.mockRestore();
    }
    await prisma.planTransferOrder.update({
      where: { id: placed.id },
      data: {
        status: 'settling',
        settlingSince: new Date(Date.now() - 3_600_000),
      },
    });
    installFintava(h.double, h.wallets);
    expect(await transfers.recoverStale(new Date())).toBe(1);
    const row = await orderRow(placed.id);
    expect(row.status).toBe('awaiting');
    expect(row.paymentId).toBeNull();
    expect((await transfers.sweep()).paid).toBeGreaterThanOrEqual(0);
    await transfers.sweep(new Date(Date.now() + 10 * 60_000));
    await h.sweepLater(10 * 60_000);
    expect(sends(p)).toHaveLength(1);
    expect((await paymentsOf(p)).map((x) => x.status)).toEqual([
      'failed',
      'completed',
    ]);
  });
});
