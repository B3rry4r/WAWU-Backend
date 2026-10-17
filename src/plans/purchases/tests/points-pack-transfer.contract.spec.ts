import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import request from 'supertest';
import {
  api,
  bootTierApp,
  type Person,
  type TierHarness,
} from '../../../../test/plans/tier-purchase-harness';
import { NuvionSeamStandIn } from '../../../../test/payments/nuvion-seam-standin';
import { body } from '../../../../test/payments/poll-helpers';
import { AdminRole } from '../../../../generated/prisma/enums';
import type { AdminActor } from '../../../common/audit/admin-ops-audit.service';
import { PlanSettingsService } from '../../../plan-settings/plan-settings.service';
import type { MyPointsView } from '../../../points/points-view.type';
import {
  countIn,
  loadPlansConfig,
  percentOf,
  priceIn,
} from '../../plans-config';
import { PlanTransferService } from '../plan-transfer.service';
import {
  EXPIRED_MESSAGE,
  PAID_ANOTHER_WAY_MESSAGE,
} from '../plan-transfer-order';
import type {
  PointsPackPurchaseView,
  PointsPackQuoteView,
} from '../points-pack-view.type';

/**
 * POINTS-02 by bank transfer (TIER-05's orders): a pack bought by transfer
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
const pack = config.packs[0];
const packPrice = priceIn(pack.price, 'NGN');
const packPoints = countIn(pack.points, 'NGN');
const founding = config.tiers.find((t) => t.packBonusPct > 0)!;
const admin: AdminActor = {
  id: randomUUID(),
  email: 'points02t@admin.test.wawu.dev',
  role: AdminRole.finance,
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Buy a points pack by bank transfer (POINTS-02), Nuvion stood in', () => {
  const nuvion = new NuvionSeamStandIn();
  let h: TierHarness;
  let call: ReturnType<typeof api>;
  let transfers: PlanTransferService;
  let settings: PlanSettingsService;

  beforeAll(async () => {
    nuvion.feeKobo = () => BigInt(NUVION_FEE);
    h = await bootTierApp('p02t', { nuvion, nuvionFeeKobo: NUVION_FEE });
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

  const data = <T>(res: Response) => body<T>(res).data!;
  const set = (key: string, value: number | null) =>
    settings.set(admin, { settings: { [key]: value } });

  async function person(kobo: number): Promise<Person> {
    const p = await h.buyer(kobo);
    await h.prisma.fintavaWallet.update({
      where: { wawuUserId: p.id },
      data: { accountName: 'Ada Tester' },
    });
    return p;
  }
  async function quoted(p: Person): Promise<PointsPackQuoteView> {
    const res = await request(h.app.getHttpServer())
      .get(`/api/hub/plans/purchases/quote?kind=points_pack&packId=${pack.id}`)
      .set('Authorization', p.auth);
    expect(res.status).toBe(200);
    return data<PointsPackQuoteView>(res);
  }
  const requestFor = (
    q: PointsPackQuoteView,
    method: 'wallet' | 'transfer',
  ) => ({
    kind: 'points_pack',
    packId: q.packId,
    method,
    expectedTotalKobo: q.payment.totalKobo,
    quoteToken: q.payment.quoteToken,
  });
  /** Places a transfer order for the pack and returns what the person is told. */
  async function order(p: Person, over: object = {}) {
    const q = await quoted(p);
    const res = await call.buy(p, { ...requestFor(q, 'transfer'), ...over });
    expect(res.status).toBe(201);
    return data<PointsPackPurchaseView>(res);
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
  const lotsOf = (p: Person) =>
    h.prisma.pointLot.findMany({ where: { wawuUserId: p.id } });
  const statusOf = async (p: Person, id: string) =>
    data<PointsPackPurchaseView>(await call.read(p, id));
  async function hold(p: Person, tierId: string, activeUntil: Date) {
    await h.prisma.makerTier.create({
      data: {
        wawuUserId: p.id,
        tierId,
        activeFrom: new Date(Date.now() - 10 * DAY),
        activeUntil,
        productsIncluded: 3,
        pointsIncluded: 0,
        voiceIntroIncluded: false,
      },
    });
  }

  it('shows the person their own account number, the Bank charge and the amount still needed; when the money lands the pack completes once and adds the points once', async () => {
    const p = await person(1_000);
    const placed = await order(p);
    expect(placed).toMatchObject({
      kind: 'points_pack',
      packId: pack.id,
      method: 'transfer',
      status: 'awaiting_transfer',
      amountMinor: packPrice,
      points: packPoints,
      bonusPoints: 0,
      payment: null,
      grant: null,
      paidAt: null,
      transfer: {
        accountNumber: p.accountNumber,
        accountName: 'Ada Tester',
        priceKobo: packPrice,
        bankChargeKobo: NUVION_FEE,
        totalKobo: packPrice + NUVION_FEE,
        balanceKobo: 1_000,
        amountNeededKobo: packPrice + NUVION_FEE - 1_000,
      },
    });
    // Nothing is taken or added before the money lands.
    await transfers.sweep();
    expect(sendsFrom(p)).toHaveLength(0);
    expect(await lotsOf(p)).toHaveLength(0);
    expect(await statusOf(p, placed.id)).toMatchObject({
      id: placed.id,
      status: 'awaiting_transfer',
      transfer: { amountNeededKobo: packPrice + NUVION_FEE - 1_000 },
    });

    await credit(p, placed.transfer!.amountNeededKobo!);
    expect((await transfers.sweep()).paid).toBe(1);

    const paid = await statusOf(p, placed.id);
    expect(paid).toMatchObject({
      id: placed.id,
      kind: 'points_pack',
      method: 'transfer',
      status: 'paid',
      amountMinor: packPrice,
      payment: { kind: 'points_pack', status: 'completed', delivered: true },
      grant: { points: packPoints, bonusPoints: 0, totalPoints: packPoints },
    });
    expect(sendsFrom(p)).toHaveLength(1);
    expect(sendsFrom(p)[0]).toMatchObject({
      amountKobo: BigInt(packPrice),
      feeKobo: BigInt(NUVION_FEE),
      toAccountId: nuvion.operational.accountId,
    });
    expect(balance(p)).toBe(0);
    const lots = await lotsOf(p);
    expect(lots).toHaveLength(1);
    expect(lots[0]).toMatchObject({
      source: 'pack',
      sourceRef: paid.payment!.id,
      quantity: packPoints,
    });
    expect(data<MyPointsView>(await call.points(p)).balance).toBe(packPoints);
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
    expect(await lotsOf(p)).toHaveLength(1);
  });

  it('two passes at once pay a funded order once and add one lot', async () => {
    const p = await person(0);
    const placed = await order(p);
    await credit(p, placed.transfer!.totalKobo);
    await Promise.all([transfers.sweep(), transfers.sweep()]);
    expect(sendsFrom(p)).toHaveLength(1);
    expect(await lotsOf(p)).toHaveLength(1);
    expect((await statusOf(p, placed.id)).status).toBe('paid');
  });

  it('a Founding Maker is bought the bonus by transfer too, as quoted when the PIN was given', async () => {
    await set(`plan.pack.${pack.id}.points`, 1005);
    try {
      const p = await person(0);
      await hold(p, founding.id, new Date(Date.now() + 100 * DAY));
      const bonus = percentOf(1005, founding.packBonusPct);
      const placed = await order(p);
      expect(placed).toMatchObject({
        status: 'awaiting_transfer',
        points: 1005,
        bonusPoints: bonus,
      });
      await credit(p, placed.transfer!.totalKobo);
      expect((await transfers.sweep()).paid).toBe(1);
      const paid = await statusOf(p, placed.id);
      expect(paid.grant).toMatchObject({
        points: 1005,
        bonusPoints: bonus,
        totalPoints: 1005 + bonus,
      });
      expect((await lotsOf(p))[0].quantity).toBe(1005 + bonus);
    } finally {
      await set(`plan.pack.${pack.id}.points`, null);
    }
  });

  it('the quote binds price and goods: a price, the points or the bonus changed while it waits closes the order with nothing taken', async () => {
    const closedBy = async (
      change: () => Promise<unknown>,
      undo: () => Promise<unknown>,
    ) => {
      const p = await person(0);
      const placed = await order(p);
      await change();
      try {
        await credit(p, placed.transfer!.totalKobo + 20_000);
        expect((await transfers.sweep()).closed).toBe(1);
        const closed = await statusOf(p, placed.id);
        expect(closed.status).toBe('failed');
        expect(closed.statusMessage).not.toBeNull();
        expect(sendsFrom(p)).toHaveLength(0);
        expect(await lotsOf(p)).toHaveLength(0);
        expect(balance(p)).toBe(placed.transfer!.totalKobo + 20_000);
      } finally {
        await undo();
      }
    };
    await closedBy(
      () => set(`plan.pack.${pack.id}.price_kobo`, packPrice + 10_000),
      () => set(`plan.pack.${pack.id}.price_kobo`, null),
    );
    await closedBy(
      () => set(`plan.pack.${pack.id}.points`, packPoints + 500),
      () => set(`plan.pack.${pack.id}.points`, null),
    );

    // A Founding Maker whose tier ended before the money landed: the bonus the order promised is gone.
    const p = await person(0);
    await hold(p, founding.id, new Date(Date.now() + 100 * DAY));
    const placed = await order(p);
    expect(placed.bonusPoints).toBe(
      percentOf(packPoints, founding.packBonusPct),
    );
    await h.prisma.makerTier.update({
      where: { wawuUserId: p.id },
      data: { activeUntil: new Date(Date.now() - DAY) },
    });
    await credit(p, placed.transfer!.totalKobo);
    expect((await transfers.sweep()).closed).toBe(1);
    expect((await statusOf(p, placed.id)).status).toBe('failed');
    expect(sendsFrom(p)).toHaveLength(0);
    expect(await lotsOf(p)).toHaveLength(0);
  });

  it('a quote that changed before the order is placed is 409 quote_changed and places nothing', async () => {
    const p = await person(0);
    const q = await quoted(p);
    await set(`plan.pack.${pack.id}.points`, packPoints + 500);
    try {
      const res = await call.buy(p, requestFor(q, 'transfer'));
      expect(res.status).toBe(409);
      expect(
        (body<unknown>(res).reason as unknown as { code: string }).code,
      ).toBe('quote_changed');
    } finally {
      await set(`plan.pack.${pack.id}.points`, null);
    }
    expect(
      await h.prisma.planTransferOrder.count({ where: { wawuUserId: p.id } }),
    ).toBe(0);
  });

  it('after the window it is expired, the money stays in the wallet, and nothing is taken', async () => {
    const p = await person(0);
    const placed = await order(p);
    const later = new Date(Date.now() + 25 * 3_600_000);
    expect((await transfers.sweep(later)).expired).toBe(1);
    expect(await statusOf(p, placed.id)).toMatchObject({
      status: 'expired',
      statusMessage: EXPIRED_MESSAGE,
      transfer: null,
      payment: null,
    });
    await credit(p, placed.transfer!.totalKobo + 5_000);
    await transfers.sweep(later);
    expect(sendsFrom(p)).toHaveLength(0);
    expect(await lotsOf(p)).toHaveLength(0);
  });

  it('buying the same pack from the wallet meanwhile closes the waiting order; a pack order and a plan order wait side by side', async () => {
    const p = await person(0);
    const placed = await order(p);
    await credit(p, packPrice + NUVION_FEE);
    const bought = await call.buy(p, requestFor(await quoted(p), 'wallet'));
    expect(data<PointsPackPurchaseView>(bought).status).toBe('paid');
    expect(await statusOf(p, placed.id)).toMatchObject({
      status: 'failed',
      statusMessage: PAID_ANOTHER_WAY_MESSAGE,
    });
    await credit(p, 2 * (packPrice + NUVION_FEE));
    await transfers.sweep();
    expect(sendsFrom(p)).toHaveLength(1);
    expect(await lotsOf(p)).toHaveLength(1);

    // Another person: a tier order and a pack order are separate items.
    const q = await person(0);
    const tierRes = await call.quote(q, { kind: 'tier', tierId: founding.id });
    const tq = data<{ payment: { totalKobo: number; quoteToken: string } }>(
      tierRes,
    );
    const tierOrder = await call.buy(q, {
      kind: 'tier',
      tierId: founding.id,
      method: 'transfer',
      expectedTotalKobo: tq.payment.totalKobo,
      quoteToken: tq.payment.quoteToken,
    });
    expect(tierOrder.status).toBe(201);
    const packOrder = await order(q);
    expect(packOrder.status).toBe('awaiting_transfer');
    expect(
      await h.prisma.planTransferOrder.count({
        where: { wawuUserId: q.id, status: 'awaiting' },
      }),
    ).toBe(2);
  });
});
