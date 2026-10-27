import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import request from 'supertest';
import {
  api,
  bootTierApp,
  type Person,
  type TierHarness,
} from '../../../../test/plans/tier-purchase-harness';
import { sweepWithDue } from '../../../../test/plans/lapsed-orders';
import { NuvionSeamStandIn } from '../../../../test/payments/nuvion-seam-standin';
import { body } from '../../../../test/payments/poll-helpers';
import { AdminRole } from '../../../../generated/prisma/enums';
import type { AdminActor } from '../../../common/audit/admin-ops-audit.service';
import { PlanSettingsService } from '../../../plan-settings/plan-settings.service';
import {
  openPackRule,
  resetPackRule,
} from '../../../../test/plans/open-pack-rule';
import { loadPlansConfig, priceIn } from '../../plans-config';
import { PublishingAllowanceService } from '../../publishing-allowance.service';
import { PACK_TIER_MESSAGE } from '../extra-products-cap';
import { TIER_ENDED_MESSAGE } from '../extra-products-rules';
import type {
  ExtraProductsPurchaseView,
  ExtraProductsQuoteView,
} from '../extra-products-view.type';
import { PlanTransferService } from '../plan-transfer.service';
import {
  EXPIRED_MESSAGE,
  PAID_ANOTHER_WAY_MESSAGE,
} from '../plan-transfer-order';

/**
 * TIER-04 by bank transfer (TIER-05's orders): the add-on bought by transfer
 * waits for the money to reach the person's own wallet account and is paid
 * from the wallet, once, when it lands. On the wallet provider seam with
 * NUVION stood in (the money-in rows are the ledger rows NUV-04's handler
 * writes). No Nuvion, Fintava, Flutterwave or wawuafrica.com host is called.
 * NUVION_FEE is a spec value, not a fact about Nuvion.
 */

jest.setTimeout(180_000);

const NUVION_FEE = 2325;
const DAY = 86_400_000;
const config = loadPlansConfig();
const addOn = config.extraProducts;
const addOnPrice = priceIn(addOn.price, 'NGN');
const tier = config.tiers[0];
const admin: AdminActor = {
  id: randomUUID(),
  email: 'tier04t@admin.test.wawu.dev',
  role: AdminRole.finance,
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Add more products by bank transfer (TIER-04), Nuvion stood in', () => {
  const nuvion = new NuvionSeamStandIn();
  let h: TierHarness;
  let call: ReturnType<typeof api>;
  let transfers: PlanTransferService;
  let settings: PlanSettingsService;
  let allowance: PublishingAllowanceService;

  beforeAll(async () => {
    nuvion.feeKobo = () => BigInt(NUVION_FEE);
    h = await bootTierApp('t04t', { nuvion, nuvionFeeKobo: NUVION_FEE });
    call = api(h);
    transfers = h.get(PlanTransferService);
    settings = h.get(PlanSettingsService);
    allowance = h.get(PublishingAllowanceService);
    // PACK-CAP (R-100): these cases test the order on the first tier with many
    // packs; the pack rule has its own spec (extra-products-cap).
    await openPackRule(
      settings,
      config.tiers.map((t) => t.id),
    );
  });
  afterAll(async () => {
    await resetPackRule(settings);
    await h.prisma.makerExtraProducts.deleteMany({
      where: { wawuUserId: { in: h.users } },
    });
    await h.close();
  });
  beforeEach(() => {
    nuvion.mode = 'successful';
  });

  const data = <T>(res: Response) => body<T>(res).data!;
  const reasonOf = (res: Response) =>
    body<unknown>(res).reason as unknown as { code: string; message: string };
  const set = (key: string, value: number | string[] | null) =>
    settings.set(admin, { settings: { [key]: value } });

  async function person(kobo: number): Promise<Person> {
    const p = await h.buyer(kobo);
    await h.prisma.fintavaWallet.update({
      where: { wawuUserId: p.id },
      data: { accountName: 'Ada Tester' },
    });
    return p;
  }
  async function hold(p: Person, activeUntil: Date) {
    await h.prisma.makerTier.create({
      data: {
        wawuUserId: p.id,
        tierId: tier.id,
        activeFrom: new Date(Date.now() - 10 * DAY),
        activeUntil,
        productsIncluded: 3,
        pointsIncluded: 0,
        voiceIntroIncluded: false,
      },
    });
  }
  const running = (p: Person) => hold(p, new Date(Date.now() + 100 * DAY));
  const quoteRoute = (p: Person) =>
    request(h.app.getHttpServer())
      .get('/api/hub/plans/purchases/quote?kind=extra_products')
      .set('Authorization', p.auth);
  async function quoted(p: Person): Promise<ExtraProductsQuoteView> {
    const res = await quoteRoute(p);
    expect(res.status).toBe(200);
    return data<ExtraProductsQuoteView>(res);
  }
  const requestFor = (
    q: ExtraProductsQuoteView,
    method: 'wallet' | 'transfer',
  ) => ({
    kind: 'extra_products',
    method,
    expectedTotalKobo: q.payment.totalKobo,
    quoteToken: q.payment.quoteToken,
  });
  /** Places a transfer order for the add-on and returns what the person is told. */
  async function order(p: Person) {
    const q = await quoted(p);
    const res = await call.buy(p, requestFor(q, 'transfer'));
    expect(res.status).toBe(201);
    return data<ExtraProductsPurchaseView>(res);
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
  const extrasOf = async (p: Person) =>
    (
      await h.prisma.makerTier.findUniqueOrThrow({
        where: { wawuUserId: p.id },
      })
    ).extraProducts;
  const rowsOf = (p: Person) =>
    h.prisma.makerExtraProducts.count({ where: { wawuUserId: p.id } });
  const statusOf = async (p: Person, id: string) =>
    data<ExtraProductsPurchaseView>(await call.read(p, id));

  it('shows the person their own account number, the Bank charge and the amount still needed; when the money lands the add-on completes once and adds the products once', async () => {
    const p = await person(1_000);
    await running(p);
    const placed = await order(p);
    expect(placed).toMatchObject({
      kind: 'extra_products',
      method: 'transfer',
      status: 'awaiting_transfer',
      amountMinor: addOnPrice,
      products: addOn.count,
      payment: null,
      grant: null,
      paidAt: null,
      transfer: {
        accountNumber: p.accountNumber,
        accountName: 'Ada Tester',
        priceKobo: addOnPrice,
        bankChargeKobo: NUVION_FEE,
        totalKobo: addOnPrice + NUVION_FEE,
        balanceKobo: 1_000,
        amountNeededKobo: addOnPrice + NUVION_FEE - 1_000,
      },
    });
    // Nothing is taken or added before the money lands.
    await transfers.sweep();
    expect(sendsFrom(p)).toHaveLength(0);
    expect(await extrasOf(p)).toBe(0);
    expect(await statusOf(p, placed.id)).toMatchObject({
      id: placed.id,
      status: 'awaiting_transfer',
      transfer: { amountNeededKobo: addOnPrice + NUVION_FEE - 1_000 },
    });

    await credit(p, placed.transfer!.amountNeededKobo!);
    expect((await transfers.sweep()).paid).toBe(1);

    const paid = await statusOf(p, placed.id);
    expect(paid).toMatchObject({
      id: placed.id,
      kind: 'extra_products',
      method: 'transfer',
      status: 'paid',
      amountMinor: addOnPrice,
      payment: { kind: 'extra_products', status: 'completed', delivered: true },
      grant: {
        productsAdded: addOn.count,
        extraProducts: addOn.count,
        productsAllowed: 3 + addOn.count,
      },
    });
    expect(sendsFrom(p)).toHaveLength(1);
    expect(sendsFrom(p)[0]).toMatchObject({
      amountKobo: BigInt(addOnPrice),
      feeKobo: BigInt(NUVION_FEE),
      toAccountId: nuvion.operational.accountId,
    });
    expect(balance(p)).toBe(0);
    expect(await extrasOf(p)).toBe(addOn.count);
    expect(await rowsOf(p)).toBe(1);
    expect((await allowance.of(p.id)).productsAllowed).toBe(3 + addOn.count);
    // The payment's own id reads the same purchase under the order's id.
    expect(await statusOf(p, paid.payment!.id)).toMatchObject({
      id: placed.id,
      method: 'transfer',
      status: 'paid',
    });
    // More passes, and more money, add nothing more.
    await transfers.sweep();
    await transfers.sweep();
    expect(sendsFrom(p)).toHaveLength(1);
    expect(await extrasOf(p)).toBe(addOn.count);
  });

  it('two passes at once pay a funded order once and add the products once', async () => {
    const p = await person(0);
    await running(p);
    const placed = await order(p);
    await credit(p, placed.transfer!.totalKobo);
    await Promise.all([transfers.sweep(), transfers.sweep()]);
    expect(sendsFrom(p)).toHaveLength(1);
    expect(await extrasOf(p)).toBe(addOn.count);
    expect(await rowsOf(p)).toBe(1);
    expect((await statusOf(p, placed.id)).status).toBe('paid');
  });

  it('with no tier an order is not placed: 402 tier_required, no order, nothing taken', async () => {
    const p = await person(0);
    const res = await call.buy(p, {
      kind: 'extra_products',
      method: 'transfer',
      expectedTotalKobo: 100_000,
      quoteToken: 'x',
    });
    expect(res.status).toBe(402);
    expect(reasonOf(res).code).toBe('tier_required');
    expect(
      await h.prisma.planTransferOrder.count({ where: { wawuUserId: p.id } }),
    ).toBe(0);
  });

  it('a tier that ends while the order waits closes it with nothing taken, and the money stays in the wallet', async () => {
    const p = await person(0);
    await running(p);
    const placed = await order(p);
    await h.prisma.makerTier.update({
      where: { wawuUserId: p.id },
      data: { activeUntil: new Date(Date.now() - DAY) },
    });
    await credit(p, placed.transfer!.totalKobo + 20_000);
    expect((await transfers.sweep()).closed).toBe(1);
    expect(await statusOf(p, placed.id)).toMatchObject({
      status: 'failed',
      statusMessage: TIER_ENDED_MESSAGE,
      payment: null,
      grant: null,
    });
    expect(sendsFrom(p)).toHaveLength(0);
    expect(await extrasOf(p)).toBe(0);
    expect(balance(p)).toBe(placed.transfer!.totalKobo + 20_000);
    // The order is not tried again, however often the sweep runs.
    await transfers.sweep();
    expect(sendsFrom(p)).toHaveLength(0);
  });

  it('PACK-CAP: a waiting order closes failed with nothing sent when the rule stops allowing the pack, extras unchanged', async () => {
    const p = await person(0);
    await running(p);
    const placed = await order(p);
    // The settings stop naming this person's tier while the order waits.
    await set('plan.extra_products.tiers', ['founding']);
    try {
      await credit(p, placed.transfer!.totalKobo + 20_000);
      expect((await transfers.sweep()).closed).toBe(1);
      expect(await statusOf(p, placed.id)).toMatchObject({
        status: 'failed',
        statusMessage: PACK_TIER_MESSAGE,
        payment: null,
        grant: null,
      });
      expect(sendsFrom(p)).toHaveLength(0);
      expect(await extrasOf(p)).toBe(0);
      expect(await rowsOf(p)).toBe(0);
      expect(balance(p)).toBe(placed.transfer!.totalKobo + 20_000);
    } finally {
      await openPackRule(
        settings,
        config.tiers.map((t) => t.id),
      );
    }
  });

  it('the quote binds price and count: either changed while it waits closes the order with nothing taken', async () => {
    const closedBy = async (
      change: () => Promise<unknown>,
      undo: () => Promise<unknown>,
    ) => {
      const p = await person(0);
      await running(p);
      const placed = await order(p);
      await change();
      try {
        await credit(p, placed.transfer!.totalKobo + 20_000);
        expect((await transfers.sweep()).closed).toBe(1);
        const closed = await statusOf(p, placed.id);
        expect(closed.status).toBe('failed');
        expect(closed.statusMessage).not.toBeNull();
        expect(sendsFrom(p)).toHaveLength(0);
        expect(await extrasOf(p)).toBe(0);
        expect(balance(p)).toBe(placed.transfer!.totalKobo + 20_000);
      } finally {
        await undo();
      }
    };
    await closedBy(
      () => set('plan.extra_products.price_kobo', addOnPrice + 10_000),
      () => set('plan.extra_products.price_kobo', null),
    );
    await closedBy(
      () => set('plan.extra_products.count', addOn.count + 2),
      () => set('plan.extra_products.count', null),
    );
  });

  it('a quote that changed before the order is placed is 409 quote_changed and places nothing', async () => {
    const p = await person(0);
    await running(p);
    const q = await quoted(p);
    await set('plan.extra_products.count', addOn.count + 2);
    try {
      const res = await call.buy(p, requestFor(q, 'transfer'));
      expect(res.status).toBe(409);
      expect(reasonOf(res).code).toBe('quote_changed');
    } finally {
      await set('plan.extra_products.count', null);
    }
    expect(
      await h.prisma.planTransferOrder.count({ where: { wawuUserId: p.id } }),
    ).toBe(0);
  });

  it('after the window it is expired, the money stays in the wallet, and nothing is taken', async () => {
    const p = await person(0);
    await running(p);
    const placed = await order(p);
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
    expect(await statusOf(p, placed.id)).toMatchObject({
      status: 'expired',
      statusMessage: EXPIRED_MESSAGE,
      transfer: null,
      payment: null,
    });
    await credit(p, placed.transfer!.totalKobo + 5_000);
    await transfers.sweep(later);
    expect(sendsFrom(p)).toHaveLength(0);
    expect(await extrasOf(p)).toBe(0);
  });

  it('buying the add-on from the wallet meanwhile closes the waiting order; an add-on order and a plan order wait side by side', async () => {
    const p = await person(0);
    await running(p);
    const placed = await order(p);
    await credit(p, addOnPrice + NUVION_FEE);
    const bought = await call.buy(p, requestFor(await quoted(p), 'wallet'));
    expect(data<ExtraProductsPurchaseView>(bought).status).toBe('paid');
    expect(await statusOf(p, placed.id)).toMatchObject({
      status: 'failed',
      statusMessage: PAID_ANOTHER_WAY_MESSAGE,
    });
    await credit(p, 2 * (addOnPrice + NUVION_FEE));
    await transfers.sweep();
    expect(sendsFrom(p)).toHaveLength(1);
    expect(await extrasOf(p)).toBe(addOn.count);

    // Another person: a renewal order and an add-on order are separate items.
    const q = await person(0);
    await running(q);
    const tierRes = await call.quote(q, { kind: 'renew', tierId: tier.id });
    const tq = data<{ payment: { totalKobo: number; quoteToken: string } }>(
      tierRes,
    );
    const tierOrder = await call.buy(q, {
      kind: 'renew',
      tierId: tier.id,
      method: 'transfer',
      expectedTotalKobo: tq.payment.totalKobo,
      quoteToken: tq.payment.quoteToken,
    });
    expect(tierOrder.status).toBe(201);
    const extraOrder = await order(q);
    expect(extraOrder.status).toBe('awaiting_transfer');
    expect(
      await h.prisma.planTransferOrder.count({
        where: { wawuUserId: q.id, status: 'awaiting' },
      }),
    ).toBe(2);
  });
});
