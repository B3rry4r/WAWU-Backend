import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import {
  api,
  bootTierApp,
  type Person,
  type TierHarness,
} from '../../../../test/plans/tier-purchase-harness';
import { body } from '../../../../test/payments/poll-helpers';
import type { CompletedPayment } from '../../../money/payments/payable-registry';
import { FINISHING_MESSAGE } from '../../../money/payments/wallet-payment.service';
import { loadPlansConfig, priceIn } from '../../plans-config';
import { TierGrantService } from '../../tier-grant.service';
import type {
  PlanPurchaseQuoteView,
  PlanPurchaseView,
} from '../plan-purchase-view.type';

/**
 * TIER-03: what happens at the moment a confirmed payment is delivered, and
 * after: a purchase that no longer fits what the person holds is not granted
 * (and writes nothing), two payments for one person at once cannot both grant,
 * a request that died mid-payment is answered with the purchase and not the
 * bare payment, and a paid-but-undelivered purchase keeps its claim.
 */

jest.setTimeout(120_000);

const data = (res: Response) => body<PlanPurchaseView>(res).data!;
const reasonOf = (res: Response) => body<unknown>(res).reason!;

const DAY = 86_400_000;
const config = loadPlansConfig();
const byPrice = [...config.tiers].sort((a, b) => a.price.kobo - b.price.kobo);
const small = byPrice[0];
const middle = byPrice[1];
const big = byPrice[byPrice.length - 1];
const RICH = 100 * priceIn(big.price, 'NGN');

describe('Delivering a confirmed tier payment (TIER-03)', () => {
  let h: TierHarness;
  let call: ReturnType<typeof api>;
  let grants: TierGrantService;

  beforeAll(async () => {
    h = await bootTierApp('t03d');
    call = api(h);
    grants = h.get(TierGrantService);
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(() => {
    h.wallets.mode = 'live';
  });

  /** A confirmed payment as the payment service hands it to the handler. */
  const confirmed = (
    p: Person,
    kind: 'tier' | 'tier_bump',
    targetId: string,
    priceKobo = 12_345,
  ): CompletedPayment => ({
    paymentId: randomUUID(),
    payerWawuUserId: p.id,
    kind,
    targetId,
    priceKobo,
    payeeWawuUserId: null,
    note: null,
    holdId: null,
  });
  const deliver = (c: CompletedPayment) =>
    h.registry.get(c.kind)!.onCompleted!(c);
  const holdTier = (p: Person, tierId: string, activeDays = 10) =>
    h.prisma.$transaction((tx) =>
      grants.grant(tx, {
        wawuUserId: p.id,
        tierId,
        sourceRef: `seed:${randomUUID()}`,
        days: activeDays,
      }),
    );
  const nothingWritten = async (p: Person, c: CompletedPayment) => {
    expect(
      await h.prisma.makerPurchase.count({ where: { wawuUserId: p.id } }),
    ).toBe(0);
    expect(
      await h.prisma.personBilling.count({ where: { wawuUserId: p.id } }),
    ).toBe(0);
    expect(
      await h.prisma.eventPass.count({ where: { purchaseRef: c.paymentId } }),
    ).toBe(0);
    expect(
      await h.prisma.pointLot.count({
        where: { wawuUserId: p.id, sourceRef: c.paymentId },
      }),
    ).toBe(0);
  };

  it('does not grant a purchase that no longer fits what the person holds, and writes nothing', async () => {
    const p = await h.buyer(0);
    await holdTier(p, middle.id);
    const held = await h.prisma.makerTier.findUniqueOrThrow({
      where: { wawuUserId: p.id },
    });
    const lots = await h.prisma.pointLot.count({ where: { wawuUserId: p.id } });
    // A first purchase of another tier while a tier runs, a renewal of a tier
    // that is not the one held, and an upgrade from a tier that is not.
    const cases: Array<[CompletedPayment, RegExp]> = [
      [confirmed(p, 'tier', `tier-${big.id}`), /holds another tier/],
      [confirmed(p, 'tier', `renew-${big.id}`), /holds another tier/],
      [
        confirmed(p, 'tier_bump', `upgrade-${small.id}-${big.id}`),
        /no longer holds the tier this upgrade/,
      ],
    ];
    for (const [c, why] of cases) {
      await expect(deliver(c)).rejects.toThrow(why);
      await expect(deliver(c)).rejects.toMatchObject({
        name: 'TierGrantRefusal',
      });
      await nothingWritten(p, c);
    }
    expect(
      await h.prisma.makerTier.findUniqueOrThrow({
        where: { wawuUserId: p.id },
      }),
    ).toEqual(held);
    expect(await h.prisma.pointLot.count({ where: { wawuUserId: p.id } })).toBe(
      lots,
    );
  });

  it('does not upgrade a tier that has ended, and does not renew with nothing to renew', async () => {
    const p = await h.buyer(0);
    const ended = confirmed(p, 'tier', `upgrade-${small.id}-${big.id}`);
    await h.prisma.makerTier.create({
      data: {
        wawuUserId: p.id,
        tierId: small.id,
        activeFrom: new Date(Date.now() - 40 * DAY),
        activeUntil: new Date(Date.now() - DAY),
        productsIncluded: small.products,
        pointsIncluded: small.bonusPoints,
      },
    });
    await expect(deliver(ended)).rejects.toMatchObject({
      name: 'TierGrantRefusal',
    });
    await nothingWritten(p, ended);
    const q = await h.buyer(0);
    const none = confirmed(q, 'tier', `renew-${small.id}`);
    await expect(deliver(none)).rejects.toMatchObject({
      name: 'TierGrantRefusal',
    });
    await nothingWritten(q, none);
  });

  it('the purchase row alone makes a repeat a no-op: with the pass row gone, a repeat does not extend the tier again', async () => {
    const p = await h.buyer(0);
    const c = confirmed(p, 'tier', `tier-${small.id}`);
    await deliver(c);
    const first = await h.prisma.makerTier.findUniqueOrThrow({
      where: { wawuUserId: p.id },
    });
    await h.prisma.eventPass.deleteMany({
      where: { purchaseRef: c.paymentId },
    });
    await deliver(c);
    const again = await h.prisma.makerTier.findUniqueOrThrow({
      where: { wawuUserId: p.id },
    });
    expect(again.activeUntil).toEqual(first.activeUntil);
    expect(
      await h.prisma.eventPass.count({ where: { purchaseRef: c.paymentId } }),
    ).toBe(0);
    expect(
      await h.prisma.makerPurchase.count({
        where: { paymentRef: c.paymentId },
      }),
    ).toBe(1);
  });

  it('a first purchase that meets the same tier already running extends it, as a renewal', async () => {
    const p = await h.buyer(0);
    await holdTier(p, small.id, 10);
    const before = await h.prisma.makerTier.findUniqueOrThrow({
      where: { wawuUserId: p.id },
    });
    const c = confirmed(p, 'tier', `tier-${small.id}`);
    await deliver(c);
    const after = await h.prisma.makerTier.findUniqueOrThrow({
      where: { wawuUserId: p.id },
    });
    expect(after.activeUntil.getTime()).toBe(
      before.activeUntil.getTime() + small.days * DAY,
    );
    expect(
      await h.prisma.makerPurchase.count({
        where: { paymentRef: c.paymentId },
      }),
    ).toBe(1);
  });

  it('a person whose billing currency was fixed in dollars meanwhile is not granted a naira payment; nothing is written', async () => {
    const p = await h.buyer(0);
    await h.prisma.personBilling.create({
      data: { wawuUserId: p.id, currency: 'USD', fixedBy: 'support' },
    });
    const c = confirmed(p, 'tier', `tier-${small.id}`);
    await expect(deliver(c)).rejects.toMatchObject({
      name: 'TierGrantRefusal',
    });
    expect(
      await h.prisma.makerPurchase.count({ where: { wawuUserId: p.id } }),
    ).toBe(0);
    expect(
      await h.prisma.makerTier.count({ where: { wawuUserId: p.id } }),
    ).toBe(0);
    expect(
      await h.prisma.personBilling.findUniqueOrThrow({
        where: { wawuUserId: p.id },
      }),
    ).toMatchObject({ currency: 'USD', fixedBy: 'support' });
  });

  it('two first purchases for one person delivered at once: one is granted, the other refused and rolled back, and the currency is fixed once by the winner', async () => {
    for (let round = 0; round < 8; round += 1) {
      const p = await h.buyer(0);
      const a = confirmed(p, 'tier', `tier-${small.id}`);
      const b = confirmed(p, 'tier_bump', `tier-${big.id}`);
      const settled = await Promise.allSettled([deliver(a), deliver(b)]);
      expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
      const rows = await h.prisma.makerPurchase.findMany({
        where: { wawuUserId: p.id },
      });
      expect(rows).toHaveLength(1);
      const billing = await h.prisma.personBilling.findMany({
        where: { wawuUserId: p.id },
      });
      expect(billing).toHaveLength(1);
      expect(billing[0]).toMatchObject({
        currency: 'NGN',
        fixedBy: 'first_purchase',
        purchaseRef: rows[0].paymentRef,
      });
      expect(
        await h.prisma.eventPass.count({ where: { wawuUserId: p.id } }),
      ).toBe(1);
      expect(
        await h.prisma.pointLot.count({ where: { wawuUserId: p.id } }),
      ).toBe(rows[0].bump ? 2 : 1);
    }
  });

  it("two purchases for one person whose currency is already fixed, delivered at once: one is granted and the other refused, because the person's tier lock serialises them", async () => {
    for (let round = 0; round < 12; round += 1) {
      const p = await h.buyer(0);
      await h.prisma.personBilling.create({
        data: {
          wawuUserId: p.id,
          currency: 'NGN',
          fixedBy: 'first_purchase',
          purchaseRef: `earlier-${p.id}`,
        },
      });
      const a = confirmed(p, 'tier', `tier-${small.id}`);
      const b = confirmed(p, 'tier_bump', `tier-${big.id}`);
      const settled = await Promise.allSettled([deliver(a), deliver(b)]);
      expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
      const refused = settled.filter((s) => s.status === 'rejected');
      expect(refused).toHaveLength(1);
      expect(refused[0].reason).toMatchObject({ name: 'TierGrantRefusal' });
      expect(
        await h.prisma.makerPurchase.count({ where: { wawuUserId: p.id } }),
      ).toBe(1);
      expect(
        await h.prisma.eventPass.count({ where: { wawuUserId: p.id } }),
      ).toBe(1);
    }
  });

  it('never writes a tier that starts later, or a currency without its purchase', async () => {
    const people = await Promise.all([1, 2, 3].map(() => h.buyer(0)));
    for (const p of people)
      await deliver(confirmed(p, 'tier', `tier-${small.id}`));
    const future = await h.prisma.makerTier.count({
      where: {
        wawuUserId: { in: people.map((p) => p.id) },
        activeFrom: { gt: new Date() },
      },
    });
    expect(future).toBe(0);
    const orphan = await h.prisma.personBilling.count({
      where: { wawuUserId: { in: people.map((p) => p.id) }, purchaseRef: null },
    });
    expect(orphan).toBe(0);
  });

  it('a request that died mid-payment is answered with the purchase, not the bare payment', async () => {
    const p = await h.buyer(RICH);
    const q = body<PlanPurchaseQuoteView>(
      await call.quote(p, { kind: 'tier', tierId: small.id }),
    ).data!;
    const request = {
      kind: 'tier',
      tierId: small.id,
      method: 'wallet',
      expectedTotalKobo: q.payment.totalKobo,
      quoteToken: q.payment.quoteToken,
    };
    const key = randomUUID();
    const first = await call.buy(p, request, { key });
    expect(first.status).toBe(201);
    // As if the answer had never been stored and the server died: the key is
    // `in_progress`, names the payment, and is old.
    await h.prisma
      .$executeRaw`UPDATE "MoneyIdempotencyKey" SET "state" = 'in_progress', "responseStatus" = NULL, "responseBody" = NULL, "updatedAt" = now() - interval '1 hour' WHERE "wawuUserId" = ${p.id} AND "key" = ${key}`;
    const replay = await call.buy(p, request, { key, pin: '0000' });
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(data(replay)).toMatchObject({
      kind: 'tier',
      tierId: small.id,
      status: 'paid',
    });
    expect(data(replay).grant).not.toBeNull();
    expect(data(replay).payment.id).toBe(data(first).id);
    expect(
      h.wallets.sends.filter((s) => s.from === p.accountNumber),
    ).toHaveLength(1);
  });

  it('a payment confirmed after the person was granted another tier is not granted: it keeps its claim, says it is finishing, and takes nothing more', async () => {
    const p = await h.buyer(RICH);
    const q = body<PlanPurchaseQuoteView>(
      await call.quote(p, { kind: 'tier', tierId: big.id }),
    ).data!;
    h.wallets.mode = 'timeout';
    const res = await call.buy(p, {
      kind: 'tier',
      tierId: big.id,
      method: 'wallet',
      expectedTotalKobo: q.payment.totalKobo,
      quoteToken: q.payment.quoteToken,
    });
    h.wallets.mode = 'live';
    const pending = body<PlanPurchaseView>(res).data!;
    expect(pending.status).toBe('pending');
    // While it confirms, a claim of an event code (JOIN-03) grants a different tier.
    await holdTier(p, small.id, 20);

    await h.sweepLater();
    const stuck = body<PlanPurchaseView>(await call.read(p, pending.id)).data!;
    expect(stuck).toMatchObject({
      status: 'pending',
      statusMessage: FINISHING_MESSAGE,
      grant: null,
    });
    expect(stuck.payment).toMatchObject({
      status: 'completed',
      delivered: false,
    });
    expect(
      await h.prisma.makerPurchase.count({ where: { wawuUserId: p.id } }),
    ).toBe(0);
    expect(
      await h.prisma.personBilling.count({ where: { wawuUserId: p.id } }),
    ).toBe(0);
    const tier = await h.prisma.makerTier.findUniqueOrThrow({
      where: { wawuUserId: p.id },
    });
    expect(tier.tierId).toBe(small.id);

    // The sweep tries again, in order, and it never grants; the claim stays so nothing is taken twice.
    await h.sweepLater(70 * 60_000);
    await h.sweepLater(70 * 60_000);
    const row = await h.prisma.walletPayment.findUniqueOrThrow({
      where: { id: pending.id },
    });
    expect(row.fulfilledAt).toBeNull();
    expect(row.openKey).not.toBeNull();
    expect(row.deliveryAttempts).toBeGreaterThan(0);
    expect(
      await h.prisma.makerPurchase.count({ where: { wawuUserId: p.id } }),
    ).toBe(0);
    const again = await call.quote(p, { kind: 'renew', tierId: small.id });
    expect(again.status).toBe(409);
    expect(reasonOf(again)).toMatchObject({
      code: 'payment_in_progress',
      paymentId: pending.id,
    });
    expect(
      h.wallets.sends.filter((s) => s.from === p.accountNumber),
    ).toHaveLength(1);
  });
});
