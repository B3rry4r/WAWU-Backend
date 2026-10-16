import {
  body,
  NuvionAdapterCashOut,
  type Person,
} from '../../../../test/points/cash-out-harness';
import { loadPlansConfig } from '../../../plans/plans-config';
import type { PointsConversionView } from '../points-convert-view.type';

/**
 * Convert points to cash (task POINTS-04, R-42, R-43) over the REAL Nuvion
 * adapter and NUV-05's book area, with Nuvion's documented HTTP API as a
 * socket stand-in (`test/nuvion/book-standin.ts`): book transfers answered
 * `pending` first, `applicable_fee` on top, no lookup by our reference (the
 * adapter keeps the id of every answer it read and, when an answer was lost,
 * walks the payer's transfers for our `unique_reference`). WAWU's own account
 * is the operational account. An outbound guard fails the spec if anything
 * leaves the machine.
 */

jest.setTimeout(300_000);

const RATE = loadPlansConfig().cashOut.per1000Points.kobo;
const cashFor = (points: number) => Math.floor((points * RATE) / 1000);
const bandFee = (amount: number) => (amount >= 500_000 ? 2_500 : 1_500);

describe('Convert points to cash (POINTS-04) over the real Nuvion adapter and a Nuvion stand-in', () => {
  const h = new NuvionAdapterCashOut();

  beforeAll(async () => {
    await h.boot();
  });
  afterAll(async () => {
    expect(h.guard.violations).toEqual([]);
    expect(h.fintavaHits).toEqual([]);
    await h.close();
  });
  beforeEach(() => {
    h.book.mode = 'successful';
    h.book.extraKobo = 0;
    h.book.fundOperational(50_000_000);
  });

  async function funded(points: number): Promise<Person> {
    const p = await h.person(0);
    await h.lots(p, [{ points, days: 60 }]);
    return p;
  }

  it("converts by one book transfer out of the operational account, with the adapter's own log", async () => {
    const p = await h.person(0);
    const [soon, late] = await h.lots(p, [
      { points: 700, days: 10 },
      { points: 1500, days: 90 },
    ]);
    const before = h.merchantBalance();
    const res = await h.convert(p, 1300);
    expect(res.status).toBe(201);
    const view = body<PointsConversionView>(res).data!;
    expect(view).toMatchObject({
      status: 'completed',
      points: 1300,
      cashKobo: cashFor(1300),
    });
    const sent = h.sendsOf(view.reference);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      account_id: h.book.operational.id,
      amount: cashFor(1300),
      applicable_fee: bandFee(cashFor(1300)),
      unique_reference: view.reference,
      payment_type: 'book-transfer',
      status: 'successful',
    });
    expect(h.balanceOf(p)).toBe(cashFor(1300));
    // WAWU's account paid the amount and Nuvion's charge (R-31).
    expect(before - h.merchantBalance()).toBe(
      cashFor(1300) + bandFee(cashFor(1300)),
    );
    const lots = await h.prisma.pointLot.findMany({
      where: { id: { in: [soon, late] } },
      orderBy: { expiresAt: 'asc' },
    });
    expect(lots.map((l) => l.remaining)).toEqual([0, 1500 - 600]);
    const { conversion, hold } = await h.state(view.id);
    expect(conversion).toMatchObject({ status: 'paid', provider: 'nuvion' });
    expect(hold?.state).toBe('committed');
    // The adapter's log of the transfer it sent, found by our reference.
    expect(
      await h.prisma.nuvionBookTransfer.count({
        where: { reference: view.reference },
      }),
    ).toBe(1);
    expect(await h.ledgerRows(view.reference)).toHaveLength(2);
  });

  it('Nuvion answers pending first: the points stay held until it says successful, one transfer', async () => {
    const p = await funded(3000);
    h.book.mode = 'pending';
    const view = body<PointsConversionView>(await h.convert(p, 2000)).data!;
    expect(view.status).toBe('pending');
    expect(await h.points.balanceOf(p.id)).toBe(1000);
    await h.cashOut.sweep(h.later(10 * 60_000));
    expect((await h.state(view.id)).conversion.status).toBe('held');
    expect(h.sendsOf(view.reference)).toHaveLength(1);

    h.book.settle(view.reference, 'successful');
    await h.cashOut.sweep(h.later(30 * 60_000));
    const st = await h.state(view.id);
    expect(st.conversion.status).toBe('paid');
    expect(st.hold?.state).toBe('committed');
    expect(h.sendsOf(view.reference)).toHaveLength(1);
    expect(h.balanceOf(p)).toBe(cashFor(2000));
    expect(await h.points.balanceOf(p.id)).toBe(1000);
  });

  it("a lost answer after Nuvion took the transfer is found by walking the payer's transfers and landed once", async () => {
    const p = await funded(3000);
    h.book.loseAnswerNext(true);
    const view = body<PointsConversionView>(await h.convert(p, 1800)).data!;
    expect(view.status).toBe('pending');
    expect(h.sendsOf(view.reference)).toHaveLength(1);
    await h.cashOut.sweep(h.later(3 * 3_600_000));
    const st = await h.state(view.id);
    expect(st.conversion.status).toBe('paid');
    expect(st.hold?.state).toBe('committed');
    expect(h.sendsOf(view.reference)).toHaveLength(1);
    expect(h.balanceOf(p)).toBe(cashFor(1800));
  });

  it('a system error before Nuvion made anything is asked about, held, and never sent again', async () => {
    const p = await funded(3000);
    h.book.systemErrorNext({ created: false, status: 503 });
    const view = body<PointsConversionView>(await h.convert(p, 1000)).data!;
    expect(view.status).toBe('pending');
    let t = Date.now();
    for (let i = 0; i < 3; i += 1) {
      t += 5 * 3_600_000;
      await h.cashOut.sweep(new Date(t));
    }
    const st = await h.state(view.id);
    expect(st.conversion.status).toBe('held');
    expect(st.hold?.state).toBe('held');
    expect(h.sendsOf(view.reference)).toHaveLength(0);
    expect(
      h.book.createRequests.filter(
        (r) => r.unique_reference === view.reference,
      ),
    ).toHaveLength(1);
  });

  it("Nuvion refuses because WAWU's own account is short: nothing moved, the points are back", async () => {
    const p = await h.person(0);
    const ids = await h.lots(p, [
      { points: 900, days: 20 },
      { points: 900, days: 80 },
    ]);
    h.book.fundOperational(100);
    const view = body<PointsConversionView>(await h.convert(p, 1500)).data!;
    expect(view.status).toBe('failed');
    expect(h.sendsOf(view.reference)).toHaveLength(0);
    const lots = await h.prisma.pointLot.findMany({
      where: { id: { in: ids } },
      orderBy: { expiresAt: 'asc' },
    });
    expect(lots.map((l) => l.remaining)).toEqual([900, 900]);
    const { conversion, hold } = await h.state(view.id);
    expect(conversion.status).toBe('cancelled');
    expect(hold?.state).toBe('released');
  });

  it('Nuvion fails the transfer after accepting it: the points go back and the operational account is whole', async () => {
    const p = await funded(2500);
    const before = h.merchantBalance();
    h.book.mode = 'pending';
    const view = body<PointsConversionView>(await h.convert(p, 1500)).data!;
    expect(view.status).toBe('pending');
    h.book.settle(view.reference, 'failed');
    await h.cashOut.sweep(h.later(30 * 60_000));
    const st = await h.state(view.id);
    expect(st.conversion.status).toBe('cancelled');
    expect(st.hold?.state).toBe('released');
    expect(await h.points.balanceOf(p.id)).toBe(2500);
    expect(h.balanceOf(p)).toBe(0);
    expect(h.merchantBalance()).toBe(before);
  });

  it('another amount than asked is never read as a receipt: the points stay held, nothing lands, and it is never sent again', async () => {
    const p = await funded(2500);
    h.book.extraKobo = 100;
    try {
      const view = body<PointsConversionView>(await h.convert(p, 1000)).data!;
      // The adapter itself refuses the answer (it will not keep the id of a
      // transfer of another size), so the outcome is unknown, not a payment.
      expect(view.status).toBe('pending');
      const sent = h.book.createRequests.length;
      let st = await h.state(view.id);
      expect(st.conversion.status).toBe('held');
      expect(st.hold?.state).toBe('held');
      expect(await h.ledgerRows(view.reference)).toHaveLength(0);
      // Asked about again, through the days, it never lands and never goes
      // out a second time; after the review window a person is asked to look.
      await h.cashOut.sweep(h.later(30 * 60_000));
      await h.cashOut.sweep(h.later(80 * 3_600_000));
      st = await h.state(view.id);
      expect(st.conversion.status).toBe('held');
      expect(st.hold?.state).toBe('held');
      expect(st.conversion.reviewSince).not.toBeNull();
      expect(await h.ledgerRows(view.reference)).toHaveLength(0);
      expect(h.book.createRequests).toHaveLength(sent);
      expect(await h.points.balanceOf(p.id)).toBe(1500);
    } finally {
      h.book.extraKobo = 0;
    }
  });
});
