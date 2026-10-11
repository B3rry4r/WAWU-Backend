import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import {
  api,
  bootTierApp,
  liveFee,
  type Person,
  type TierHarness,
} from '../../../../test/plans/tier-purchase-harness';
import { MERCHANT_ACCOUNT } from '../../../../test/fintava/fintava-double';
import { body } from '../../../../test/payments/poll-helpers';
import type { CompletedPayment } from '../../../money/payments/payable-registry';
import { loadPlansConfig, priceIn } from '../../plans-config';
import { WalletHoldService } from '../../../money/holds/wallet-hold.service';
import { lockPersonTier, TierGrantService } from '../../tier-grant.service';
import {
  PlanPurchaseService,
  REFUNDED_MESSAGE,
} from '../plan-purchase.service';
import type {
  PlanPurchaseQuoteView,
  PlanPurchaseView,
} from '../plan-purchase-view.type';

/**
 * TIER-03: what happens at the moment a confirmed payment is delivered, and
 * after: a purchase that no longer fits what the person holds is not granted
 * (it writes nothing, and the whole price goes back to the payer, once: round
 * 2, D1), two payments for one person at once cannot both grant, and a
 * request that died mid-payment is answered with the purchase and not the
 * bare payment. The payments here have real rows (the refund needs the
 * payment it pays back); the provider is the Fintava double with a book of
 * wallets, WAWU's own account among them.
 */

jest.setTimeout(120_000);

const data = (res: Response) => body<PlanPurchaseView>(res).data!;

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
    // WAWU's own account: what a refund is sent from.
    h.wallets.kobo.set(MERCHANT_ACCOUNT, 1_000_000_000);
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(() => {
    h.wallets.mode = 'live';
  });

  /**
   * A confirmed payment as the payment service hands it to the handler: its
   * row exists (completed, not yet delivered, WAWU's share the whole price,
   * as a tier payment is), so a refund has a payment to pay back.
   */
  const confirmed = async (
    p: Person,
    kind: 'tier' | 'tier_bump',
    targetId: string,
    priceKobo = 12_345,
  ): Promise<CompletedPayment> => {
    const paymentId = randomUUID();
    await h.prisma.walletPayment.create({
      data: {
        id: paymentId,
        payerWawuUserId: p.id,
        kind,
        targetId,
        title: 'A plan',
        payeeWawuUserId: null,
        priceKobo,
        providerFeeKobo: liveFee(priceKobo),
        wawuFeeKobo: 0,
        totalKobo: priceKobo + liveFee(priceKobo),
        payeeShareKobo: 0,
        wawuShareKobo: priceKobo,
        customerReference: `wawu-pay-${paymentId}`,
        payerAccountNumber: p.accountNumber,
        merchantAccountNumber: MERCHANT_ACCOUNT,
        status: 'completed',
        completedAt: new Date(),
      },
    });
    return {
      paymentId,
      payerWawuUserId: p.id,
      kind,
      targetId,
      priceKobo,
      payeeWawuUserId: null,
      note: null,
      holdId: null,
    };
  };
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

  /** The whole price went back to the payer, once, as MONEY-18's refund. */
  const paidBack = async (p: Person, c: CompletedPayment) => {
    const hold = await h.prisma.walletHold.findUnique({
      where: { paymentId: c.paymentId },
    });
    expect(hold).toMatchObject({
      action: 'refund',
      status: 'refunded',
      releaseCondition: 'plan_granted',
      payerWawuUserId: p.id,
      payeeWawuUserId: null,
      amountKobo: BigInt(c.priceKobo),
      refundedKobo: BigInt(c.priceKobo),
    });
    const sends = h.wallets.sends.filter(
      (x) => x.reference === hold!.customerReference,
    );
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      from: MERCHANT_ACCOUNT,
      to: p.accountNumber,
      amountKobo: c.priceKobo,
    });
    return hold!;
  };
  const notPaidBack = async (c: CompletedPayment) => {
    expect(
      await h.prisma.walletHold.count({ where: { paymentId: c.paymentId } }),
    ).toBe(0);
  };

  it('does not grant a purchase that no longer fits what the person holds: it writes nothing and the whole price goes back, once', async () => {
    const p = await h.buyer(0);
    await holdTier(p, middle.id);
    const held = await h.prisma.makerTier.findUniqueOrThrow({
      where: { wawuUserId: p.id },
    });
    const lots = await h.prisma.pointLot.count({ where: { wawuUserId: p.id } });
    // A first purchase of another tier while a tier runs, a renewal of a tier
    // that is not the one held, and an upgrade from a tier that is not.
    const cases: Array<[CompletedPayment, RegExp]> = [
      [await confirmed(p, 'tier', `tier-${big.id}`), /holds another tier/],
      [await confirmed(p, 'tier', `renew-${big.id}`), /holds another tier/],
      [
        await confirmed(p, 'tier_bump', `upgrade-${small.id}-${big.id}`),
        /no longer holds the tier this upgrade/,
      ],
    ];
    for (const [c, why] of cases) {
      await deliver(c);
      await nothingWritten(p, c);
      const hold = await paidBack(p, c);
      expect(hold.actionReason).toMatch(why);
      // Delivered again (the sweep, a second server): still one refund.
      await deliver(c);
      await Promise.all([1, 2, 3].map(() => deliver(c)));
      await paidBack(p, c);
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

  it('does not upgrade a tier that has ended, and does not renew with nothing to renew: each is paid back', async () => {
    const p = await h.buyer(0);
    const ended = await confirmed(p, 'tier', `upgrade-${small.id}-${big.id}`);
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
    await deliver(ended);
    await nothingWritten(p, ended);
    await paidBack(p, ended);
    const q = await h.buyer(0);
    const none = await confirmed(q, 'tier', `renew-${small.id}`);
    await deliver(none);
    await nothingWritten(q, none);
    await paidBack(q, none);
  });

  it('a tier the plans file no longer names is paid back, not retried for ever', async () => {
    const p = await h.buyer(0);
    const c = await confirmed(p, 'tier', 'tier-no_such_tier');
    await deliver(c);
    await nothingWritten(p, c);
    const hold = await paidBack(p, c);
    expect(hold.actionReason).toMatch(/no tier "no_such_tier"/);
  });

  it('a payment already being paid back is never granted, even if the tier would now fit', async () => {
    const p = await h.buyer(0);
    const c = await confirmed(p, 'tier', `tier-${small.id}`);
    // A tier runs, so a first purchase of another tier does not fit: paid back.
    await holdTier(p, middle.id, 30);
    await deliver(c);
    await paidBack(p, c);
    // The tier ends; the same confirmation would fit now, and is still not granted.
    await h.prisma.makerTier.update({
      where: { wawuUserId: p.id },
      data: {
        activeFrom: new Date(Date.now() - 40 * DAY),
        activeUntil: new Date(Date.now() - DAY),
      },
    });
    await deliver(c);
    await nothingWritten(p, c);
    await paidBack(p, c);
  });

  it('a payment granted by another delivery while a refund waits for the tier lock is not paid back', async () => {
    const p = await h.buyer(0);
    const c = await confirmed(p, 'tier', `tier-${small.id}`);
    const service = h.get(PlanPurchaseService) as unknown as {
      refund(payment: CompletedPayment, why: string): Promise<void>;
    };
    let refunded = false;
    let pending: Promise<void> = Promise.resolve();
    await h.prisma.$transaction(async (tx) => {
      // Another delivery is granting this payment: it holds the person's tier
      // lock and has written the purchase row, and has not committed.
      await lockPersonTier(tx, p.id);
      await tx.makerPurchase.create({
        data: {
          paymentRef: c.paymentId,
          wawuUserId: p.id,
          kind: 'tier',
          tierId: small.id,
          currency: 'NGN',
          amountMinor: c.priceKobo,
        },
      });
      // A refund asked for the same payment must wait for that lock ...
      pending = service.refund(c, 'a test').then(() => {
        refunded = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(refunded).toBe(false);
    });
    // ... and, once the grant is committed, finds it and pays nothing back.
    await pending;
    await notPaidBack(c);
    expect(
      h.wallets.sends.filter((x) => x.to === p.accountNumber),
    ).toHaveLength(0);
  });

  it('the purchase row alone makes a repeat a no-op: with the pass row gone, a repeat does not extend the tier again', async () => {
    const p = await h.buyer(0);
    const c = await confirmed(p, 'tier', `tier-${small.id}`);
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
    const c = await confirmed(p, 'tier', `tier-${small.id}`);
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

  it('a person whose billing currency was fixed in dollars meanwhile is not granted a naira payment: nothing is written and the payment is paid back', async () => {
    const p = await h.buyer(0);
    await h.prisma.personBilling.create({
      data: { wawuUserId: p.id, currency: 'USD', fixedBy: 'support' },
    });
    const c = await confirmed(p, 'tier', `tier-${small.id}`);
    await deliver(c);
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
    await paidBack(p, c);
  });

  it('two first purchases for one person delivered at once: one is granted, the other is paid back, and the currency is fixed once by the winner', async () => {
    for (let round = 0; round < 8; round += 1) {
      const p = await h.buyer(0);
      const a = await confirmed(p, 'tier', `tier-${small.id}`);
      const b = await confirmed(p, 'tier_bump', `tier-${big.id}`);
      const settled = await Promise.allSettled([deliver(a), deliver(b)]);
      expect(settled.map((x) => x.status)).toEqual(['fulfilled', 'fulfilled']);
      const rows = await h.prisma.makerPurchase.findMany({
        where: { wawuUserId: p.id },
      });
      expect(rows).toHaveLength(1);
      const loser = rows[0].paymentRef === a.paymentId ? b : a;
      await paidBack(p, loser);
      await notPaidBack(rows[0].paymentRef === a.paymentId ? a : b);
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

  it("two purchases for one person whose currency is already fixed, delivered at once: one is granted and the other is paid back, because the person's tier lock serialises them", async () => {
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
      const a = await confirmed(p, 'tier', `tier-${small.id}`);
      const b = await confirmed(p, 'tier_bump', `tier-${big.id}`);
      const settled = await Promise.allSettled([deliver(a), deliver(b)]);
      expect(settled.map((x) => x.status)).toEqual(['fulfilled', 'fulfilled']);
      const rows = await h.prisma.makerPurchase.findMany({
        where: { wawuUserId: p.id },
      });
      expect(rows).toHaveLength(1);
      const [won, lost] = rows[0].paymentRef === a.paymentId ? [a, b] : [b, a];
      await notPaidBack(won);
      await paidBack(p, lost);
      expect(
        await h.prisma.eventPass.count({ where: { wawuUserId: p.id } }),
      ).toBe(1);
    }
  });

  it('never writes a tier that starts later, or a currency without its purchase', async () => {
    const people = await Promise.all([1, 2, 3].map(() => h.buyer(0)));
    for (const p of people)
      await deliver(await confirmed(p, 'tier', `tier-${small.id}`));
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

  it('a payment confirmed after the person was granted another tier is not granted: it is paid back once, its claim is given up, and the person may pay again at once', async () => {
    const p = await h.buyer(RICH);
    const price = priceIn(big.price, 'NGN');
    const merchantBefore = h.wallets.kobo.get(MERCHANT_ACCOUNT)!;
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
    const back = body<PlanPurchaseView>(await call.read(p, pending.id)).data!;
    expect(back).toMatchObject({
      status: 'refunded',
      statusMessage: REFUNDED_MESSAGE,
      grant: null,
      paidAt: null,
    });
    expect(back.payment).toMatchObject({
      status: 'completed',
      delivered: true,
    });
    const paid = await h.prisma.walletPayment.findUniqueOrThrow({
      where: { id: pending.id },
    });
    expect(paid.fulfilledAt).not.toBeNull();
    expect(paid.openKey).toBeNull();
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
    const c: CompletedPayment = {
      paymentId: pending.id,
      payerWawuUserId: p.id,
      kind: 'tier',
      targetId: pending.payment.targetId,
      priceKobo: price,
      payeeWawuUserId: null,
      note: null,
      holdId: null,
    };
    await paidBack(p, c);
    // The price is back; the charge on the original payment is not (R-10),
    // and the charge on the refund is WAWU's (R-31).
    expect(h.wallets.kobo.get(p.accountNumber)).toBe(RICH - liveFee(price));
    expect(h.wallets.kobo.get(MERCHANT_ACCOUNT)).toBe(
      merchantBefore - liveFee(price),
    );

    // Confirmed again, swept again, the hold swept: nothing more moves.
    await h.sweepLater(70 * 60_000);
    await h.sweepLater(70 * 60_000);
    await deliver(c);
    await h.get(WalletHoldService).sweep(new Date(Date.now() + 3_600_000));
    await paidBack(p, c);
    expect(
      h.wallets.sends.filter((x) => x.to === p.accountNumber),
    ).toHaveLength(1);
    expect(
      h.wallets.sends.filter((x) => x.from === p.accountNumber),
    ).toHaveLength(1);

    // Free to pay again at once: nothing is in progress.
    const again = await call.quote(p, { kind: 'renew', tierId: small.id });
    expect(again.status).toBe(200);
    const next = await call.buy(p, {
      kind: 'renew',
      tierId: small.id,
      method: 'wallet',
      expectedTotalKobo:
        body<PlanPurchaseQuoteView>(again).data!.payment.totalKobo,
      quoteToken: body<PlanPurchaseQuoteView>(again).data!.payment.quoteToken,
    });
    expect(next.status).toBe(201);
    expect(data(next).status).toBe('paid');
  });
});
