import { Client } from 'pg';
import {
  api,
  bootTierApp,
  type Person,
  type TierHarness,
} from '../../../../test/plans/tier-purchase-harness';
import { body } from '../../../../test/payments/poll-helpers';
import { loadPlansConfig, priceIn } from '../../plans-config';
import type { MyTierView } from '../../plans-view.type';
import type {
  PlanPurchaseQuoteView,
  PlanPurchaseView,
} from '../plan-purchase-view.type';

/**
 * TIER-03 round 2: three things the grant says and no test pinned.
 *
 * - D2 and D4 (the verifier's V29, V30, V31): the extra products a person
 *   PAID for stay on every new period. A renewal of a running tier, an
 *   upgrade, a renewal of an ended tier and a first purchase after the tier
 *   ended all keep them (`MakerTier.extraProducts`), so `productsAllowed`
 *   (the tier's products plus the extras) never falls because a plan was
 *   bought. (TIER-02's offers ignore an ended tier's extras: they promise less
 *   than the grant gives, the safe side; TIER-04 aligns them.)
 * - D3 (V14): the grant is last. In the purchase's transaction no write to
 *   anything but the points follows the first points write, so the person's
 *   points lock (POINTS-01) is held for the shortest time and nothing waits
 *   on a provider while it is held.
 * - N7: the database refuses a first-purchase billing row with no purchase.
 */

jest.setTimeout(120_000);

const DAY = 86_400_000;
const config = loadPlansConfig();
const byPrice = [...config.tiers].sort((a, b) => a.price.kobo - b.price.kobo);
const small = byPrice[0];
const middle = byPrice[1];
const big = byPrice[byPrice.length - 1];
const RICH = 100 * priceIn(big.price, 'NGN');
const EXTRAS = 5;

describe('What a purchase leaves in place and the order it writes in (TIER-03 round 2)', () => {
  let h: TierHarness;
  let call: ReturnType<typeof api>;

  beforeAll(async () => {
    h = await bootTierApp('t03g');
    call = api(h);
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
  async function purchase(p: Person, t: Terms) {
    const q = await call.quote(p, t);
    expect(q.status).toBe(200);
    const quote = body<PlanPurchaseQuoteView>(q).data!;
    const res = await call.buy(p, {
      kind: t.kind,
      tierId: t.tierId,
      ...(t.bump === undefined ? {} : { bump: t.bump }),
      method: 'wallet',
      expectedTotalKobo: quote.payment.totalKobo,
      quoteToken: quote.payment.quoteToken,
    });
    expect(res.status).toBe(201);
    const view = body<PlanPurchaseView>(res).data!;
    expect(view.status).toBe('paid');
    return view;
  }
  const tierOf = async (p: Person) =>
    body<MyTierView>(await call.tier(p)).data!;
  const rowOf = (p: Person) =>
    h.prisma.makerTier.findUniqueOrThrow({ where: { wawuUserId: p.id } });
  /** A tier already held, with extra products bought on top (TIER-04 will write them). */
  async function holder(
    tier: typeof small,
    opts: { running: boolean; extras?: number },
  ): Promise<Person> {
    const p = await h.buyer(RICH);
    await h.prisma.makerTier.create({
      data: {
        wawuUserId: p.id,
        tierId: tier.id,
        activeFrom: new Date(Date.now() - (opts.running ? 10 : 40) * DAY),
        activeUntil: new Date(Date.now() + (opts.running ? 20 : -1) * DAY),
        productsIncluded: tier.products,
        extraProducts: opts.extras ?? EXTRAS,
        pointsIncluded: tier.bonusPoints,
        voiceIntroIncluded: false,
      },
    });
    return p;
  }

  // ---------------------------------------------------------------------------
  // D2 and D4: the extras a person paid for stay on every new period
  // ---------------------------------------------------------------------------

  it('a renewal of a running tier keeps the extra products', async () => {
    const p = await holder(small, { running: true });
    expect((await tierOf(p)).productsAllowed).toBe(small.products + EXTRAS);
    await purchase(p, { kind: 'renew', tierId: small.id });
    expect((await rowOf(p)).extraProducts).toBe(EXTRAS);
    expect((await tierOf(p)).productsAllowed).toBe(small.products + EXTRAS);
  });

  it('an upgrade keeps the extra products: the bigger tier plus the extras', async () => {
    const p = await holder(small, { running: true });
    await purchase(p, { kind: 'upgrade', tierId: big.id });
    const row = await rowOf(p);
    expect(row).toMatchObject({
      tierId: big.id,
      productsIncluded: big.products,
      extraProducts: EXTRAS,
    });
    expect((await tierOf(p)).productsAllowed).toBe(big.products + EXTRAS);
  });

  it('a renewal of an ended tier keeps the extra products', async () => {
    const p = await holder(small, { running: false });
    expect((await tierOf(p)).state).toBe('ended');
    await purchase(p, { kind: 'renew', tierId: small.id });
    expect((await rowOf(p)).extraProducts).toBe(EXTRAS);
    const t = await tierOf(p);
    expect(t.state).toBe('active');
    expect(t.productsAllowed).toBe(small.products + EXTRAS);
  });

  it('a first purchase after the tier ended keeps the extra products, whatever tier it buys', async () => {
    const p = await holder(big, { running: false });
    await purchase(p, { kind: 'tier', tierId: middle.id });
    const row = await rowOf(p);
    expect(row).toMatchObject({
      tierId: middle.id,
      productsIncluded: middle.products,
      extraProducts: EXTRAS,
    });
    expect((await tierOf(p)).productsAllowed).toBe(middle.products + EXTRAS);
  });

  it('a first-ever purchase starts with no extras', async () => {
    const p = await h.buyer(RICH);
    await purchase(p, { kind: 'tier', tierId: small.id });
    expect((await rowOf(p)).extraProducts).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // D3: the grant is last
  // ---------------------------------------------------------------------------

  /** Every statement the database sees while `work` runs, with the connection it ran on. */
  async function statementsDuring(
    work: () => Promise<void>,
  ): Promise<Array<{ pid: number; sql: string }>> {
    const seen: Array<{ pid: number; sql: string }> = [];
    // The spy calls it back with the client it was called on.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const original = Client.prototype.query;
    const spy = jest
      .spyOn(Client.prototype, 'query')
      .mockImplementation(function (this: Client, ...args: unknown[]) {
        const first = args[0];
        const sql =
          typeof first === 'string'
            ? first
            : (first as { text?: string } | undefined)?.text;
        if (sql)
          seen.push({
            pid: (this as unknown as { processID: number }).processID,
            sql,
          });
        return (original as (...a: unknown[]) => unknown).apply(
          this,
          args,
        ) as never;
      });
    try {
      await work();
    } finally {
      spy.mockRestore();
    }
    return seen;
  }
  const WRITE =
    /^\s*(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"public"\."(\w+)"/i;

  /**
   * The tables written by the transaction that inserted the purchase row, in
   * order. Its statements are those on the same connection between its BEGIN
   * and the next COMMIT or ROLLBACK.
   */
  function writesOfPurchaseTransaction(
    seen: Array<{ pid: number; sql: string }>,
  ): string[] {
    const at = seen.findIndex((s) =>
      /^\s*INSERT\s+INTO\s+"public"\."MakerPurchase"/i.test(s.sql),
    );
    expect(at).toBeGreaterThan(-1);
    const pid = seen[at].pid;
    let begin = at;
    while (
      begin > 0 &&
      !(seen[begin].pid === pid && /^BEGIN/i.test(seen[begin].sql))
    )
      begin -= 1;
    expect(/^BEGIN/i.test(seen[begin].sql)).toBe(true);
    const writes: string[] = [];
    let ended = false;
    for (let i = begin + 1; i < seen.length; i += 1) {
      if (seen[i].pid !== pid) continue;
      if (/^(COMMIT|ROLLBACK)/i.test(seen[i].sql)) {
        ended = /^COMMIT/i.test(seen[i].sql);
        break;
      }
      const w = WRITE.exec(seen[i].sql);
      if (w) writes.push(w[1]);
    }
    expect(ended).toBe(true);
    return writes;
  }

  it('the points are written last: after the first points write, the purchase transaction writes nothing but points', async () => {
    const cases: Array<[string, Terms, () => Promise<Person>]> = [
      [
        'a first purchase with the bump',
        { kind: 'tier', tierId: middle.id, bump: true },
        () => h.buyer(RICH),
      ],
      [
        'a first purchase',
        { kind: 'tier', tierId: small.id },
        () => h.buyer(RICH),
      ],
      [
        'a renewal with the bump',
        { kind: 'renew', tierId: small.id, bump: true },
        () => holder(small, { running: true }),
      ],
      [
        'an upgrade with the bump',
        { kind: 'upgrade', tierId: big.id, bump: true },
        () => holder(small, { running: true }),
      ],
      [
        'an upgrade',
        { kind: 'upgrade', tierId: big.id },
        () => holder(small, { running: true }),
      ],
    ];
    for (const [name, terms, who] of cases) {
      const p = await who();
      const seen = await statementsDuring(async () => {
        await purchase(p, terms);
      });
      const writes = writesOfPurchaseTransaction(seen);
      const firstPoints = writes.findIndex((t) => t.startsWith('Point'));
      // The grant did write points, and the purchase row and the tier before them.
      expect({ name, firstPoints: firstPoints > -1 }).toEqual({
        name,
        firstPoints: true,
      });
      expect(writes).toContain('MakerPurchase');
      expect(writes).toContain('MakerTier');
      expect(writes.indexOf('MakerPurchase')).toBeLessThan(firstPoints);
      // ... and after the first points write nothing else is written.
      const after = writes.slice(firstPoints);
      expect({
        name,
        after: after.filter((t) => !t.startsWith('Point')),
      }).toEqual({
        name,
        after: [],
      });
    }
  });

  // ---------------------------------------------------------------------------
  // N7: a first-purchase billing row names its purchase
  // ---------------------------------------------------------------------------

  it('the database refuses a first-purchase billing row with no purchase, and accepts the others', async () => {
    const p = await h.walletless();
    await expect(
      h.prisma.personBilling.create({
        data: { wawuUserId: p.id, currency: 'NGN', fixedBy: 'first_purchase' },
      }),
    ).rejects.toThrow(/PersonBilling_firstPurchaseRef_check|check constraint/i);
    expect(
      await h.prisma.personBilling.count({ where: { wawuUserId: p.id } }),
    ).toBe(0);
    // Support fixes a currency by hand, with no purchase.
    await h.prisma.personBilling.create({
      data: { wawuUserId: p.id, currency: 'USD', fixedBy: 'support' },
    });
    const q = await h.walletless();
    await h.prisma.personBilling.create({
      data: {
        wawuUserId: q.id,
        currency: 'NGN',
        fixedBy: 'first_purchase',
        purchaseRef: `pay-${q.id}`,
      },
    });
    // A row cannot lose its purchase afterwards either.
    await expect(
      h.prisma.personBilling.update({
        where: { wawuUserId: q.id },
        data: { purchaseRef: null },
      }),
    ).rejects.toThrow(/check constraint/i);
  });
});
