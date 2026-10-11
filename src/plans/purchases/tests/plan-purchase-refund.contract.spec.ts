import request from 'supertest';
import {
  api,
  bootTierApp,
  liveFee,
  type Person,
  type TierHarness,
} from '../../../../test/plans/tier-purchase-harness';
import { MERCHANT_ACCOUNT } from '../../../../test/fintava/fintava-double';
import { body } from '../../../../test/payments/poll-helpers';
import { WalletHoldService } from '../../../money/holds/wallet-hold.service';
import type { CompletedPayment } from '../../../money/payments/payable-registry';
import type { TransactionPage } from '../../../money/money-view.type';
import type { MyPointsView } from '../../../points/points-view.type';
import { loadPlansConfig, priceIn } from '../../plans-config';
import type { MyTierView } from '../../plans-view.type';
import { refundedMessage, refundingMessage } from '../plan-purchase.service';
import type {
  PlanPurchaseQuoteView,
  PlanPurchaseView,
} from '../plan-purchase-view.type';

/**
 * TIER-03 round 2, D1 (the verifier's finding): an upgrade paid while the
 * tier it came from ends before the payment confirms was taken and never
 * granted, and every plan quote answered `payment_in_progress` until a person
 * looked. Now the purchase is paid back in full through MONEY-18's refund
 * (once, one way; WAWU pays the provider's charge on that move, R-31), reads
 * `refunded` with a plain sentence, and the person may buy again at once.
 *
 * Every step goes through the routes the app calls, on the real modules, a
 * real database and the Fintava double (a book of wallets, WAWU's own account
 * among them). No provider host is called.
 */

jest.setTimeout(120_000);

const DAY = 86_400_000;
const config = loadPlansConfig();
const byPrice = [...config.tiers].sort((a, b) => a.price.kobo - b.price.kobo);
const small = byPrice[0];
const big = byPrice[byPrice.length - 1];
const price = (t: { price: Parameters<typeof priceIn>[0] }) =>
  priceIn(t.price, 'NGN');
const RICH = 100 * price(big);

describe('A plan that cannot be granted when its payment confirms is paid back (TIER-03 round 2, D1)', () => {
  let h: TierHarness;
  let call: ReturnType<typeof api>;
  let holds: WalletHoldService;

  beforeAll(async () => {
    h = await bootTierApp('t03r');
    call = api(h);
    holds = h.get(WalletHoldService);
    // WAWU's own account: what the money was paid into, and what a refund is sent from.
    h.wallets.kobo.set(MERCHANT_ACCOUNT, 1_000_000_000);
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(() => {
    h.wallets.mode = 'live';
  });

  type Terms = {
    kind: 'tier' | 'renew' | 'upgrade';
    tierId: string;
    bump?: boolean;
  };
  async function quoted(p: Person, t: Terms): Promise<PlanPurchaseQuoteView> {
    const res = await call.quote(p, t);
    expect(res.status).toBe(200);
    return body<PlanPurchaseQuoteView>(res).data!;
  }
  const bodyFor = (t: Terms, q: PlanPurchaseQuoteView) => ({
    kind: t.kind,
    tierId: t.tierId,
    ...(t.bump === undefined ? {} : { bump: t.bump }),
    method: 'wallet',
    expectedTotalKobo: q.payment.totalKobo,
    quoteToken: q.payment.quoteToken,
  });
  async function purchase(p: Person, t: Terms) {
    const q = await quoted(p, t);
    const res = await call.buy(p, bodyFor(t, q));
    return { q, res, view: body<PlanPurchaseView>(res).data! };
  }
  /** The payment's answer is lost: the provider took the money and the answer never came. */
  async function purchaseWithLostAnswer(p: Person, t: Terms) {
    const q = await quoted(p, t);
    h.wallets.mode = 'timeout';
    const res = await call.buy(p, bodyFor(t, q));
    h.wallets.mode = 'live';
    return { q, res, view: body<PlanPurchaseView>(res).data! };
  }
  const read = async (p: Person, id: string) =>
    body<PlanPurchaseView>(await call.read(p, id)).data!;
  const tierRow = (p: Person) =>
    h.prisma.makerTier.findUniqueOrThrow({ where: { wawuUserId: p.id } });
  /** The source tier ends: its end is moved into the past (a clock running out). */
  const endTier = (p: Person) =>
    h.prisma.makerTier.update({
      where: { wawuUserId: p.id },
      data: {
        activeFrom: new Date(Date.now() - 20 * DAY),
        activeUntil: new Date(Date.now() - 1000),
      },
    });
  const completedOf = (v: PlanPurchaseView, p: Person): CompletedPayment => ({
    paymentId: v.id,
    payerWawuUserId: p.id,
    kind: v.payment.kind,
    targetId: v.payment.targetId,
    priceKobo: v.payment.priceKobo,
    payeeWawuUserId: null,
    note: null,
    holdId: null,
  });
  /** Sends from WAWU's account to the payer: the refund moves. */
  const refundsTo = (p: Person) =>
    h.wallets.sends.filter(
      (s) => s.from === MERCHANT_ACCOUNT && s.to === p.accountNumber,
    );
  const sendsFrom = (p: Person) =>
    h.wallets.sends.filter((s) => s.from === p.accountNumber);

  it('the verifier case: Verify ends while an upgrade payment is confirming, and the difference goes back, once', async () => {
    const p = await h.buyer(RICH);
    const first = (await purchase(p, { kind: 'tier', tierId: small.id })).view;
    expect(first.status).toBe('paid');
    const lots = await h.prisma.pointLot.count({ where: { wawuUserId: p.id } });
    const diff = price(big) - price(small);

    // The upgrade is paid and the answer is lost: pending, the money taken.
    const { view: pending } = await purchaseWithLostAnswer(p, {
      kind: 'upgrade',
      tierId: big.id,
    });
    expect(pending.status).toBe('pending');
    expect(sendsFrom(p)).toHaveLength(2);
    const walletTaken = h.wallets.kobo.get(p.accountNumber)!;

    // Verify ends before the payment confirms; the sweep finds the record.
    await endTier(p);
    await h.sweepLater();

    // The purchase reads refunded, in words; nothing was granted.
    const back = await read(p, pending.id);
    expect(back).toMatchObject({
      kind: 'upgrade',
      tierId: big.id,
      fromTierId: small.id,
      status: 'refunded',
      statusMessage: refundedMessage(diff),
      grant: null,
      paidAt: null,
      amountMinor: diff,
    });
    expect(back.payment).toMatchObject({
      status: 'completed',
      delivered: true,
    });
    // The words, pinned: what comes back (the price, in naira, worked out here
    // and not by the code under test) and what does not (the first payment's
    // charge, R-10); no em-dash in a sentence a person reads (R-5).
    const nairaDiff = `\u20A6${(diff / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
    expect(back.statusMessage).toBe(
      `We could not give you this plan, so ${nairaDiff} is back in your wallet. The charge on your first payment is not returned.`,
    );
    expect(refundingMessage(diff)).toBe(
      `We could not give you this plan, so ${nairaDiff} is on its way back to your wallet. The charge on your first payment is not returned.`,
    );
    expect(refundedMessage(diff)).not.toMatch(/\u2014/);
    expect(refundingMessage(diff)).not.toMatch(/\u2014/);
    const row = await tierRow(p);
    expect(row.tierId).toBe(small.id);
    expect(row.activeUntil.getTime()).toBeLessThan(Date.now());
    expect(
      await h.prisma.makerPurchase.findMany({ where: { wawuUserId: p.id } }),
    ).toHaveLength(1);
    expect(
      await h.prisma.eventPass.count({ where: { purchaseRef: pending.id } }),
    ).toBe(0);
    expect(await h.prisma.pointLot.count({ where: { wawuUserId: p.id } })).toBe(
      lots,
    );

    // The price (the difference) went back, once, from WAWU's account, under
    // our own reference; the charge on the original payment did not.
    const hold = await h.prisma.walletHold.findUniqueOrThrow({
      where: { paymentId: pending.id },
    });
    expect(hold).toMatchObject({
      action: 'refund',
      status: 'refunded',
      releaseCondition: 'plan_granted',
      amountKobo: BigInt(diff),
      refundedKobo: BigInt(diff),
      transferKobo: BigInt(diff),
      payeeWawuUserId: null,
    });
    expect(hold.customerReference).toBe(`wawu-ref-${hold.id}`);
    const back1 = refundsTo(p);
    expect(back1).toHaveLength(1);
    expect(back1[0]).toMatchObject({
      amountKobo: diff,
      reference: hold.customerReference,
    });
    expect(h.wallets.kobo.get(p.accountNumber)).toBe(walletTaken + diff);

    // The wallet history shows it: the purchase going out and the refund coming
    // back, linked to the same tier, the refund as a refund.
    const history = body<TransactionPage>(
      await request(h.app.getHttpServer())
        .get('/api/hub/money/transactions')
        .set('Authorization', p.auth),
    ).data!.items.filter((r) => r.link?.kind === 'tier');
    const refundRow = history.find((r) => r.category === 'refund');
    expect(refundRow).toMatchObject({
      direction: 'in',
      amountKobo: diff,
      status: 'completed',
    });
    expect(refundRow!.description).not.toMatch(/\u2014/);
    expect(history.filter((r) => r.category === 'purchase')).toHaveLength(2);

    // Replayed: the sweeps again, the confirmation delivered again (two
    // servers), the hold sweep. Nothing moves a second time.
    await h.sweepLater(70 * 60_000);
    await h.sweepLater(70 * 60_000);
    const handler = h.registry.get('tier')!;
    const c = completedOf(pending, p);
    await handler.onCompleted!(c);
    await Promise.all([1, 2, 3, 4].map(() => handler.onCompleted!(c)));
    await holds.sweep(new Date(Date.now() + 3 * 3_600_000));
    expect(refundsTo(p)).toHaveLength(1);
    expect(h.wallets.kobo.get(p.accountNumber)).toBe(walletTaken + diff);
    expect(
      await h.prisma.walletHold.count({ where: { paymentId: pending.id } }),
    ).toBe(1);
    expect(await read(p, pending.id)).toMatchObject({ status: 'refunded' });

    // Free to buy again at once: no payment_in_progress, and a tier bought now
    // is granted for the price it asks.
    const again = await call.quote(p, { kind: 'tier', tierId: big.id });
    expect(again.status).toBe(200);
    const next = await purchase(p, { kind: 'tier', tierId: big.id });
    expect(next.view.status).toBe('paid');
    expect(next.view.grant).toMatchObject({ tier: { id: big.id } });
    expect((await tierRow(p)).tierId).toBe(big.id);
  });

  it('the checkout bump goes back with the plan: one payment, one refund of both prices', async () => {
    const p = await h.buyer(RICH);
    await purchase(p, { kind: 'tier', tierId: small.id });
    const { view: pending, q } = await purchaseWithLostAnswer(p, {
      kind: 'upgrade',
      tierId: big.id,
      bump: true,
    });
    expect(pending.status).toBe('pending');
    const total = q.planMinor + q.bumpMinor;
    expect(pending.payment.priceKobo).toBe(total);
    const lots = await h.prisma.pointLot.count({ where: { wawuUserId: p.id } });
    await endTier(p);
    await h.sweepLater();
    expect(await read(p, pending.id)).toMatchObject({
      status: 'refunded',
      bump: true,
      grant: null,
    });
    expect(refundsTo(p)).toHaveLength(1);
    expect(refundsTo(p)[0].amountKobo).toBe(total);
    // No bump lot and no tier lot were granted for it.
    expect(await h.prisma.pointLot.count({ where: { wawuUserId: p.id } })).toBe(
      lots,
    );
  });

  it('a refund whose answer is lost is asked about, never sent again: the purchase says it is on its way, then that it was paid back', async () => {
    const p = await h.buyer(RICH);
    await purchase(p, { kind: 'tier', tierId: small.id });
    const diff = price(big) - price(small);
    const { view: pending } = await purchaseWithLostAnswer(p, {
      kind: 'upgrade',
      tierId: big.id,
    });
    await endTier(p);

    // The sweep delivers; the refund send is taken by the provider and its
    // answer is lost.
    h.wallets.mode = 'timeout';
    await h.sweepLater();
    h.wallets.mode = 'live';
    const onItsWay = await read(p, pending.id);
    expect(onItsWay).toMatchObject({
      status: 'refunded',
      statusMessage: refundingMessage(diff),
      grant: null,
    });
    expect(
      await h.prisma.walletHold.findUniqueOrThrow({
        where: { paymentId: pending.id },
      }),
    ).toMatchObject({ action: 'refund', status: 'held' });
    expect(refundsTo(p)).toHaveLength(1);
    // Free to buy again even while the refund is on its way.
    expect((await call.quote(p, { kind: 'tier', tierId: big.id })).status).toBe(
      200,
    );

    // Later the provider is asked about our reference; the move is found, and
    // the hold is settled without a second send.
    await holds.sweep(new Date(Date.now() + 3 * 3_600_000));
    expect(await read(p, pending.id)).toMatchObject({
      status: 'refunded',
      statusMessage: refundedMessage(diff),
    });
    expect(
      await h.prisma.walletHold.findUniqueOrThrow({
        where: { paymentId: pending.id },
      }),
    ).toMatchObject({ status: 'refunded', refundedKobo: BigInt(diff) });
    expect(refundsTo(p)).toHaveLength(1);
  });

  it('a payment that is granted is never paid back, and one that is paid back is not granted when the tier would now fit', async () => {
    // Granted: the normal path leaves no hold and no refund.
    const p = await h.buyer(RICH);
    const ok = (await purchase(p, { kind: 'tier', tierId: small.id })).view;
    expect(ok.status).toBe('paid');
    expect(
      await h.prisma.walletHold.count({ where: { paymentId: ok.id } }),
    ).toBe(0);
    expect(refundsTo(p)).toHaveLength(0);

    // Paid back: Verify ended, so the upgrade is refunded ...
    const q = await h.buyer(RICH);
    await purchase(q, { kind: 'tier', tierId: small.id });
    const { view: pending } = await purchaseWithLostAnswer(q, {
      kind: 'upgrade',
      tierId: big.id,
    });
    await endTier(q);
    await h.sweepLater();
    expect(await read(q, pending.id)).toMatchObject({ status: 'refunded' });
    // ... and if the person then gets Verify back (a renewal), a repeat of the
    // old confirmation still does not grant the upgrade: the refund was decided.
    await h.prisma.makerTier.update({
      where: { wawuUserId: q.id },
      data: {
        activeFrom: new Date(),
        activeUntil: new Date(Date.now() + 10 * DAY),
      },
    });
    await h.registry.get('tier')!.onCompleted!(completedOf(pending, q));
    expect((await tierRow(q)).tierId).toBe(small.id);
    expect(
      await h.prisma.eventPass.count({ where: { purchaseRef: pending.id } }),
    ).toBe(0);
    expect(
      await h.prisma.makerPurchase.count({ where: { paymentRef: pending.id } }),
    ).toBe(0);
    expect(refundsTo(q)).toHaveLength(1);
  });

  it('the money is accounted for: the wallet ends down by the charge on the first payment only, and WAWU by the charge on the refund', async () => {
    const p = await h.buyer(RICH);
    await purchase(p, { kind: 'tier', tierId: small.id });
    const diff = price(big) - price(small);
    const walletBefore = h.wallets.kobo.get(p.accountNumber)!;
    const merchantBefore = h.wallets.kobo.get(MERCHANT_ACCOUNT)!;
    await purchaseWithLostAnswer(p, { kind: 'upgrade', tierId: big.id });
    await endTier(p);
    await h.sweepLater();
    // The person: the difference went out with its charge and the difference came back.
    expect(h.wallets.kobo.get(p.accountNumber)).toBe(
      walletBefore - liveFee(diff),
    );
    // WAWU: the difference came in and went out, and the refund's charge is WAWU's (R-31).
    expect(h.wallets.kobo.get(MERCHANT_ACCOUNT)).toBe(
      merchantBefore - liveFee(diff),
    );
    // What the app reads of the tier and the points is unchanged by all of it.
    const tier = body<MyTierView>(await call.tier(p)).data!;
    expect(tier.state).toBe('ended');
    expect(tier.tier!.id).toBe(small.id);
    const points = body<MyPointsView>(await call.points(p)).data!;
    expect(points.lots).toHaveLength(1);
  });
});
