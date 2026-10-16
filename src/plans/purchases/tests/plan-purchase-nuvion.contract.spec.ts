import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import {
  api,
  bootTierApp,
  type Person,
  type TierHarness,
} from '../../../../test/plans/tier-purchase-harness';
import { NuvionSeamStandIn } from '../../../../test/payments/nuvion-seam-standin';
import { body, until } from '../../../../test/payments/poll-helpers';
import { loadPlansConfig, priceIn } from '../../plans-config';
import type { MyTierView } from '../../plans-view.type';
import type { MyPointsView } from '../../../points/points-view.type';
import type {
  PlanPurchaseQuoteView,
  PlanPurchaseView,
} from '../plan-purchase-view.type';

/**
 * TIER-03 on the wallet provider seam with NUVION stood in: the same purchase,
 * paid as a book transfer into WAWU's operational account, with Nuvion's
 * documented first answer (`pending`, settled later). Nothing here names a
 * provider: the purchase module reaches the wallet only through MONEY-17.
 * No Nuvion, Fintava or wawuafrica.com host is called, and the Fintava stand-in
 * proves nothing reached it. NUVION_FEE is a spec value, not a fact about
 * Nuvion; the owner fills the real settings (NUV-10).
 */

jest.setTimeout(120_000);

const NUVION_FEE = 2325;
const config = loadPlansConfig();
const byPrice = [...config.tiers].sort((a, b) => a.price.kobo - b.price.kobo);
const small = byPrice[0];
const big = byPrice[byPrice.length - 1];
const RICH = 100 * priceIn(big.price, 'NGN');

describe('Buy, renew or upgrade a tier from the wallet (TIER-03), Nuvion stood in', () => {
  const nuvion = new NuvionSeamStandIn();
  let h: TierHarness;
  let call: ReturnType<typeof api>;

  beforeAll(async () => {
    nuvion.feeKobo = () => BigInt(NUVION_FEE);
    h = await bootTierApp('t03n', { nuvion, nuvionFeeKobo: NUVION_FEE });
    call = api(h);
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

  async function quoted(p: Person, t: Terms): Promise<PlanPurchaseQuoteView> {
    const res = await call.quote(p, t);
    expect(res.status).toBe(200);
    return data<PlanPurchaseQuoteView>(res);
  }
  const request = (t: Terms, q: PlanPurchaseQuoteView) => ({
    ...t,
    method: 'wallet',
    expectedTotalKobo: q.payment.totalKobo,
    quoteToken: q.payment.quoteToken,
  });
  const sendsFrom = (p: Person) => nuvion.sendsFrom(p.account!.accountId);
  const rows = (p: Person) =>
    h.prisma.makerPurchase.findMany({ where: { wawuUserId: p.id } });
  const tierOf = async (p: Person) => data<MyTierView>(await call.tier(p));
  const pointsOf = async (p: Person) =>
    data<MyPointsView>(await call.points(p));

  it('buys a tier as one book transfer of the config price into the operational account, and grants it', async () => {
    const p = await h.buyer(RICH);
    const price = priceIn(big.price, 'NGN');
    const t: Terms = { kind: 'tier', tierId: big.id };
    const q = await quoted(p, t);
    expect(q.payment).toMatchObject({
      priceKobo: price,
      totalKobo: price + NUVION_FEE,
      fee: { providerFeeKobo: NUVION_FEE, wawuFeeKobo: 0 },
    });
    const res = await call.buy(p, request(t, q));
    expect(res.status).toBe(201);
    expect(data<PlanPurchaseView>(res)).toMatchObject({
      status: 'paid',
      amountMinor: price,
      payment: { kind: 'tier', status: 'completed', delivered: true },
    });
    expect(sendsFrom(p)).toHaveLength(1);
    expect(sendsFrom(p)[0]).toMatchObject({
      amountKobo: BigInt(price),
      feeKobo: BigInt(NUVION_FEE),
      toAccountId: nuvion.operational.accountId,
    });
    expect(p.account!.availableKobo).toBe(BigInt(RICH - price - NUVION_FEE));
    expect(await tierOf(p)).toMatchObject({
      state: 'active',
      tier: { id: big.id },
    });
    expect((await pointsOf(p)).balance).toBe(big.bonusPoints);
    expect(await rows(p)).toHaveLength(1);
  });

  it('the same request twice debits once; a payment Nuvion first calls pending grants nothing until it is successful, then once', async () => {
    const p = await h.buyer(RICH);
    const t: Terms = { kind: 'tier', tierId: small.id, bump: true };
    const q = await quoted(p, t);
    nuvion.mode = 'pending';
    const key = randomUUID();
    const first = await call.buy(p, request(t, q), { key });
    expect(first.status).toBe(201);
    const pending = data<PlanPurchaseView>(first);
    expect(pending).toMatchObject({ status: 'pending', grant: null });
    expect(await rows(p)).toHaveLength(0);
    expect((await tierOf(p)).state).toBe('none');

    const second = await call.buy(p, request(t, q), { key, pin: '0000' });
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body).toEqual(first.body);
    expect(sendsFrom(p)).toHaveLength(1);

    nuvion.settle(pending.payment.reference, 'successful');
    await until(async () => {
      await h.sweepLater();
      return (await rows(p)).length === 1;
    }, 'the purchase to be granted');
    await h.sweepLater();
    const paid = data<PlanPurchaseView>(await call.read(p, pending.id));
    expect(paid).toMatchObject({
      status: 'paid',
      payment: { delivered: true },
    });
    expect(paid.grant).toMatchObject({ bonusPoints: small.bonusPoints });
    expect(await rows(p)).toHaveLength(1);
    expect((await pointsOf(p)).lots).toHaveLength(2);
    expect(sendsFrom(p)).toHaveLength(1);
  });

  it('a payment Nuvion later fails or reverses is failed or reversed, with nothing granted', async () => {
    for (const word of ['failed', 'reversed'] as const) {
      const p = await h.buyer(RICH);
      const t: Terms = { kind: 'tier', tierId: small.id };
      const q = await quoted(p, t);
      nuvion.mode = 'pending';
      const res = await call.buy(p, request(t, q));
      const pending = data<PlanPurchaseView>(res);
      expect(pending.status).toBe('pending');
      nuvion.settle(pending.payment.reference, word);
      await until(async () => {
        await h.sweepLater();
        return (
          data<PlanPurchaseView>(await call.read(p, pending.id)).status === word
        );
      }, `the purchase to read ${word}`);
      const view = data<PlanPurchaseView>(await call.read(p, pending.id));
      expect(view).toMatchObject({ status: word, grant: null, paidAt: null });
      expect(view.payment).toMatchObject({ delivered: false });
      expect(await rows(p)).toHaveLength(0);
      expect((await tierOf(p)).state).toBe('none');
      expect((await pointsOf(p)).balance).toBe(0);
    }
  });

  it('an upgrade whose tier ended while Nuvion was settling it is paid back from the operational account, once (round 2, D1)', async () => {
    const p = await h.buyer(RICH);
    const first = await call.buy(
      p,
      request(
        { kind: 'tier', tierId: small.id },
        await quoted(p, { kind: 'tier', tierId: small.id }),
      ),
    );
    expect(data<PlanPurchaseView>(first).status).toBe('paid');
    const t: Terms = { kind: 'upgrade', tierId: big.id };
    const q = await quoted(p, t);
    const diff = priceIn(big.price, 'NGN') - priceIn(small.price, 'NGN');
    nuvion.mode = 'pending';
    const res = await call.buy(p, request(t, q));
    const pending = data<PlanPurchaseView>(res);
    expect(pending.status).toBe('pending');
    // The tier the upgrade came from ends while Nuvion is still settling it.
    await h.prisma.makerTier.update({
      where: { wawuUserId: p.id },
      data: {
        activeFrom: new Date(Date.now() - 20 * 86_400_000),
        activeUntil: new Date(Date.now() - 1000),
      },
    });
    nuvion.settle(pending.payment.reference, 'successful');
    nuvion.mode = 'successful';
    await until(async () => {
      await h.sweepLater();
      return (
        data<PlanPurchaseView>(await call.read(p, pending.id)).status ===
        'refunded'
      );
    }, 'the purchase to read refunded');
    const view = data<PlanPurchaseView>(await call.read(p, pending.id));
    expect(view).toMatchObject({ status: 'refunded', grant: null });
    expect(view.payment).toMatchObject({ delivered: true });
    // The difference went back from WAWU's account to the payer, once.
    const back = nuvion
      .sendsFrom(nuvion.operational.accountId)
      .filter((x) => x.toAccountId === p.account!.accountId);
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ amountKobo: BigInt(diff) });
    await h.sweepLater(70 * 60_000);
    expect(
      nuvion
        .sendsFrom(nuvion.operational.accountId)
        .filter((x) => x.toAccountId === p.account!.accountId),
    ).toHaveLength(1);
    expect(await rows(p)).toHaveLength(1);
    expect((await tierOf(p)).state).toBe('ended');
  });

  it('an upgrade debits only the difference and a person short of money gets the exact shortfall', async () => {
    const p = await h.buyer(RICH);
    const first = await call.buy(
      p,
      request(
        { kind: 'tier', tierId: small.id },
        await quoted(p, { kind: 'tier', tierId: small.id }),
      ),
    );
    expect(data<PlanPurchaseView>(first).status).toBe('paid');
    const t: Terms = { kind: 'upgrade', tierId: big.id };
    const q = await quoted(p, t);
    const diff = priceIn(big.price, 'NGN') - priceIn(small.price, 'NGN');
    expect(q.planMinor).toBe(diff);
    const res = await call.buy(p, request(t, q));
    expect(data<PlanPurchaseView>(res)).toMatchObject({
      status: 'paid',
      amountMinor: diff,
    });
    expect(sendsFrom(p)[1]).toMatchObject({ amountKobo: BigInt(diff) });
    expect((await pointsOf(p)).balance).toBe(big.bonusPoints);

    const poor = await h.buyer(1_000);
    const tq = await quoted(poor, { kind: 'tier', tierId: small.id });
    const refused = await call.buy(
      poor,
      request({ kind: 'tier', tierId: small.id }, tq),
    );
    expect(refused.status).toBe(402);
    expect(reasonOf(refused)).toMatchObject({
      code: 'insufficient_funds',
      balanceKobo: 1_000,
      totalKobo: priceIn(small.price, 'NGN') + NUVION_FEE,
      shortfallKobo: priceIn(small.price, 'NGN') + NUVION_FEE - 1_000,
    });
    expect(sendsFrom(poor)).toHaveLength(0);
    expect(await rows(poor)).toHaveLength(0);
    // Nothing reached the Fintava stand-in.
    expect(h.double.seen).toHaveLength(0);
  });
});
