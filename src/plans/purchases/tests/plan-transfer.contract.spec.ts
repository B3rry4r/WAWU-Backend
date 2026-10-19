import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import {
  api,
  bootTierApp,
  type Person,
  type TierHarness,
} from '../../../../test/plans/tier-purchase-harness';
import { sweepWithDue } from '../../../../test/plans/lapsed-orders';
import { NuvionSeamStandIn } from '../../../../test/payments/nuvion-seam-standin';
import { body, until } from '../../../../test/payments/poll-helpers';
import { AdminRole } from '../../../../generated/prisma/enums';
import type { AdminActor } from '../../../common/audit/admin-ops-audit.service';
import { PlanSettingsService } from '../../../plan-settings/plan-settings.service';
import { loadPlansConfig, priceIn } from '../../plans-config';
import type { MyTierView } from '../../plans-view.type';
import type { MyPointsView } from '../../../points/points-view.type';
import { PlanTransferService } from '../plan-transfer.service';
import {
  EXPIRED_MESSAGE,
  PAID_ANOTHER_WAY_MESSAGE,
  REPLACED_MESSAGE,
} from '../plan-transfer-order';
import type {
  PlanPurchaseQuoteView,
  PlanPurchaseView,
  PlanTransferOrderView,
} from '../plan-purchase-view.type';

/**
 * TIER-05: pay a purchase by bank transfer at checkout, on the wallet provider
 * seam with NUVION stood in (the money-in rows are the ledger rows NUV-04's
 * handler writes: an `in` row of category `top_up`, and the stand-in account's
 * available balance grows with it). No Nuvion, Fintava, Flutterwave or
 * wawuafrica.com host is called. NUVION_FEE is a spec value, not a fact about
 * Nuvion.
 */

jest.setTimeout(180_000);

const NUVION_FEE = 2325;
const config = loadPlansConfig();
const byPrice = [...config.tiers].sort((a, b) => a.price.kobo - b.price.kobo);
const small = byPrice[0];
const big = byPrice[byPrice.length - 1];
const smallPrice = priceIn(small.price, 'NGN');
const bigPrice = priceIn(big.price, 'NGN');
const admin: AdminActor = {
  id: randomUUID(),
  email: 'tier05@admin.test.wawu.dev',
  role: AdminRole.finance,
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Pay by bank transfer at checkout (TIER-05), Nuvion stood in', () => {
  const nuvion = new NuvionSeamStandIn();
  let h: TierHarness;
  let call: ReturnType<typeof api>;
  let transfers: PlanTransferService;
  let settings: PlanSettingsService;

  beforeAll(async () => {
    nuvion.feeKobo = () => BigInt(NUVION_FEE);
    h = await bootTierApp('t05', { nuvion, nuvionFeeKobo: NUVION_FEE });
    call = api(h);
    transfers = h.get(PlanTransferService);
    settings = h.get(PlanSettingsService);
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(() => {
    nuvion.mode = 'successful';
  });

  type Terms = {
    kind: 'tier' | 'renew' | 'upgrade';
    tierId: string;
    bump?: boolean;
  };
  const data = <T>(res: Response) => body<T>(res).data!;
  const reasonOf = (res: Response) => body<unknown>(res).reason!;

  /** A person with an open wallet holding `kobo`, an account name and a PIN. */
  async function person(kobo: number): Promise<Person> {
    const p = await h.buyer(kobo);
    await h.prisma.fintavaWallet.update({
      where: { wawuUserId: p.id },
      data: { accountName: 'Ada Tester' },
    });
    return p;
  }
  async function quoted(p: Person, t: Terms): Promise<PlanPurchaseQuoteView> {
    const res = await call.quote(p, t);
    expect(res.status).toBe(200);
    return data<PlanPurchaseQuoteView>(res);
  }
  const request = (
    t: Terms,
    q: PlanPurchaseQuoteView,
    method: 'wallet' | 'transfer',
  ) => ({
    ...t,
    method,
    expectedTotalKobo: q.payment.totalKobo,
    quoteToken: q.payment.quoteToken,
  });
  /** Places a transfer order for `t` and returns what the person is told. */
  async function order(p: Person, t: Terms) {
    const res = await call.buy(p, request(t, await quoted(p, t), 'transfer'));
    expect(res.status).toBe(201);
    return data<PlanTransferOrderView>(res);
  }
  /** Money arriving in the person's wallet account: the balance and the ledger row NUV-04 writes. */
  async function credit(p: Person, kobo: number) {
    p.account!.availableKobo += BigInt(kobo);
    await h.prisma.fintavaLedgerEntry.create({
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
        provider: 'nuvion',
      },
    });
    await sleep(5);
  }
  const balance = (p: Person) => Number(p.account!.availableKobo);
  const sendsFrom = (p: Person) => nuvion.sendsFrom(p.account!.accountId);
  const rows = (p: Person) =>
    h.prisma.makerPurchase.findMany({ where: { wawuUserId: p.id } });
  const balanceReads = () =>
    nuvion.calls.filter((c) => c.method === 'getBalance').length;
  const read = (p: Person, id: string) => call.read(p, id);
  const statusOf = async (p: Person, id: string) =>
    data<PlanPurchaseView | PlanTransferOrderView>(await read(p, id));

  it('shows the person their own account number, the Bank charge and the amount still needed; when the money lands the purchase completes once and grants once', async () => {
    const p = await person(1_000);
    const t: Terms = { kind: 'tier', tierId: small.id };
    const placed = await order(p, t);
    expect(placed).toMatchObject({
      method: 'transfer',
      status: 'awaiting_transfer',
      amountMinor: smallPrice,
      payment: null,
      grant: null,
      paidAt: null,
      transfer: {
        accountNumber: p.accountNumber,
        accountName: 'Ada Tester',
        priceKobo: smallPrice,
        bankChargeKobo: NUVION_FEE,
        totalKobo: smallPrice + NUVION_FEE,
        balanceKobo: 1_000,
        amountNeededKobo: smallPrice + NUVION_FEE - 1_000,
      },
    });
    expect(placed.transfer!.bankName.length).toBeGreaterThan(0);
    // Nothing is taken or granted before the money lands, and a pass with no
    // new money does not even ask the provider for the balance.
    const reads = balanceReads();
    await transfers.sweep();
    expect(balanceReads()).toBe(reads);
    expect(sendsFrom(p)).toHaveLength(0);
    expect(await rows(p)).toHaveLength(0);
    const waiting = await statusOf(p, placed.id);
    expect(waiting).toMatchObject({
      id: placed.id,
      status: 'awaiting_transfer',
      transfer: { amountNeededKobo: smallPrice + NUVION_FEE - 1_000 },
    });

    await credit(p, placed.transfer!.amountNeededKobo!);
    const pass = await transfers.sweep();
    expect(pass.paid).toBe(1);

    const paid = (await statusOf(p, placed.id)) as PlanPurchaseView;
    expect(paid).toMatchObject({
      id: placed.id,
      method: 'transfer',
      status: 'paid',
      amountMinor: smallPrice,
      payment: { kind: 'tier', status: 'completed', delivered: true },
    });
    expect(paid.grant).toMatchObject({
      tier: { id: small.id },
      bonusPoints: small.bonusPoints,
    });
    expect(sendsFrom(p)).toHaveLength(1);
    expect(sendsFrom(p)[0]).toMatchObject({
      amountKobo: BigInt(smallPrice),
      feeKobo: BigInt(NUVION_FEE),
      toAccountId: nuvion.operational.accountId,
    });
    expect(balance(p)).toBe(0);
    expect(await rows(p)).toHaveLength(1);
    expect(data<MyTierView>(await call.tier(p))).toMatchObject({
      state: 'active',
      tier: { id: small.id },
    });
    expect(data<MyPointsView>(await call.points(p)).balance).toBe(
      small.bonusPoints,
    );
    // The payment's own id reads the same purchase.
    const byPayment = data<PlanPurchaseView>(await read(p, paid.payment.id));
    expect(byPayment).toMatchObject({ id: placed.id, method: 'transfer' });
  });

  it('less than needed leaves it waiting with the new amount still needed; more completes it and leaves the rest in the wallet', async () => {
    const p = await person(0);
    const t: Terms = { kind: 'tier', tierId: small.id, bump: true };
    const placed = await order(p, t);
    const total = placed.transfer!.totalKobo;
    expect(placed.transfer!.amountNeededKobo).toBe(total);

    await credit(p, 1_000);
    expect((await transfers.sweep()).waiting).toBe(1);
    const still = (await statusOf(p, placed.id)) as PlanTransferOrderView;
    expect(still.status).toBe('awaiting_transfer');
    expect(still.transfer).toMatchObject({
      balanceKobo: 1_000,
      amountNeededKobo: total - 1_000,
    });
    expect(sendsFrom(p)).toHaveLength(0);

    const extra = 777;
    await credit(p, total - 1_000 + extra);
    expect((await transfers.sweep()).paid).toBe(1);
    const paid = (await statusOf(p, placed.id)) as PlanPurchaseView;
    expect(paid.status).toBe('paid');
    expect(paid.payment.kind).toBe('tier_bump');
    expect(balance(p)).toBe(extra);
    expect(await rows(p)).toHaveLength(1);
  });

  it('a transfer delivered twice, a sweep and another server finding it together, and a later transfer all complete it once (V8)', async () => {
    const p = await person(0);
    const placed = await order(p, { kind: 'tier', tierId: small.id });
    const total = placed.transfer!.totalKobo;
    await credit(p, total);
    // The same credit seen by ten settlements at once: one takes the order.
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => transfers.settleOrder(placed.id)),
    );
    expect(outcomes.filter((o) => o === 'paid')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'skipped')).toHaveLength(9);
    // The credit delivered again (a second row), the sweep, and a much later pass.
    await credit(p, total);
    await transfers.sweep();
    await transfers.sweep(new Date(Date.now() + 10 * 60_000));
    await h.sweepLater(70 * 60_000);
    expect(sendsFrom(p)).toHaveLength(1);
    expect(await rows(p)).toHaveLength(1);
    expect(balance(p)).toBe(total);
    expect(
      await h.prisma.planTransferOrder.count({
        where: { wawuUserId: p.id, status: 'settled' },
      }),
    ).toBe(1);
    expect(
      await h.prisma.pointLot.count({
        where: { wawuUserId: p.id, source: 'tier_bonus' },
      }),
    ).toBe(1);
  });

  it('a payment Nuvion first calls pending grants nothing until it is successful, then once', async () => {
    const p = await person(0);
    const placed = await order(p, { kind: 'tier', tierId: small.id });
    await credit(p, placed.transfer!.totalKobo);
    nuvion.mode = 'pending';
    const pass = await transfers.sweep();
    expect(pass.pending).toBe(1);
    const pending = (await statusOf(p, placed.id)) as PlanPurchaseView;
    expect(pending).toMatchObject({
      id: placed.id,
      method: 'transfer',
      status: 'pending',
      grant: null,
    });
    expect(await rows(p)).toHaveLength(0);
    nuvion.settle(pending.payment.reference, 'successful');
    nuvion.mode = 'successful';
    await until(async () => {
      await h.sweepLater();
      return (await rows(p)).length === 1;
    }, 'the purchase to be granted');
    await transfers.sweep(new Date(Date.now() + 10 * 60_000));
    expect((await statusOf(p, placed.id)).status).toBe('paid');
    expect(sendsFrom(p)).toHaveLength(1);
    expect(await rows(p)).toHaveLength(1);
  });

  it('after the window it is expired, the money stays in the wallet, and nothing is taken', async () => {
    const p = await person(0);
    const placed = await order(p, { kind: 'tier', tierId: small.id });
    const later = new Date(Date.now() + 25 * 3_600_000);
    // Other specs' waiting orders lapse with this one (see sweepWithDue).
    const { due, report, expiredAmongDue } = await sweepWithDue(
      h.prisma,
      transfers,
      later,
    );
    expect(due).toContain(placed.id);
    expect(await expiredAmongDue({ wawuUserId: p.id })).toBe(1);
    expect(report.expired).toBe(await expiredAmongDue());
    const gone = await statusOf(p, placed.id);
    expect(gone).toMatchObject({
      status: 'expired',
      statusMessage: EXPIRED_MESSAGE,
      transfer: null,
      payment: null,
    });
    // Money that arrives after the window is the person's, not a payment.
    await credit(p, placed.transfer!.totalKobo + 5_000);
    await transfers.sweep(later);
    await transfers.settleOrder(placed.id, later);
    expect(sendsFrom(p)).toHaveLength(0);
    expect(await rows(p)).toHaveLength(0);
    expect(balance(p)).toBe(placed.transfer!.totalKobo + 5_000);
    // A window that has passed reads expired even before the sweep marks it.
    const q = await order(p, { kind: 'tier', tierId: big.id });
    await h.prisma.planTransferOrder.update({
      where: { id: q.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    expect((await statusOf(p, q.id)).status).toBe('expired');
    expect(await transfers.settleOrder(q.id)).toBe('skipped');
    expect(sendsFrom(p)).toHaveLength(0);
  });

  it('the window is an admin setting', async () => {
    const p = await person(0);
    await settings.set(admin, {
      settings: { 'plan.transfer_window_hours': 2 },
    });
    try {
      const placed = await order(p, { kind: 'tier', tierId: small.id });
      const hours =
        (new Date(placed.transfer!.expiresAt).getTime() - Date.now()) /
        3_600_000;
      expect(hours).toBeGreaterThan(1.9);
      expect(hours).toBeLessThanOrEqual(2);
    } finally {
      await settings.set(admin, {
        settings: { 'plan.transfer_window_hours': null },
      });
    }
  });

  it('two waiting purchases are paid oldest first, each once, and only while the balance covers it', async () => {
    const p = await person(smallPrice + NUVION_FEE + 500);
    const first = await call.buy(
      p,
      request(
        { kind: 'tier', tierId: small.id },
        await quoted(p, { kind: 'tier', tierId: small.id }),
        'wallet',
      ),
    );
    expect(data<PlanPurchaseView>(first).status).toBe('paid');
    expect(balance(p)).toBe(500);
    const a = await order(p, { kind: 'renew', tierId: small.id });
    const b = await order(p, { kind: 'upgrade', tierId: big.id });
    const totalA = a.transfer!.totalKobo;
    const totalB = b.transfer!.totalKobo;

    // Enough for the older one only: it is paid, the younger one waits.
    await credit(p, totalA - 500);
    await transfers.sweep();
    expect((await statusOf(p, a.id)).status).toBe('paid');
    const waiting = (await statusOf(p, b.id)) as PlanTransferOrderView;
    expect(waiting.status).toBe('awaiting_transfer');
    expect(waiting.transfer!.amountNeededKobo).toBe(totalB);
    expect(sendsFrom(p)).toHaveLength(2);

    await credit(p, totalB);
    await transfers.sweep();
    expect((await statusOf(p, b.id)).status).toBe('paid');
    const sends = sendsFrom(p);
    expect(sends).toHaveLength(3);
    expect(sends[1].amountKobo).toBe(BigInt(smallPrice));
    expect(sends[2].amountKobo).toBe(BigInt(bigPrice - smallPrice));
    expect(await rows(p)).toHaveLength(3);
    expect(data<MyTierView>(await call.tier(p))).toMatchObject({
      tier: { id: big.id },
    });

    // One credit that covers both: older first, in one pass.
    const q = await person(smallPrice + NUVION_FEE);
    await call.buy(
      q,
      request(
        { kind: 'tier', tierId: small.id },
        await quoted(q, { kind: 'tier', tierId: small.id }),
        'wallet',
      ),
    );
    const c = await order(q, { kind: 'renew', tierId: small.id });
    const d = await order(q, { kind: 'upgrade', tierId: big.id });
    await credit(q, c.transfer!.totalKobo + d.transfer!.totalKobo);
    const pass = await transfers.sweep();
    expect(pass.paid).toBe(2);
    const sendsQ = sendsFrom(q);
    expect(sendsQ.map((s) => s.amountKobo)).toEqual([
      BigInt(smallPrice),
      BigInt(smallPrice),
      BigInt(bigPrice - smallPrice),
    ]);
    expect(balance(q)).toBe(0);
  });

  it('the quote binds: a price changed after the PIN closes the order with nothing taken', async () => {
    const p = await person(0);
    const placed = await order(p, { kind: 'tier', tierId: small.id });
    const key = `plan.tier.${small.id}.price_kobo`;
    await settings.set(admin, { settings: { [key]: smallPrice + 10_000 } });
    try {
      await credit(p, placed.transfer!.totalKobo + 20_000);
      expect((await transfers.sweep()).closed).toBe(1);
      const closed = await statusOf(p, placed.id);
      expect(closed.status).toBe('failed');
      expect(closed.statusMessage).toMatch(/price/);
      expect(sendsFrom(p)).toHaveLength(0);
      expect(await rows(p)).toHaveLength(0);
      expect(balance(p)).toBe(placed.transfer!.totalKobo + 20_000);
    } finally {
      await settings.set(admin, { settings: { [key]: null } });
    }
  });

  it('a quote that changed before the order is placed is 409 quote_changed and places nothing', async () => {
    const p = await person(0);
    const t: Terms = { kind: 'tier', tierId: small.id };
    const q = await quoted(p, t);
    const key = `plan.tier.${small.id}.price_kobo`;
    await settings.set(admin, { settings: { [key]: smallPrice + 10_000 } });
    try {
      const res = await call.buy(p, request(t, q, 'transfer'));
      expect(res.status).toBe(409);
      expect(reasonOf(res)).toMatchObject({ code: 'quote_changed' });
    } finally {
      await settings.set(admin, { settings: { [key]: null } });
    }
    expect(
      await h.prisma.planTransferOrder.count({ where: { wawuUserId: p.id } }),
    ).toBe(0);
  });

  it('paying the same item from the wallet meanwhile closes the waiting purchase, and a purchase the sweep finds already paid another way is closed too', async () => {
    const p = await person(0);
    const t: Terms = { kind: 'tier', tierId: small.id };
    const placed = await order(p, t);
    await credit(p, smallPrice + NUVION_FEE);
    const bought = await call.buy(p, request(t, await quoted(p, t), 'wallet'));
    expect(data<PlanPurchaseView>(bought).status).toBe('paid');
    const closed = await statusOf(p, placed.id);
    expect(closed).toMatchObject({
      status: 'failed',
      statusMessage: PAID_ANOTHER_WAY_MESSAGE,
    });
    await credit(p, 2 * (smallPrice + NUVION_FEE));
    await transfers.sweep();
    expect(sendsFrom(p)).toHaveLength(1);
    expect(await rows(p)).toHaveLength(1);

    // The same, when nothing closed the order at the time of the wallet purchase.
    const r = await person(0);
    const tr: Terms = { kind: 'tier', tierId: small.id };
    const waiting = await order(r, tr);
    await credit(r, smallPrice + NUVION_FEE);
    const skip = jest
      .spyOn(transfers, 'closeWaiting')
      .mockResolvedValue(undefined);
    try {
      const again = await call.buy(
        r,
        request(tr, await quoted(r, tr), 'wallet'),
      );
      expect(data<PlanPurchaseView>(again).status).toBe('paid');
    } finally {
      skip.mockRestore();
    }
    await credit(r, smallPrice + NUVION_FEE);
    await transfers.sweep();
    expect((await statusOf(r, waiting.id)).status).toBe('failed');
    expect(sendsFrom(r)).toHaveLength(1);
    expect(await rows(r)).toHaveLength(1);
  });

  it('asking again for the same item replaces the waiting purchase; the same key answers the first answer again', async () => {
    const p = await person(0);
    const t: Terms = { kind: 'tier', tierId: small.id };
    const q = await quoted(p, t);
    const key = randomUUID();
    const first = await call.buy(p, request(t, q, 'transfer'), { key });
    expect(first.status).toBe(201);
    const replay = await call.buy(p, request(t, q, 'transfer'), {
      key,
      pin: '0000',
    });
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual(first.body);

    const second = await call.buy(p, request(t, q, 'transfer'));
    const a = data<PlanTransferOrderView>(first);
    const b = data<PlanTransferOrderView>(second);
    expect(b.id).not.toBe(a.id);
    expect(await statusOf(p, a.id)).toMatchObject({
      status: 'failed',
      statusMessage: REPLACED_MESSAGE,
    });
    expect((await statusOf(p, b.id)).status).toBe('awaiting_transfer');
    expect(
      await h.prisma.planTransferOrder.count({
        where: { wawuUserId: p.id, status: 'awaiting' },
      }),
    ).toBe(1);
  });

  it('needs the PIN at checkout, and another person cannot read the purchase', async () => {
    const p = await person(0);
    const t: Terms = { kind: 'tier', tierId: small.id };
    const q = await quoted(p, t);
    const noPin = await call.buy(p, request(t, q, 'transfer'), { pin: null });
    expect(noPin.status).toBeGreaterThanOrEqual(400);
    const wrong = await call.buy(p, request(t, q, 'transfer'), { pin: '0000' });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    expect(
      await h.prisma.planTransferOrder.count({ where: { wawuUserId: p.id } }),
    ).toBe(0);
    const placed = await order(p, t);
    const other = await person(0);
    const res = await call.read(other, placed.id);
    expect(res.status).toBe(404);
    const stranger = await call.read(p, randomUUID());
    expect(stranger.status).toBe(404);
  });

  it('a purchase that cannot be made is refused before an order is written, and a person without a wallet gets wallet_not_open', async () => {
    const p = await person(0);
    const noTier = await call.buy(p, {
      kind: 'renew',
      tierId: small.id,
      method: 'transfer',
      expectedTotalKobo: smallPrice + NUVION_FEE,
      quoteToken: 'x'.repeat(40),
    });
    expect(noTier.status).toBe(409);
    expect(
      await h.prisma.planTransferOrder.count({ where: { wawuUserId: p.id } }),
    ).toBe(0);
    const w = await h.walletless();
    const none = await call.buy(w, {
      kind: 'tier',
      tierId: small.id,
      method: 'transfer',
      expectedTotalKobo: smallPrice,
      quoteToken: 'x'.repeat(40),
    });
    expect(none.status).toBe(409);
    expect(reasonOf(none)).toMatchObject({ code: 'wallet_not_open' });
  });

  it('holds nothing across the provider: twenty requests for one person while the provider takes 3 seconds do not slow another person down', async () => {
    const p = await person(0);
    const bystander = await person(0);
    const t: Terms = { kind: 'tier', tierId: small.id };
    const q = await quoted(p, t);
    const original = nuvion.getBalance.bind(nuvion);
    nuvion.getBalance = (w) => sleep(3_000).then(() => original(w));
    try {
      const all = Promise.all(
        Array.from({ length: 20 }, () =>
          call.buy(p, request(t, q, 'transfer')).then((r) => r),
        ),
      );
      await sleep(600);
      const started = Date.now();
      const other = await call.tier(bystander);
      expect(other.status).toBe(200);
      expect(Date.now() - started).toBeLessThan(1_000);
      const done = await all;
      expect(done.map((r) => r.status)).toEqual(Array(20).fill(201));
      expect(
        await h.prisma.planTransferOrder.count({
          where: { wawuUserId: p.id, status: 'awaiting' },
        }),
      ).toBe(1);
      // A settlement waiting on the provider holds no transaction either.
      await credit(p, smallPrice + NUVION_FEE);
      const current = await h.prisma.planTransferOrder.findFirstOrThrow({
        where: { wawuUserId: p.id, status: 'awaiting' },
      });
      const settling = Promise.all(
        Array.from({ length: 20 }, () => transfers.settleOrder(current.id)),
      );
      await sleep(600);
      const again = Date.now();
      expect((await call.tier(bystander)).status).toBe(200);
      expect(Date.now() - again).toBeLessThan(1_000);
      const results = await settling;
      expect(results.filter((r) => r === 'paid')).toHaveLength(1);
    } finally {
      nuvion.getBalance = original;
    }
    expect(sendsFrom(p)).toHaveLength(1);
  });

  it('a process that died after the payment was made does not pay twice: the next pass, or the recovery, links the payment it made', async () => {
    const p = await person(0);
    const placed = await order(p, { kind: 'tier', tierId: small.id });
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
    expect(sendsFrom(p)).toHaveLength(1);
    expect(await rows(p)).toHaveLength(1);
    // The next attempt finds the payment under the order's key and links it.
    expect(
      await transfers.settleOrder(placed.id, new Date(Date.now() + 600_000)),
    ).toBe('pending');
    const paid = (await statusOf(p, placed.id)) as PlanPurchaseView;
    expect(paid).toMatchObject({
      id: placed.id,
      method: 'transfer',
      status: 'paid',
    });
    expect(sendsFrom(p)).toHaveLength(1);

    // The same, when the process died holding the order for good.
    const q = await person(0);
    const second = await order(q, { kind: 'tier', tierId: small.id });
    await credit(q, second.transfer!.totalKobo);
    const lost = jest
      .spyOn(
        transfers as unknown as { link: (...a: unknown[]) => Promise<boolean> },
        'link',
      )
      .mockRejectedValueOnce(new Error('killed'));
    try {
      await transfers.settleOrder(second.id);
    } finally {
      lost.mockRestore();
    }
    await h.prisma.planTransferOrder.update({
      where: { id: second.id },
      data: {
        status: 'settling',
        settlingSince: new Date(Date.now() - 3_600_000),
      },
    });
    expect(await transfers.recoverStale(new Date())).toBe(1);
    expect(await statusOf(q, second.id)).toMatchObject({ status: 'paid' });
    expect(sendsFrom(q)).toHaveLength(1);
    expect(await rows(q)).toHaveLength(1);
  });

  it('a settlement that died holding the order is recovered: it waits again, or links the payment it made', async () => {
    const p = await person(0);
    const placed = await order(p, { kind: 'tier', tierId: small.id });
    await h.prisma.planTransferOrder.update({
      where: { id: placed.id },
      data: {
        status: 'settling',
        settlingSince: new Date(Date.now() - 60 * 60_000),
      },
    });
    expect(await transfers.recoverStale(new Date())).toBe(1);
    expect((await statusOf(p, placed.id)).status).toBe('awaiting_transfer');
    await credit(p, placed.transfer!.totalKobo);
    expect((await transfers.sweep()).paid).toBe(1);
    expect(sendsFrom(p)).toHaveLength(1);
  });
});
