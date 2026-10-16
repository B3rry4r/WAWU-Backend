import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  body,
  FintavaCashOut,
  liveFee,
  MERCHANT_ACCOUNT,
  type Person,
  PIN,
  until,
} from '../../../../test/points/cash-out-harness';
import { loadPlansConfig } from '../../../plans/plans-config';
import type {
  PointsConversionView,
  PointsConvertQuoteView,
} from '../points-convert-view.type';

/**
 * Convert points to cash (task POINTS-04, R-43, R-31) over HTTP, on the
 * Fintava adapter: the real MoneyModule and PointsConvertModule, a real
 * database, real RS256 tokens, and the real Fintava client over a socket to
 * FintavaDouble. WAWU's own account is Fintava's merchant wallet; the double
 * charges the dashboard's balance-transfer rate on every send out of it.
 *
 * The rate and the minimum are read from the config here, never written: the
 * specs compute what they expect from `loadPlansConfig()`.
 */

jest.setTimeout(300_000);

const config = loadPlansConfig();
const RATE = config.cashOut.per1000Points.kobo;
const MIN = config.cashOut.minimumPoints;
/** The test's own sum: the cash for some points, rounded down. */
const cashFor = (points: number) => Math.floor((points * RATE) / 1000);

describe('Convert points to cash (POINTS-04) on Fintava', () => {
  const h = new FintavaCashOut();

  beforeAll(async () => {
    await h.boot();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(() => {
    h.wallets.mode = 'live';
    h.wallets.gate = null;
    h.wallets.frozen.clear();
    h.wallets.arrived = 0;
    h.wallets.kobo.set(MERCHANT_ACCOUNT, 50_000_000);
  });

  /** What must not change when a request is refused before the PIN. */
  async function snapshot(p: Person) {
    const pin = await h.prisma.transactionPin.findUnique({
      where: { wawuUserId: p.id },
    });
    return {
      balance: await h.points.balanceOf(p.id),
      conversions: await h.prisma.pointConversion.count({
        where: { wawuUserId: p.id },
      }),
      holds: await h.prisma.pointHold.count({ where: { wawuUserId: p.id } }),
      ledger: await h.prisma.pointLedger.count({
        where: { wawuUserId: p.id },
      }),
      keys: await h.prisma.moneyIdempotencyKey.count({
        where: { wawuUserId: p.id },
      }),
      failedTries: pin?.failedTries ?? 0,
      providerRequests: h.wallets.arrived,
      wallet: h.balanceOf(p),
      merchant: h.merchantBalance(),
    };
  }

  const lotRows = (ids: string[]) =>
    h.prisma.pointLot.findMany({
      where: { id: { in: ids } },
      orderBy: { expiresAt: 'asc' },
    });

  // -------------------------------------------------------------------------
  // The task's capability checks
  // -------------------------------------------------------------------------

  it('check 1: points convert at the config rate, leave the soonest-ending lots once, and the cash lands in the wallet once', async () => {
    const p = await h.person(0);
    const [soon, later] = await h.lots(p, [
      { points: 600, days: 30 },
      { points: 900, days: 90 },
    ]);
    const merchantBefore = h.merchantBalance();

    const res = await h.convert(p, 1200);
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBeUndefined();
    const view = body<PointsConversionView>(res).data!;
    const cash = cashFor(1200);
    expect(view).toMatchObject({
      status: 'completed',
      currency: 'NGN',
      points: 1200,
      cashKobo: cash,
      statusMessage: null,
      failureReason: null,
    });
    expect(view.reference).toBe(`wawu-pts-${view.id}`);
    expect(view.completedAt).not.toBeNull();

    // The cash left WAWU's own account once and reached the wallet once; the
    // provider's charge on the move is WAWU's (R-31): the person got it whole.
    const sends = h.sendsOf(view.reference);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      from: MERCHANT_ACCOUNT,
      to: p.accountNumber,
      amountKobo: cash,
      feeKobo: liveFee(cash),
    });
    expect(h.balanceOf(p)).toBe(cash);
    expect(merchantBefore - h.merchantBalance()).toBe(cash + liveFee(cash));
    expect(
      h.wallets.sends.filter((s) => s.to === p.accountNumber),
    ).toHaveLength(1);

    // The points left the soonest-ending lot first, then the next.
    const [a, b] = await lotRows([soon, later]);
    expect(a.id).toBe(soon);
    expect(a.remaining).toBe(0);
    expect(b.remaining).toBe(900 - (1200 - 600));
    expect(await h.points.balanceOf(p.id)).toBe(300);

    // The conversion is paid, and its hold is spent (committed), not given back.
    const { conversion, hold } = await h.state(view.id);
    expect(conversion).toMatchObject({
      status: 'paid',
      points: 1200,
      cashKobo: BigInt(cash),
      per1000PointsKobo: BigInt(RATE),
      merchantAccountNumber: MERCHANT_ACCOUNT,
      destinationAccountNumber: p.accountNumber,
      providerFeeKobo: BigInt(liveFee(cash)),
      customerReference: view.reference,
    });
    expect(conversion.settledAt).not.toBeNull();
    expect(hold).toMatchObject({ state: 'committed', quantity: 1200 });

    // PT5 reads it as spent on a conversion, newest first.
    const mine = body<{
      balance: number;
      movements: Array<{ points: number; label: string; pending: boolean }>;
    }>(await h.myPoints(p)).data!;
    expect(mine.balance).toBe(300);
    expect(mine.movements.slice(0, 2)).toEqual([
      expect.objectContaining({
        points: -600,
        label: 'Converted to cash',
        pending: false,
      }),
      expect.objectContaining({
        points: -600,
        label: 'Converted to cash',
        pending: false,
      }),
    ]);

    // GET by id reads the same conversion for its owner.
    const read = await h.read(p, view.id);
    expect(read.status).toBe(200);
    expect(read.headers['cache-control']).toBe('no-store');
    expect(body<PointsConversionView>(read).data).toEqual(view);
  });

  it("shows the cash as WAWU's movement in the ledger, with the purpose points_cash_out", async () => {
    const p = await h.person(0);
    await h.lots(p, [{ points: 2000, days: 60 }]);
    const view = body<PointsConversionView>(await h.convert(p, 1500)).data!;
    const rows = await h.ledgerRows(view.reference);
    expect(rows).toHaveLength(2);
    const [inn, out] = rows;
    expect(inn).toMatchObject({
      direction: 'in',
      walletKind: 'user',
      wawuUserId: p.id,
      accountNumber: p.accountNumber,
      category: 'earning',
      status: 'completed',
      amountKobo: BigInt(cashFor(1500)),
      linkKind: 'points_cash_out',
      linkTargetId: view.id,
      counterpartyKind: 'wawu',
    });
    expect(out).toMatchObject({
      direction: 'out',
      walletKind: 'merchant',
      wawuUserId: null,
      accountNumber: MERCHANT_ACCOUNT,
      category: 'earning',
      status: 'completed',
      amountKobo: BigInt(cashFor(1500)),
      feeKobo: BigInt(liveFee(cashFor(1500))),
      wawuFeeKobo: 0n,
      linkKind: 'points_cash_out',
      linkTargetId: view.id,
      counterpartyKind: 'wawu_user',
      counterpartyWawuUserId: p.id,
    });
    // The person's history names it for what it is.
    const history = await request(h.app.getHttpServer())
      .get('/api/hub/money/transactions')
      .set('Authorization', p.auth);
    expect(history.status).toBe(200);
    const page = body<{
      items: Array<{ description: string; direction: string; link: unknown }>;
    }>(history).data!;
    const row = page.items.find((i) =>
      i.description.includes('Points to cash'),
    );
    expect(row).toMatchObject({
      direction: 'in',
      description: 'Points to cash \u00b7 1,500 points',
    });
  });

  it('check 2: below the minimum is below_minimum and nothing changes; more than the balance is refused; each before the PIN', async () => {
    const p = await h.person(0);
    await h.lots(p, [{ points: MIN + 500, days: 30 }]);
    const before = await snapshot(p);

    // Fewer points than the minimum, with a WRONG PIN: the answer is the
    // minimum, not the PIN, and no PIN try is used.
    const low = await h.convert(p, MIN - 1, { pin: '0000' });
    expect(low.status).toBe(422);
    expect(body<unknown>(low).reason).toMatchObject({
      code: 'below_minimum',
      minimumPoints: MIN,
      balancePoints: MIN + 500,
    });
    expect(body<unknown>(low).reason?.message).toMatch(/fewer points/);
    expect(await snapshot(p)).toEqual(before);

    // More than the balance, again with a wrong PIN.
    const high = await h.convert(p, MIN + 501, { pin: '0000' });
    expect(high.status).toBe(402);
    expect(body<unknown>(high).reason).toMatchObject({
      code: 'insufficient_points',
      balancePoints: MIN + 500,
      neededPoints: MIN + 501,
      shortfallPoints: 1,
    });
    expect(await snapshot(p)).toEqual(before);

    // Exactly the minimum works, with the right PIN.
    const ok = await h.convert(p, MIN);
    expect(ok.status).toBe(201);
    expect(body<PointsConversionView>(ok).data).toMatchObject({
      status: 'completed',
      points: MIN,
      cashKobo: cashFor(MIN),
    });
    expect(await h.points.balanceOf(p.id)).toBe(500);

    // The whole of what is left is also refused if it is below the minimum.
    const rest = await h.convert(p, 500);
    expect(rest.status).toBe(422);
  });

  it('check 3: the same request twice converts once (V8); a double tap converts once', async () => {
    const p = await h.person(0);
    await h.lots(p, [{ points: 5000, days: 30 }]);
    const key = randomUUID();
    const first = await h.convert(p, 1000, { key });
    expect(first.status).toBe(201);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    const view = body<PointsConversionView>(first).data!;

    // Again, with a wrong PIN: the first answer, replayed; no PIN is checked.
    const again = await h.convert(p, 1000, { key, pin: '0000' });
    expect(again.status).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body).toEqual(first.body);
    const pin = await h.prisma.transactionPin.findUniqueOrThrow({
      where: { wawuUserId: p.id },
    });
    expect(pin.failedTries).toBe(0);

    // Another amount under the same key is not a replay.
    const reused = await h.convert(p, 1001, { key });
    expect(reused.status).toBe(409);
    expect(body<unknown>(reused).reason?.code).toBe('idempotency_key_reused');

    expect(h.sendsOf(view.reference)).toHaveLength(1);
    expect(h.balanceOf(p)).toBe(cashFor(1000));
    expect(await h.points.balanceOf(p.id)).toBe(4000);
    expect(
      await h.prisma.pointConversion.count({ where: { wawuUserId: p.id } }),
    ).toBe(1);
  });

  it('check 3: ten taps at once under one key convert once', async () => {
    const p = await h.person(0);
    await h.lots(p, [{ points: 5000, days: 30 }]);
    const key = randomUUID();
    // The provider holds the first answer while the other nine arrive.
    let open!: () => void;
    h.wallets.gate = new Promise<void>((r) => (open = r));
    const taps = Array.from({ length: 10 }, () =>
      h.convert(p, 2000, { key }).then((r) => r),
    );
    await until(() => h.wallets.arrived >= 1);
    await new Promise((r) => setTimeout(r, 300));
    open();
    const results = await Promise.all(taps);
    const fresh = results.filter(
      (r) => r.status === 201 && !r.headers['idempotent-replayed'],
    );
    expect(fresh).toHaveLength(1);
    for (const r of results) {
      if (r === fresh[0]) continue;
      // The others were told the first one is still running, or got its answer.
      expect([201, 409]).toContain(r.status);
      if (r.status === 409) {
        expect(body<unknown>(r).reason?.code).toBe('idempotency_in_progress');
      }
    }
    expect(h.wallets.arrived).toBe(1);
    expect(
      h.wallets.sends.filter((s) => s.to === p.accountNumber),
    ).toHaveLength(1);
    const view = body<PointsConversionView>(fresh[0]).data!;
    expect(h.sendsOf(view.reference)).toHaveLength(1);
    expect(h.balanceOf(p)).toBe(cashFor(2000));
    expect(await h.points.balanceOf(p.id)).toBe(3000);
    // And a late replay is the first answer.
    const late = await h.convert(p, 2000, { key });
    expect(late.headers['idempotent-replayed']).toBe('true');
    expect(late.body).toEqual(fresh[0].body);
  });

  it('four conversions at once with different keys: the points are checked under the lock, so only what the balance covers converts', async () => {
    const p = await h.person(0);
    await h.lots(p, [{ points: 2500, days: 30 }]);
    const results = await Promise.all(
      Array.from({ length: 4 }, () => h.convert(p, 1000)),
    );
    const ok = results.filter((r) => r.status === 201);
    const short = results.filter((r) => r.status === 402);
    expect(ok).toHaveLength(2);
    expect(short).toHaveLength(2);
    for (const r of short) {
      expect(body<unknown>(r).reason?.code).toBe('insufficient_points');
    }
    expect(await h.points.balanceOf(p.id)).toBe(500);
    expect(h.balanceOf(p)).toBe(2 * cashFor(1000));
    expect(
      h.wallets.sends.filter((s) => s.to === p.accountNumber),
    ).toHaveLength(2);
    // The losers gave their keys back.
    expect(
      await h.prisma.moneyIdempotencyKey.count({ where: { wawuUserId: p.id } }),
    ).toBe(2);
  });

  it('check 4: a person without a wallet gets the no-wallet answer and keeps their points', async () => {
    const p = h.noWallet();
    await h.lots(p, [{ points: 5000, days: 30 }]);
    const before = await snapshot(p);
    const res = await h.convert(p, 1000, { pin: '0000' });
    expect(res.status).toBe(409);
    expect(body<unknown>(res).reason?.code).toBe('wallet_not_open');
    expect(await snapshot(p)).toEqual(before);
    const q = await h.quote(p);
    expect(q.status).toBe(409);
    expect(body<unknown>(q).reason?.code).toBe('wallet_not_open');
    expect(await h.points.balanceOf(p.id)).toBe(5000);
  });

  it('check 5: a failed payout gives the points back to their own lots, with their own end dates', async () => {
    const p = await h.person(0);
    const ids = await h.lots(p, [
      { points: 700, days: 20 },
      { points: 800, days: 200 },
    ]);
    const lotsBefore = await lotRows(ids);

    h.wallets.mode = 'refuse';
    const key = randomUUID();
    const res = await h.convert(p, 1100, { key });
    expect(res.status).toBe(201);
    const view = body<PointsConversionView>(res).data!;
    expect(view).toMatchObject({
      status: 'failed',
      points: 1100,
    });
    expect(view.completedAt).not.toBeNull();
    expect(view.failureReason).toMatch(/points were given back/);
    expect(view.statusMessage).toBeNull();

    // Nothing moved; the points are in the lots they came from, unchanged.
    expect(h.sendsOf(view.reference)).toHaveLength(0);
    expect(h.balanceOf(p)).toBe(0);
    expect(await lotRows(ids)).toEqual(lotsBefore);
    expect(await h.points.balanceOf(p.id)).toBe(1500);
    const { conversion, hold } = await h.state(view.id);
    expect(conversion.status).toBe('cancelled');
    expect(hold?.state).toBe('released');
    expect(await h.ledgerRows(view.reference)).toHaveLength(0);
    // PT5 says it was cancelled, not converting.
    const mine = body<{
      movements: Array<{ label: string; pending: boolean }>;
    }>(await h.myPoints(p)).data!;
    expect(mine.movements.map((m) => m.label)).toEqual(
      expect.arrayContaining([
        'Returned from a cancelled conversion',
        'Conversion cancelled',
      ]),
    );
    expect(mine.movements.every((m) => !m.pending)).toBe(true);

    // The same key answers the same failure again; a new request converts.
    const replay = await h.convert(p, 1100, { key });
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual(res.body);
    h.wallets.mode = 'live';
    const again = await h.convert(p, 1100);
    expect(body<PointsConversionView>(again).data).toMatchObject({
      status: 'completed',
    });
    expect(body<PointsConversionView>(again).data!.reference).not.toBe(
      view.reference,
    );
    expect(await h.points.balanceOf(p.id)).toBe(400);
  });

  it("check 5: WAWU's own account short of money, or a frozen wallet, also give the points back and move nothing", async () => {
    const p = await h.person(0);
    await h.lots(p, [{ points: 4000, days: 30 }]);

    h.wallets.kobo.set(MERCHANT_ACCOUNT, 100);
    const short = body<PointsConversionView>(await h.convert(p, 1000)).data!;
    expect(short.status).toBe('failed');
    expect(h.logger.lines.join('\n')).toContain(
      `conversion ${short.id}: Fintava says WAWU's own account cannot cover`,
    );

    h.wallets.kobo.set(MERCHANT_ACCOUNT, 50_000_000);
    h.wallets.frozen.add(p.accountNumber);
    const frozen = body<PointsConversionView>(await h.convert(p, 1000)).data!;
    expect(frozen.status).toBe('failed');
    h.wallets.frozen.clear();

    expect(await h.points.balanceOf(p.id)).toBe(4000);
    expect(h.wallets.sends.filter((s) => s.to === p.accountNumber)).toEqual([]);
    expect(h.balanceOf(p)).toBe(0);
  });

  // -------------------------------------------------------------------------
  // The provider's record is the truth
  // -------------------------------------------------------------------------

  it('a lost answer is found by our reference, never sent again, and the points are spent once', async () => {
    const p = await h.person(0);
    await h.lots(p, [{ points: 3000, days: 30 }]);
    h.wallets.mode = 'timeout'; // Fintava takes the move; the answer never arrives
    const res = await h.convert(p, 2000);
    expect(res.status).toBe(201);
    const view = body<PointsConversionView>(res).data!;
    expect(view.status).toBe('pending');
    expect(view.statusMessage).toMatch(/still confirming/);
    expect(view.completedAt).toBeNull();

    // The cash moved at the provider; ours does not know yet. The points stay held.
    expect(h.sendsOf(view.reference)).toHaveLength(1);
    expect(await h.points.balanceOf(p.id)).toBe(1000);
    let st = await h.state(view.id);
    expect(st.conversion.status).toBe('held');
    expect(st.conversion.sentAt).not.toBeNull();
    expect(st.hold?.state).toBe('held');
    const mine = body<{
      movements: Array<{ label: string; pending: boolean }>;
    }>(await h.myPoints(p)).data!;
    expect(mine.movements[0]).toMatchObject({
      label: 'Converting to cash',
      pending: true,
    });

    // The sweep asks the provider by our reference and lands what it finds.
    h.wallets.mode = 'live';
    await h.cashOut.sweep(h.later());
    st = await h.state(view.id);
    expect(st.conversion.status).toBe('paid');
    expect(st.hold?.state).toBe('committed');
    expect(h.sendsOf(view.reference)).toHaveLength(1);
    expect(h.balanceOf(p)).toBe(cashFor(2000));
    expect(await h.ledgerRows(view.reference)).toHaveLength(2);
    const done = body<PointsConversionView>(await h.read(p, view.id)).data!;
    expect(done.status).toBe('completed');
    // Another pass changes nothing.
    await h.cashOut.sweep(h.later());
    await h.cashOut.sweep(h.later());
    expect(h.sendsOf(view.reference)).toHaveLength(1);
    expect(h.balanceOf(p)).toBe(cashFor(2000));
    expect(await h.points.balanceOf(p.id)).toBe(1000);
  });

  it('an outcome the provider does not know is asked about, not read as nothing moved, and goes to a person after 72 hours with the points still held', async () => {
    const p = await h.person(0);
    await h.lots(p, [{ points: 3000, days: 30 }]);
    h.wallets.mode = 'timeout';
    const view = body<PointsConversionView>(await h.convert(p, 1500)).data!;
    h.wallets.mode = 'live';
    // Fintava's lookup does not show it (yet): absent is not "no money moved".
    h.wallets.hidden.add(view.reference);

    let t = Date.now();
    for (let i = 0; i < 5; i += 1) {
      t += 3 * 60 * 60_000; // three hours apart, past every rest
      const out = await h.cashOut.sweep(new Date(t));
      expect(out.paid).toBe(0);
    }
    let st = await h.state(view.id);
    expect(st.conversion.status).toBe('held');
    expect(st.conversion.reviewSince).toBeNull();
    expect(st.conversion.checks).toBeGreaterThanOrEqual(4);
    expect(st.hold?.state).toBe('held');
    expect(await h.points.balanceOf(p.id)).toBe(1500);
    // Never sent again, however often it was asked about.
    expect(
      h.wallets.sends.filter((s) => s.reference === view.reference),
    ).toHaveLength(1);
    expect(
      h.double.seen.filter(
        (r) =>
          r.method === 'POST' &&
          r.path.includes('wallet-to-wallet') &&
          JSON.stringify(r.body).includes(view.reference),
      ),
    ).toHaveLength(1);

    // Past the review bound it goes to a person: out of the sweep, still held.
    t += 73 * 3600_000;
    await h.cashOut.sweep(new Date(t));
    st = await h.state(view.id);
    expect(st.conversion.reviewSince).not.toBeNull();
    expect(st.conversion.discrepancy).toMatch(/no answer from Fintava/);
    expect(st.conversion.status).toBe('held');
    expect(st.hold?.state).toBe('held');
    expect(await h.points.balanceOf(p.id)).toBe(1500);
    const shown = body<PointsConversionView>(await h.read(p, view.id)).data!;
    expect(shown.status).toBe('pending');
    expect(shown.statusMessage).toMatch(/checking this conversion/);
    // The sweep leaves it alone from here.
    const next = await h.cashOut.sweep(new Date(t + 3600_000));
    expect(next.checked).toBe(0);
  });

  it("the provider's own record that the move failed gives the points back; an unknown outcome before that does not", async () => {
    const p = await h.person(0);
    const ids = await h.lots(p, [{ points: 2200, days: 45 }]);
    h.wallets.mode = 'error500'; // Fintava answers 500 and moved nothing
    const res = await h.convert(p, 1300);
    const view = body<PointsConversionView>(res).data!;
    expect(view.status).toBe('pending');
    h.wallets.mode = 'live';
    // Absent (404) says nothing about whether it moved: asked again, held.
    await h.cashOut.sweep(h.later());
    let st = await h.state(view.id);
    expect(st.conversion.status).toBe('held');
    expect(st.hold?.state).toBe('held');
    expect(await h.points.balanceOf(p.id)).toBe(900);

    // Now Fintava's record says FAILURE.
    h.wallets.failures.add(view.reference);
    await h.cashOut.sweep(h.later(3 * 60 * 60_000));
    st = await h.state(view.id);
    expect(st.conversion.status).toBe('cancelled');
    expect(st.hold?.state).toBe('released');
    expect(await h.points.balanceOf(p.id)).toBe(2200);
    expect((await lotRows(ids))[0].remaining).toBe(2200);
    expect(h.sendsOf(view.reference)).toHaveLength(0);
    expect(h.balanceOf(p)).toBe(0);
    const shown = body<PointsConversionView>(await h.read(p, view.id)).data!;
    expect(shown.status).toBe('failed');
    expect(shown.failureReason).toMatch(/points were given back/);
  });

  it('another amount than asked is a stop for a person: no ledger, the points still held', async () => {
    const p = await h.person(0);
    await h.lots(p, [{ points: 3000, days: 30 }]);
    h.wallets.mode = 'wrongamount';
    const view = body<PointsConversionView>(await h.convert(p, 1200)).data!;
    h.wallets.mode = 'live';
    expect(view.status).toBe('pending');
    const st = await h.state(view.id);
    expect(st.conversion.reviewSince).not.toBeNull();
    expect(st.conversion.discrepancy).toMatch(
      /moved .* kobo for a conversion of/,
    );
    expect(st.hold?.state).toBe('held');
    expect(await h.ledgerRows(view.reference)).toHaveLength(0);
    await h.cashOut.sweep(h.later());
    expect((await h.state(view.id)).conversion.status).toBe('held');
    expect(h.sendsOf(view.reference)).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Before the PIN, and the PIN
  // -------------------------------------------------------------------------

  it('five wrong PINs lock the PIN and convert nothing; a locked PIN converts nothing', async () => {
    const p = await h.person(0);
    await h.lots(p, [{ points: 5000, days: 30 }]);
    const before = await snapshot(p);
    for (let n = 1; n <= 4; n += 1) {
      const res = await h.convert(p, 1000, { pin: '1111' });
      expect(res.status).toBe(403);
      expect(body<unknown>(res).reason).toMatchObject({
        code: 'pin_incorrect',
        triesLeft: 5 - n,
      });
    }
    const fifth = await h.convert(p, 1000, { pin: '1111' });
    expect(fifth.status).toBe(423);
    expect(body<unknown>(fifth).reason?.code).toBe('pin_locked');
    // The right PIN is no use while it is locked.
    const locked = await h.convert(p, 1000);
    expect(locked.status).toBe(423);
    const after = await snapshot(p);
    expect(after).toMatchObject({
      balance: before.balance,
      conversions: 0,
      holds: 0,
      ledger: before.ledger,
      keys: 0,
      providerRequests: 0,
      wallet: 0,
    });
    // No PIN at all, and no key at all, are their own answers.
    const none = await h.convert(p, 1000, { pin: null });
    expect([403, 423]).toContain(none.status);
    const keyless = await request(h.app.getHttpServer())
      .post('/api/hub/points/convert')
      .set('Authorization', p.auth)
      .set('X-Transaction-Pin', PIN)
      .send({ points: 1000 });
    expect(keyless.status).toBe(400);
    expect(body<unknown>(keyless).reason?.code).toBe(
      'idempotency_key_required',
    );
  });

  it('a malformed amount is a plain 400 before anything is taken', async () => {
    const p = await h.person(0);
    await h.lots(p, [{ points: 5000, days: 30 }]);
    const before = await snapshot(p);
    for (const bad of [
      '1000',
      1000.5,
      0,
      -5,
      3_000_000_000,
      null,
      {},
      [1000],
    ]) {
      const res = await h.convert(p, bad, { pin: '0000' });
      expect(res.status).toBe(400);
      expect(body<unknown>(res).reason).toBeUndefined();
    }
    const empty = await request(h.app.getHttpServer())
      .post('/api/hub/points/convert')
      .set('Authorization', p.auth)
      .set('Idempotency-Key', randomUUID())
      .set('X-Transaction-Pin', '0000')
      .send({});
    expect(empty.status).toBe(400);
    expect(await snapshot(p)).toEqual(before);
  });

  it('a person billed in dollars is refused in plain words, before the PIN, and keeps their points', async () => {
    const p = await h.person(0);
    await h.lots(p, [{ points: 5000, days: 30 }]);
    await h.prisma.personBilling.create({
      data: {
        wawuUserId: p.id,
        currency: 'USD',
        fixedBy: 'first_purchase',
        purchaseRef: `p04-${randomUUID()}`,
      },
    });
    const before = await snapshot(p);
    const res = await h.convert(p, 1000, { pin: '0000' });
    expect(res.status).toBe(409);
    expect(body<unknown>(res).reason?.code).toBe('currency_not_supported');
    expect(body<unknown>(res).reason?.message).toMatch(/dollar/);
    expect(await snapshot(p)).toEqual(before);
    const q = await h.quote(p);
    expect(q.status).toBe(409);
    expect(body<unknown>(q).reason?.code).toBe('currency_not_supported');
  });

  // -------------------------------------------------------------------------
  // The quote, and reading one conversion
  // -------------------------------------------------------------------------

  it("the quote shows the rate, the minimum, the balance, the cash, and that WAWU pays the provider's charge", async () => {
    const p = await h.person(0);
    await h.lots(p, [{ points: MIN + 750, days: 30 }]);
    const whole = await h.quote(p);
    expect(whole.status).toBe(200);
    expect(whole.headers['cache-control']).toBe('no-store');
    const q = body<PointsConvertQuoteView>(whole).data!;
    expect(q).toMatchObject({
      currency: 'NGN',
      balancePoints: MIN + 750,
      minimumPoints: MIN,
      rate: { points: 1000, kobo: RATE },
      points: MIN + 750,
      cashKobo: cashFor(MIN + 750),
      feeKobo: 0,
      wawuPaysProviderCharge: true,
      canConvert: true,
      blockedBy: null,
    });
    expect(q.maximumPoints).toBeGreaterThan(MIN);

    const some = body<PointsConvertQuoteView>(
      await h.quote(p, `?points=${MIN}`),
    ).data!;
    expect(some).toMatchObject({
      points: MIN,
      cashKobo: cashFor(MIN),
      canConvert: true,
    });
    const low = body<PointsConvertQuoteView>(
      await h.quote(p, `?points=${MIN - 1}`),
    ).data!;
    expect(low).toMatchObject({
      canConvert: false,
      blockedBy: 'below_minimum',
      minimumPoints: MIN,
    });
    const high = body<PointsConvertQuoteView>(
      await h.quote(p, `?points=${MIN + 751}`),
    ).data!;
    expect(high).toMatchObject({
      canConvert: false,
      blockedBy: 'insufficient_points',
    });

    // A person with nothing: below the minimum, with the figures to draw it.
    const empty = await h.person(0);
    const none = body<PointsConvertQuoteView>(await h.quote(empty)).data!;
    expect(none).toMatchObject({
      balancePoints: 0,
      points: 0,
      cashKobo: 0,
      canConvert: false,
      blockedBy: 'below_minimum',
    });

    // A quote holds nothing and moves nothing.
    expect(await h.points.balanceOf(p.id)).toBe(MIN + 750);
    expect(h.wallets.arrived).toBe(0);
    for (const bad of ['abc', '0', '-1', '1.5', '1e3', '99999999999']) {
      const res = await h.quote(p, `?points=${bad}`);
      expect(res.status).toBe(400);
    }
  });

  it('one conversion is read by its owner only; anyone else, and an id nobody holds, are the same not_found', async () => {
    const owner = await h.person(0);
    await h.lots(owner, [{ points: 3000, days: 30 }]);
    const view = body<PointsConversionView>(await h.convert(owner, 1000)).data!;
    const stranger = await h.person(0);
    const theirs = await h.read(stranger, view.id);
    const nobody = await h.read(stranger, randomUUID());
    expect(theirs.status).toBe(404);
    expect(nobody.status).toBe(404);
    expect(theirs.body).toEqual(nobody.body);
    expect(body<unknown>(theirs).reason?.code).toBe('not_found');
    const notUuid = await request(h.app.getHttpServer())
      .get(`${'/api/hub/points/convert'}/not-an-id`)
      .set('Authorization', owner.auth);
    expect(notUuid.status).toBe(400);
    const anon = await request(h.app.getHttpServer()).get(
      `/api/hub/points/convert/${view.id}`,
    );
    expect(anon.status).toBe(401);
  });

  it('points_cash_out is a ledger purpose, not something anyone pays for', async () => {
    const p = await h.person(100_000);
    const res = await request(h.app.getHttpServer())
      .get(
        '/api/hub/money/payments/quote?kind=points_cash_out&targetId=anything',
      )
      .set('Authorization', p.auth);
    expect(res.status).toBe(409);
    expect(body<unknown>(res).reason?.code).toBe('target_not_payable');
  });

  it('no sentence it says holds an em-dash, and none names a provider', async () => {
    const p = await h.person(0);
    await h.lots(p, [{ points: 3000, days: 30 }]);
    const said: string[] = [];
    h.wallets.mode = 'refuse';
    said.push(JSON.stringify((await h.convert(p, 1000)).body));
    h.wallets.mode = 'timeout';
    said.push(JSON.stringify((await h.convert(p, 1000)).body));
    h.wallets.mode = 'live';
    said.push(JSON.stringify((await h.convert(p, 1)).body));
    said.push(JSON.stringify((await h.convert(p, 9_000_000)).body));
    said.push(JSON.stringify((await h.quote(p)).body));
    for (const text of said) {
      expect(text).not.toContain('—');
      expect(text.toLowerCase()).not.toContain('fintava');
      expect(text.toLowerCase()).not.toContain('nuvion');
    }
  });
});

describe('Convert points to cash (POINTS-04) with another rate and minimum', () => {
  const h = new FintavaCashOut();
  const other = (() => {
    const c = loadPlansConfig();
    return {
      ...c,
      cashOut: {
        per1000Points: { kobo: 333, cents: 1 },
        minimumPoints: 250,
      },
    };
  })();

  beforeAll(async () => {
    await h.boot({}, other);
  });
  afterAll(async () => {
    await h.close();
  });

  it('the rate and the minimum come from the config: 333 kobo for 1,000 points, rounded down, from 250 points', async () => {
    const p = await h.person(0);
    await h.lots(p, [{ points: 5000, days: 30 }]);
    const q = body<PointsConvertQuoteView>(
      await h.quote(p, '?points=777'),
    ).data!;
    expect(q).toMatchObject({
      minimumPoints: 250,
      rate: { points: 1000, kobo: 333 },
      points: 777,
      // 777 x 333 / 1000 = 258.741 kobo
      cashKobo: 258,
      canConvert: true,
    });
    const low = await h.convert(p, 249);
    expect(low.status).toBe(422);
    expect(body<unknown>(low).reason).toMatchObject({
      code: 'below_minimum',
      minimumPoints: 250,
    });
    const res = await h.convert(p, 777);
    const view = body<PointsConversionView>(res).data!;
    expect(view).toMatchObject({ status: 'completed', cashKobo: 258 });
    const sent = h.sendsOf(view.reference);
    expect(sent).toHaveLength(1);
    expect(sent[0].amountKobo).toBe(258);
    expect(h.balanceOf(p)).toBe(258);
    // The row keeps the rate it was worked out at.
    const { conversion } = await h.state(view.id);
    expect(conversion.per1000PointsKobo).toBe(333n);
    expect(conversion.cashKobo).toBe(258n);
  });

  it('a conversion worth no kobo is refused rather than made', async () => {
    const tiny = {
      ...other,
      cashOut: { per1000Points: { kobo: 1, cents: 1 }, minimumPoints: 1 },
    };
    const t = new FintavaCashOut();
    await t.boot({}, tiny);
    try {
      const p = await t.person(0);
      await t.lots(p, [{ points: 5000, days: 30 }]);
      // 999 points x 1 kobo / 1000 = 0 kobo
      const res = await t.convert(p, 999);
      expect(res.status).toBe(400);
      expect(body<unknown>(res).reason?.code).toBe('amount_out_of_range');
      expect(await t.points.balanceOf(p.id)).toBe(5000);
      const ok = await t.convert(p, 1000);
      expect(body<PointsConversionView>(ok).data).toMatchObject({
        status: 'completed',
        cashKobo: 1,
      });
    } finally {
      await t.close();
    }
  });
});
