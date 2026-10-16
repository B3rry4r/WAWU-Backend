import { randomUUID } from 'node:crypto';
import {
  api,
  bootTierApp,
  type Person,
  type TierHarness,
} from '../../../../test/plans/tier-purchase-harness';
import { MERCHANT_ACCOUNT } from '../../../../test/fintava/fintava-double';
import { body } from '../../../../test/payments/poll-helpers';
import { Prisma } from '../../../../generated/prisma/client';
import { WalletHoldService } from '../../../money/holds/wallet-hold.service';
import type { CompletedPayment } from '../../../money/payments/payable-registry';
import { FINISHING_MESSAGE } from '../../../money/payments/wallet-payment.service';
import { PointsError } from '../../../points/points-error';
import { PointsService } from '../../../points/points.service';
import { loadPlansConfig, priceIn } from '../../plans-config';
import type {
  PlanPurchaseQuoteView,
  PlanPurchaseView,
} from '../plan-purchase-view.type';

/**
 * TIER-03 round 3, R2-D1 (the round 2 verifier's X01 and X13): the two rules
 * about a delivery that goes wrong, pinned by making it go wrong.
 *
 *  - ONLY a refusal pays money back (a purchase that can no longer be granted
 *    as quoted). An ordinary failure while granting (the database, a points
 *    conflict, a deadlock) throws, writes nothing, refunds nothing, leaves the
 *    payment claimed and undelivered, and the retry grants it exactly once.
 *  - A failing REFUND call is never swallowed: the delivery throws, the hold
 *    keeps no action, the payment stays claimed, and the retry sends the
 *    money once.
 *
 * Every step goes through the routes and the payment sweep the app relies on,
 * on the real modules, a real database and the Fintava double. The failures
 * are injected by spying on `PointsService.grant` and `WalletHoldService.refund`
 * (the only seams the delivery calls), letting every other call through.
 */

jest.setTimeout(120_000);

const DAY = 86_400_000;
const config = loadPlansConfig();
const byPrice = [...config.tiers].sort((a, b) => a.price.kobo - b.price.kobo);
const small = byPrice[0];
const big = byPrice[byPrice.length - 1];
const RICH = 100 * priceIn(big.price, 'NGN');

const failures: Array<[string, () => Error]> = [
  ['a plain error', () => new Error('connection reset by peer')],
  [
    'a Prisma serialization failure (P2034)',
    () =>
      new Prisma.PrismaClientKnownRequestError(
        'Transaction failed due to a write conflict or a deadlock.',
        { code: 'P2034', clientVersion: 'test' },
      ),
  ],
  [
    'a points conflict',
    () =>
      new PointsError(
        'points_grant_conflict',
        'That reference was used for another amount.',
      ),
  ],
];

describe('A delivery that fails for an ordinary reason is retried, never refunded (TIER-03 round 3, R2-D1)', () => {
  let h: TierHarness;
  let call: ReturnType<typeof api>;
  let points: PointsService;
  let holds: WalletHoldService;
  let realGrant: PointsService['grant'];
  let realRefund: WalletHoldService['refund'];

  beforeAll(async () => {
    h = await bootTierApp('t03f');
    call = api(h);
    points = h.get(PointsService);
    holds = h.get(WalletHoldService);
    // Taken before any spy replaces them.
    realGrant = points.grant.bind(points);
    realRefund = holds.refund.bind(holds);
    h.wallets.kobo.set(MERCHANT_ACCOUNT, 1_000_000_000);
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(() => {
    h.wallets.mode = 'live';
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  /**
   * `PointsService.grant` rejects for the given source until `off()` (or for
   * `times` calls); every other call goes through. One payment sweep tries a
   * delivery more than once (at the completion, then again when the delivery
   * is due on the sweep's clock), so a fault meant to span "the first sweep"
   * stays on until the test turns it off.
   */
  const failGrant = (source: string, error: Error, times = Infinity) => {
    let failed = 0;
    let on = true;
    jest.spyOn(points, 'grant').mockImplementation(async (input, opts) => {
      if (on && input.source === source && failed < times) {
        failed += 1;
        throw error;
      }
      return realGrant(input, opts);
    });
    return {
      failures: () => failed,
      off: () => {
        on = false;
      },
    };
  };

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
    return body<PlanPurchaseView>(await call.buy(p, bodyFor(t, q))).data!;
  }
  /** The answer is lost: the provider took the money and the answer never came, so the sweep delivers. */
  async function purchaseWithLostAnswer(p: Person, t: Terms) {
    const q = await quoted(p, t);
    h.wallets.mode = 'timeout';
    const res = await call.buy(p, bodyFor(t, q));
    h.wallets.mode = 'live';
    const view = body<PlanPurchaseView>(res).data!;
    expect(view.status).toBe('pending');
    return view;
  }
  const read = async (p: Person, id: string) =>
    body<PlanPurchaseView>(await call.read(p, id)).data!;
  const paymentRow = (id: string) =>
    h.prisma.walletPayment.findUniqueOrThrow({ where: { id } });
  const endTier = (p: Person) =>
    h.prisma.makerTier.update({
      where: { wawuUserId: p.id },
      data: {
        activeFrom: new Date(Date.now() - 20 * DAY),
        activeUntil: new Date(Date.now() - 1000),
      },
    });
  const refundsTo = (p: Person) =>
    h.wallets.sends.filter(
      (s) => s.from === MERCHANT_ACCOUNT && s.to === p.accountNumber,
    );
  const holdsOf = (p: Person) =>
    h.prisma.walletHold.count({ where: { payerWawuUserId: p.id } });
  const lotsOf = (p: Person) =>
    h.prisma.pointLot.count({ where: { wawuUserId: p.id } });

  /** What a failed grant leaves: nothing granted, nothing paid back, the payment still claimed. */
  const nothingGrantedNothingRefunded = async (p: Person, id: string) => {
    expect(await holdsOf(p)).toBe(0);
    expect(refundsTo(p)).toHaveLength(0);
    expect(
      await h.prisma.makerPurchase.count({ where: { wawuUserId: p.id } }),
    ).toBe(0);
    expect(
      await h.prisma.makerTier.count({ where: { wawuUserId: p.id } }),
    ).toBe(0);
    expect(
      await h.prisma.personBilling.count({ where: { wawuUserId: p.id } }),
    ).toBe(0);
    expect(await h.prisma.eventPass.count({ where: { purchaseRef: id } })).toBe(
      0,
    );
    expect(await lotsOf(p)).toBe(0);
    const row = await paymentRow(id);
    expect(row).toMatchObject({ status: 'completed', fulfilledAt: null });
    expect(row.openKey).not.toBeNull();
    expect(row.deliveryAttempts).toBeGreaterThanOrEqual(1);
  };

  it.each(failures)(
    'the points lot of the plan fails with %s: nothing is refunded or granted, the purchase says it is being finished, and the retry grants once',
    async (_name, make) => {
      const p = await h.buyer(RICH);
      const pending = await purchaseWithLostAnswer(p, {
        kind: 'tier',
        tierId: small.id,
      });
      const fault = failGrant('tier_bonus', make());

      await h.sweepLater();
      expect(fault.failures()).toBeGreaterThanOrEqual(1);
      await nothingGrantedNothingRefunded(p, pending.id);
      expect(await read(p, pending.id)).toMatchObject({
        status: 'pending',
        statusMessage: FINISHING_MESSAGE,
        grant: null,
      });

      // The fault clears; the next sweep delivers the payment: granted exactly once, never paid back.
      fault.off();
      await h.sweepLater(70 * 60_000);
      const done = await read(p, pending.id);
      expect(done.status).toBe('paid');
      expect(done.grant).not.toBeNull();
      expect(await holdsOf(p)).toBe(0);
      expect(refundsTo(p)).toHaveLength(0);
      expect(
        await h.prisma.makerPurchase.count({ where: { wawuUserId: p.id } }),
      ).toBe(1);
      expect(
        await h.prisma.pointLot.count({
          where: { wawuUserId: p.id, source: 'tier_bonus' },
        }),
      ).toBe(1);
      expect(
        await h.prisma.eventPass.count({ where: { purchaseRef: pending.id } }),
      ).toBe(1);
      expect(await paymentRow(pending.id)).toMatchObject({
        status: 'completed',
        openKey: null,
      });

      // Swept again: nothing more is granted or moved.
      await h.sweepLater(70 * 60_000);
      expect(
        await h.prisma.makerPurchase.count({ where: { wawuUserId: p.id } }),
      ).toBe(1);
      expect(await lotsOf(p)).toBe(1);
      expect(refundsTo(p)).toHaveLength(0);
    },
  );

  it('the bump lot fails after the plan was written: the whole grant is rolled back (no tier, no pass, no first lot), nothing is paid back, and the retry grants both lots once', async () => {
    const p = await h.buyer(RICH);
    const pending = await purchaseWithLostAnswer(p, {
      kind: 'tier',
      tierId: small.id,
      bump: true,
    });
    const fault = failGrant('bump', new Error('connection reset by peer'));

    await h.sweepLater();
    expect(fault.failures()).toBeGreaterThanOrEqual(1);
    await nothingGrantedNothingRefunded(p, pending.id);

    fault.off();
    await h.sweepLater(70 * 60_000);
    const done = await read(p, pending.id);
    expect(done.status).toBe('paid');
    expect(await holdsOf(p)).toBe(0);
    expect(refundsTo(p)).toHaveLength(0);
    expect(await lotsOf(p)).toBe(2);
    expect(
      await h.prisma.makerPurchase.count({ where: { wawuUserId: p.id } }),
    ).toBe(1);
  });

  it('an upgrade whose points lot fails is not refunded either: the same plain failure, then granted once', async () => {
    const p = await h.buyer(RICH);
    expect((await purchase(p, { kind: 'tier', tierId: small.id })).status).toBe(
      'paid',
    );
    const lots = await lotsOf(p);
    const pending = await purchaseWithLostAnswer(p, {
      kind: 'upgrade',
      tierId: big.id,
    });
    const fault = failGrant('tier_bonus', new Error('deadlock detected'));

    await h.sweepLater();
    expect(fault.failures()).toBeGreaterThanOrEqual(1);
    expect(await holdsOf(p)).toBe(0);
    expect(refundsTo(p)).toHaveLength(0);
    expect(await lotsOf(p)).toBe(lots);
    expect(
      await h.prisma.makerPurchase.count({ where: { paymentRef: pending.id } }),
    ).toBe(0);
    expect(await paymentRow(pending.id)).toMatchObject({
      status: 'completed',
      fulfilledAt: null,
    });

    fault.off();
    await h.sweepLater(70 * 60_000);
    expect((await read(p, pending.id)).status).toBe('paid');
    expect(await holdsOf(p)).toBe(0);
    expect(refundsTo(p)).toHaveLength(0);
    expect(await lotsOf(p)).toBe(lots + 1);
  });

  it('called directly (as the payment service calls it), a failing grant makes the delivery throw, and the next call grants once with no hold', async () => {
    const p = await h.buyer(0);
    const paymentId = randomUUID();
    await h.prisma.walletPayment.create({
      data: {
        id: paymentId,
        payerWawuUserId: p.id,
        kind: 'tier',
        targetId: `tier-${small.id}`,
        title: 'A plan',
        payeeWawuUserId: null,
        priceKobo: 12_345,
        providerFeeKobo: 0,
        wawuFeeKobo: 0,
        totalKobo: 12_345,
        payeeShareKobo: 0,
        wawuShareKobo: 12_345,
        customerReference: `wawu-pay-${paymentId}`,
        payerAccountNumber: p.accountNumber,
        merchantAccountNumber: MERCHANT_ACCOUNT,
        status: 'completed',
        completedAt: new Date(),
      },
    });
    const c: CompletedPayment = {
      paymentId,
      payerWawuUserId: p.id,
      kind: 'tier',
      targetId: `tier-${small.id}`,
      priceKobo: 12_345,
      payeeWawuUserId: null,
      note: null,
      holdId: null,
    };
    const deliver = () => h.registry.get('tier')!.onCompleted!(c);
    failGrant('tier_bonus', new Error('connection reset by peer'), 1);

    await expect(deliver()).rejects.toThrow('connection reset by peer');
    expect(await holdsOf(p)).toBe(0);
    expect(refundsTo(p)).toHaveLength(0);
    expect(
      await h.prisma.makerPurchase.count({ where: { wawuUserId: p.id } }),
    ).toBe(0);
    expect(await lotsOf(p)).toBe(0);

    await deliver();
    expect(await holdsOf(p)).toBe(0);
    expect(
      await h.prisma.makerPurchase.count({ where: { wawuUserId: p.id } }),
    ).toBe(1);
    expect(await lotsOf(p)).toBe(1);
    await deliver();
    expect(await lotsOf(p)).toBe(1);
    expect(refundsTo(p)).toHaveLength(0);
  });

  describe('the refund call', () => {
    /** The verifier's case: Verify ends while the upgrade confirms, so the payment is refused and paid back. */
    const refusedUpgrade = async () => {
      const p = await h.buyer(RICH);
      expect(
        (await purchase(p, { kind: 'tier', tierId: small.id })).status,
      ).toBe('paid');
      const pending = await purchaseWithLostAnswer(p, {
        kind: 'upgrade',
        tierId: big.id,
      });
      await endTier(p);
      return { p, pending };
    };

    it('a refund that throws is not swallowed: the delivery fails, the hold has no action yet, the payment stays claimed, and the retry sends the money once', async () => {
      const { p, pending } = await refusedUpgrade();
      const diff = priceIn(big.price, 'NGN') - priceIn(small.price, 'NGN');
      const spy = jest
        .spyOn(holds, 'refund')
        .mockRejectedValue(new Error('the wallet provider is down'));

      await h.sweepLater();
      expect(spy).toHaveBeenCalled();
      // The hold was written (the decision), nothing was asked of the provider.
      expect(
        await h.prisma.walletHold.findUniqueOrThrow({
          where: { paymentId: pending.id },
        }),
      ).toMatchObject({ action: null, status: 'held' });
      expect(refundsTo(p)).toHaveLength(0);
      // The payment is NOT marked delivered and keeps its claim, so the sweep tries again.
      const claimed = await paymentRow(pending.id);
      expect(claimed).toMatchObject({ status: 'completed', fulfilledAt: null });
      expect(claimed.openKey).not.toBeNull();
      expect(claimed.deliveryAttempts).toBeGreaterThanOrEqual(1);
      expect(
        await h.prisma.makerPurchase.count({
          where: { paymentRef: pending.id },
        }),
      ).toBe(0);

      // The provider is back; the retry finishes it: one refund of the price,
      // from WAWU's account to the payer.
      spy.mockRestore();
      await h.sweepLater(70 * 60_000);
      expect(
        await h.prisma.walletHold.findUniqueOrThrow({
          where: { paymentId: pending.id },
        }),
      ).toMatchObject({
        action: 'refund',
        status: 'refunded',
        refundedKobo: BigInt(diff),
      });
      expect(refundsTo(p)).toHaveLength(1);
      expect(refundsTo(p)[0]).toMatchObject({ amountKobo: diff });
      const delivered = await paymentRow(pending.id);
      expect(delivered.fulfilledAt).not.toBeNull();
      expect(delivered.openKey).toBeNull();
      expect((await read(p, pending.id)).status).toBe('refunded');

      // Swept again: still one refund, one hold.
      await h.sweepLater(70 * 60_000);
      await holds.sweep(new Date(Date.now() + 3 * 3_600_000));
      expect(refundsTo(p)).toHaveLength(1);
      expect(await holdsOf(p)).toBe(1);
    });

    it('called directly, a refund that rejects once makes the delivery throw, and the next call sends the money once', async () => {
      const p = await h.buyer(RICH);
      expect(
        (await purchase(p, { kind: 'tier', tierId: small.id })).status,
      ).toBe('paid');
      const paymentId = randomUUID();
      const targetId = `upgrade-${small.id}-${big.id}`;
      const priceKobo = 400_000;
      await h.prisma.walletPayment.create({
        data: {
          id: paymentId,
          payerWawuUserId: p.id,
          kind: 'tier',
          targetId,
          title: 'A plan',
          payeeWawuUserId: null,
          priceKobo,
          providerFeeKobo: 0,
          wawuFeeKobo: 0,
          totalKobo: priceKobo,
          payeeShareKobo: 0,
          wawuShareKobo: priceKobo,
          customerReference: `wawu-pay-${paymentId}`,
          payerAccountNumber: p.accountNumber,
          merchantAccountNumber: MERCHANT_ACCOUNT,
          status: 'completed',
          completedAt: new Date(),
        },
      });
      await endTier(p);
      const c: CompletedPayment = {
        paymentId,
        payerWawuUserId: p.id,
        kind: 'tier',
        targetId,
        priceKobo,
        payeeWawuUserId: null,
        note: null,
        holdId: null,
      };
      const deliver = () => h.registry.get('tier')!.onCompleted!(c);
      const spy = jest
        .spyOn(holds, 'refund')
        .mockRejectedValueOnce(new Error('the wallet provider is down'));

      await expect(deliver()).rejects.toThrow('the wallet provider is down');
      expect(refundsTo(p)).toHaveLength(0);
      expect(
        await h.prisma.walletHold.findUniqueOrThrow({ where: { paymentId } }),
      ).toMatchObject({ action: null, status: 'held' });

      await deliver();
      expect(spy).toHaveBeenCalledTimes(2);
      expect(refundsTo(p)).toHaveLength(1);
      expect(
        await h.prisma.walletHold.findUniqueOrThrow({ where: { paymentId } }),
      ).toMatchObject({ action: 'refund', status: 'refunded' });
      await deliver();
      expect(refundsTo(p)).toHaveLength(1);
    });
  });

  it('the spies are the real seams: a call that is let through is the real method', () => {
    // A guard on the spec itself: if the services were renamed the spies above
    // would spy on nothing and every test here would pass for the wrong reason.
    expect(typeof realGrant).toBe('function');
    expect(typeof realRefund).toBe('function');
    expect(typeof points.grant).toBe('function');
    expect(typeof holds.refund).toBe('function');
  });
});
