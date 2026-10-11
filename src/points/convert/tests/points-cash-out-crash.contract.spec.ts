import { randomUUID } from 'node:crypto';
import {
  body,
  FintavaCashOut,
  MERCHANT_ACCOUNT,
  type Person,
  until,
} from '../../../../test/points/cash-out-harness';
import { AccountPurgeService } from '../../../account-purge/account-purge.service';
import { FeeQuoteService } from '../../../money/fees/fee-quote.service';
import { LedgerService } from '../../../money/ledger/ledger.service';
import { IdempotencyService } from '../../../money/payments/idempotency';
import { MerchantWallet } from '../../../money/payments/merchant-wallet';
import { PaymentSettings } from '../../../money/payments/payment-config';
import { loadPlansConfig } from '../../../plans/plans-config';
import { PointsCashOutService } from '../points-cash-out.service';
import type { PointsConversionView } from '../points-convert-view.type';

/**
 * Points to cash once, whatever dies or races (task POINTS-04, lead ruling
 * 1): a kill between the hold, the move and the commit, a second Hub process,
 * two sweeps at once, an account deleted in flight, a hold changed by a
 * stranger. Each is a state the database can really be left in; the service
 * is then driven from it by the sweep and the points and the cash are
 * checked to the kobo. The real process kills are in the built-Hub runs (the
 * builder report); here the kill is what a kill leaves: a transaction that
 * never committed, an answer that never came back.
 */

jest.setTimeout(300_000);

const RATE = loadPlansConfig().cashOut.per1000Points.kobo;
const cashFor = (points: number) => Math.floor((points * RATE) / 1000);

describe('Points to cash survives a kill, a second process and a deleted account (POINTS-04)', () => {
  const h = new FintavaCashOut();

  beforeAll(async () => {
    await h.boot();
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    await h.close();
  });
  beforeEach(() => {
    jest.restoreAllMocks();
    h.wallets.mode = 'live';
    h.wallets.gate = null;
    h.wallets.arrived = 0;
    h.wallets.frozen.clear();
    h.wallets.kobo.set(MERCHANT_ACCOUNT, 50_000_000);
  });

  /** A second Hub process: its own service object over the same database and provider. */
  function secondProcess(): PointsCashOutService {
    const get = <T>(t: new (...a: never[]) => T): T =>
      h.moduleRef.get(t, { strict: false });
    return new PointsCashOutService(
      h.prisma,
      h.provider,
      get(LedgerService),
      get(FeeQuoteService),
      get(PaymentSettings),
      h.points,
      get(IdempotencyService),
      get(MerchantWallet),
    );
  }

  /**
   * A request that dies right after its transaction committed: the
   * conversion and the held points exist, nothing was sent. Answers the
   * conversion's id and the key it was made under.
   */
  async function killedAfterHold(
    p: Person,
    points: number,
  ): Promise<{ id: string; key: string; reference: string }> {
    const key = randomUUID();
    const spy = jest
      .spyOn(h.cashOut, 'drive')
      .mockRejectedValueOnce(new Error('the process was killed'));
    const res = await h.convert(p, points, { key });
    spy.mockRestore();
    expect(res.status).toBe(500);
    const row = await h.prisma.pointConversion.findFirstOrThrow({
      where: { wawuUserId: p.id },
      orderBy: { createdAt: 'desc' },
    });
    return { id: row.id, key, reference: row.customerReference };
  }

  it('a kill after the hold and before the move: the sweep sends it once, the points are spent once, and a repeat of the request gets the result', async () => {
    const p = await h.person(0);
    await h.lots(p, [{ points: 3000, days: 30 }]);
    const { id, key, reference } = await killedAfterHold(p, 1400);

    // What a kill leaves: held points, a conversion, nothing at the provider.
    let st = await h.state(id);
    expect(st.conversion).toMatchObject({ status: 'held', sentAt: null });
    expect(st.hold?.state).toBe('held');
    expect(await h.points.balanceOf(p.id)).toBe(1600);
    expect(h.wallets.arrived).toBe(0);
    const keyRow = await h.prisma.moneyIdempotencyKey.findFirstOrThrow({
      where: { wawuUserId: p.id },
    });
    expect(keyRow).toMatchObject({ state: 'in_progress', resourceId: id });

    // The person taps again at once: the first request may still be running.
    const soon = await h.convert(p, 1400, { key });
    expect(soon.status).toBe(409);
    expect(body<unknown>(soon).reason?.code).toBe('idempotency_in_progress');

    // The sweep finishes it.
    const out = await h.cashOut.sweep(h.later());
    expect(out.paid).toBe(1);
    st = await h.state(id);
    expect(st.conversion.status).toBe('paid');
    expect(st.hold?.state).toBe('committed');
    expect(h.sendsOf(reference)).toHaveLength(1);
    expect(h.balanceOf(p)).toBe(cashFor(1400));
    expect(await h.points.balanceOf(p.id)).toBe(1600);
    expect(await h.ledgerRows(reference)).toHaveLength(2);

    // Long after, the same key is answered from the conversion, not run again.
    await h.prisma
      .$executeRaw`UPDATE "MoneyIdempotencyKey" SET "updatedAt" = now() - interval '1 hour' WHERE "wawuUserId" = ${p.id}`;
    const replay = await h.convert(p, 1400, { key, pin: '0000' });
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(body<PointsConversionView>(replay).data).toMatchObject({
      id,
      status: 'completed',
      cashKobo: cashFor(1400),
    });
    expect(h.sendsOf(reference)).toHaveLength(1);
    expect(await h.points.balanceOf(p.id)).toBe(1600);
  });

  it('a kill after the provider moved the cash and before the commit: found by its reference and landed without a second send', async () => {
    const p = await h.person(0);
    await h.lots(p, [
      { points: 900, days: 15 },
      { points: 2000, days: 120 },
    ]);
    // The commit of the points dies once, inside the transaction that also
    // marks the conversion paid: both roll back, the cash has moved.
    const commit = jest
      .spyOn(h.points, 'commit')
      .mockRejectedValueOnce(new Error('the process was killed'));
    const res = await h.convert(p, 1500);
    expect(res.status).toBe(500);
    expect(commit).toHaveBeenCalledTimes(1);

    const row = await h.prisma.pointConversion.findFirstOrThrow({
      where: { wawuUserId: p.id },
    });
    let st = await h.state(row.id);
    expect(st.conversion.status).toBe('held');
    expect(st.conversion.sentAt).not.toBeNull();
    expect(st.hold?.state).toBe('held');
    expect(h.sendsOf(row.customerReference)).toHaveLength(1);
    expect(h.balanceOf(p)).toBe(cashFor(1500));

    // Not before the lease on the call has run out; then it is landed from
    // the provider's record, with no second send.
    const early = await h.cashOut.sweep(new Date());
    expect(early.checked).toBe(0);
    await h.cashOut.sweep(h.later(3 * 3_600_000));
    st = await h.state(row.id);
    expect(st.conversion.status).toBe('paid');
    expect(st.hold?.state).toBe('committed');
    expect(h.sendsOf(row.customerReference)).toHaveLength(1);
    expect(h.balanceOf(p)).toBe(cashFor(1500));
    expect(await h.points.balanceOf(p.id)).toBe(1400);
    // The ledger has each side once, however often the landing was tried.
    expect(await h.ledgerRows(row.customerReference)).toHaveLength(2);
  });

  it('a kill after the lease and before the request left: never sent again, asked about, and a person decides after 72 hours with the points held', async () => {
    const p = await h.person(0);
    await h.lots(p, [{ points: 2000, days: 30 }]);
    const { id, reference } = await killedAfterHold(p, 1000);
    // The lease was taken (sentAt set) and the process died before the request left.
    await h.prisma.pointConversion.update({
      where: { id },
      data: { sentAt: new Date(), nextAttemptAt: new Date(Date.now() - 1_000) },
    });
    let t = Date.now();
    for (let i = 0; i < 4; i += 1) {
      t += 4 * 3_600_000;
      await h.cashOut.sweep(new Date(t));
    }
    let st = await h.state(id);
    expect(st.conversion.status).toBe('held');
    expect(st.hold?.state).toBe('held');
    expect(h.sendsOf(reference)).toHaveLength(0);
    expect(h.wallets.arrived).toBe(0);
    t += 73 * 3_600_000;
    await h.cashOut.sweep(new Date(t));
    st = await h.state(id);
    expect(st.conversion.reviewSince).not.toBeNull();
    expect(st.hold?.state).toBe('held');
    expect(h.wallets.arrived).toBe(0);
    expect(await h.points.balanceOf(p.id)).toBe(1000);
  });

  it('a driver holding an old copy of the row cannot send once another has, however late it comes', async () => {
    const p = await h.person(0);
    await h.lots(p, [{ points: 2000, days: 30 }]);
    const { id, reference } = await killedAfterHold(p, 1000);
    const old = await h.prisma.pointConversion.findUniqueOrThrow({
      where: { id },
    });
    // Another driver took the lease (the move was handed over) and the lease
    // has since run out; the old copy still says nothing was sent.
    await h.prisma.pointConversion.update({
      where: { id },
      data: { sentAt: new Date(), nextAttemptAt: new Date(Date.now() - 1_000) },
    });
    const send = (
      h.cashOut as unknown as {
        send(c: typeof old, now: Date): Promise<unknown>;
      }
    ).send.bind(h.cashOut);
    await send(old, new Date(Date.now() + 10 * 60_000));
    expect(h.sendsOf(reference)).toHaveLength(0);
    expect(h.wallets.arrived).toBe(0);
    const st = await h.state(id);
    expect(st.conversion.attempts).toBe(0);
    expect(st.conversion.status).toBe('held');
    expect(st.hold?.state).toBe('held');
    // Left with a person, so a later test's sweep does not find it due.
    await h.prisma.pointConversion.update({
      where: { id },
      data: { reviewSince: new Date() },
    });
  });

  it('two Hub processes drive one conversion at once: one send, one payment, one commit', async () => {
    const p = await h.person(0);
    await h.lots(p, [{ points: 3000, days: 30 }]);
    const { id, reference } = await killedAfterHold(p, 2000);
    const other = secondProcess();

    // The provider holds the first request while the others arrive.
    let open!: () => void;
    h.wallets.gate = new Promise<void>((r) => (open = r));
    const drives = [
      h.cashOut.drive(id),
      other.drive(id),
      h.cashOut.drive(id),
      other.drive(id),
      other.drive(id),
      h.cashOut.drive(id),
    ];
    await until(() => h.wallets.arrived >= 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(h.wallets.arrived).toBe(1);
    open();
    const results = await Promise.all(drives);
    expect(results.filter((r) => r.state === 'paid')).toHaveLength(1);
    expect(h.wallets.arrived).toBe(1);
    expect(h.sendsOf(reference)).toHaveLength(1);
    const st = await h.state(id);
    expect(st.conversion.status).toBe('paid');
    expect(st.hold?.state).toBe('committed');
    expect(h.balanceOf(p)).toBe(cashFor(2000));
    expect(await h.points.balanceOf(p.id)).toBe(1000);
    expect(await h.ledgerRows(reference)).toHaveLength(2);
  });

  it('two sweeps at once over many conversions pay each once', async () => {
    const people: Person[] = [];
    const made: Array<{ id: string; reference: string; points: number }> = [];
    for (let i = 0; i < 4; i += 1) {
      const p = await h.person(0);
      people.push(p);
      await h.lots(p, [{ points: 9000, days: 30 + i }]);
      for (let j = 0; j < 3; j += 1) {
        const points = 1000 + 100 * (i * 3 + j);
        const k = await killedAfterHold(p, points);
        made.push({ ...k, points });
      }
    }
    const other = secondProcess();
    const now = h.later();
    await Promise.all([
      h.cashOut.sweep(now),
      other.sweep(now),
      other.sweep(now),
    ]);
    // A sweep that found an unlucky lease may leave one for the next pass.
    await h.cashOut.sweep(h.later());
    for (const m of made) {
      expect(h.sendsOf(m.reference)).toHaveLength(1);
      const st = await h.state(m.id);
      expect(st.conversion.status).toBe('paid');
      expect(st.hold?.state).toBe('committed');
      expect(await h.ledgerRows(m.reference)).toHaveLength(2);
    }
    for (const p of people) {
      const mine = made.filter((m) =>
        h.wallets.sends.some(
          (s) => s.reference === m.reference && s.to === p.accountNumber,
        ),
      );
      expect(h.balanceOf(p)).toBe(
        mine.reduce((sum, m) => sum + cashFor(m.points), 0),
      );
      expect(await h.points.balanceOf(p.id)).toBe(
        9000 - mine.reduce((sum, m) => sum + m.points, 0),
      );
    }
    const refs = new Set(made.map((m) => m.reference));
    expect(h.wallets.sends.filter((s) => refs.has(s.reference))).toHaveLength(
      made.length,
    );
  });

  it('an account deleted before the move: the conversion is cancelled, nothing is sent, and nothing throws', async () => {
    const p = await h.person(0);
    await h.lots(p, [{ points: 3000, days: 30 }]);
    const { id, reference } = await killedAfterHold(p, 1500);
    h.track(id);
    const purged = await new AccountPurgeService(h.prisma).purge(p.id);
    expect(purged.pointsLeft).toBe(false);
    expect(purged.deleted['PointConversion.wawuUserId (anonymised)']).toBe(1);

    let st = await h.state(id);
    expect(st.conversion.wawuUserId).toBeNull();
    expect(st.conversion.destinationAccountNumber).toBeNull();
    expect(st.hold).toBeNull();

    const out = await h.cashOut.sweep(h.later());
    expect(out.checked).toBe(1);
    st = await h.state(id);
    expect(st.conversion.status).toBe('cancelled');
    expect(st.conversion.failureReason).toMatch(/couldn't find your wallet/);
    expect(h.sendsOf(reference)).toHaveLength(0);
    expect(h.wallets.arrived).toBe(0);
  });

  it('an account deleted after the move: the cash is confirmed from the provider and the conversion is paid with no person on it', async () => {
    const p = await h.person(0);
    await h.lots(p, [{ points: 3000, days: 30 }]);
    h.wallets.mode = 'timeout';
    const view = body<PointsConversionView>(await h.convert(p, 1200)).data!;
    h.wallets.mode = 'live';
    expect(view.status).toBe('pending');
    h.track(view.id);
    await new AccountPurgeService(h.prisma).purge(p.id);

    await h.cashOut.sweep(h.later());
    const st = await h.state(view.id);
    expect(st.conversion.status).toBe('paid');
    expect(st.conversion.wawuUserId).toBeNull();
    expect(h.sendsOf(view.reference)).toHaveLength(1);
    // No person, no wallet history row: the provider's record is what is kept.
    expect(await h.ledgerRows(view.reference)).toHaveLength(0);
  });

  it('points given back by a stranger while the cash is confirmed: a stop for a person, never a payment with the points returned', async () => {
    const p = await h.person(0);
    await h.lots(p, [{ points: 3000, days: 30 }]);
    const { id, reference } = await killedAfterHold(p, 1000);
    await h.points.release({ purpose: 'cash_out', reference: id });
    expect(await h.points.balanceOf(p.id)).toBe(3000);

    await h.cashOut.sweep(h.later());
    const st = await h.state(id);
    expect(h.sendsOf(reference)).toHaveLength(1);
    expect(st.conversion.status).toBe('held');
    expect(st.conversion.reviewSince).not.toBeNull();
    expect(st.conversion.discrepancy).toMatch(
      /confirmed the cash but its points were already given back/,
    );
    expect(st.hold?.state).toBe('released');
  });

  it('a conversion of the other provider is left alone', async () => {
    const p = await h.person(0);
    await h.lots(p, [{ points: 3000, days: 30 }]);
    // Written before a switch of WALLET_PROVIDER: another provider's money.
    const id = randomUUID();
    const reference = `wawu-pts-${id}`;
    await h.prisma.$transaction(async (tx) => {
      await tx.pointConversion.create({
        data: {
          id,
          wawuUserId: p.id,
          points: 1000,
          cashKobo: BigInt(cashFor(1000)),
          per1000PointsKobo: BigInt(RATE),
          merchantAccountNumber: MERCHANT_ACCOUNT,
          provider: 'nuvion',
          customerReference: reference,
        },
      });
      await h.points.hold(
        { wawuUserId: p.id, purpose: 'cash_out', reference: id, points: 1000 },
        { tx },
      );
    });
    const out = await h.cashOut.sweep(h.later());
    expect(out.checked).toBe(0);
    expect((await h.cashOut.drive(id)).state).toBe('pending');
    expect(h.sendsOf(reference)).toHaveLength(0);
    expect(h.wallets.arrived).toBe(0);
    const st = await h.state(id);
    expect(st.conversion).toMatchObject({ status: 'held', sentAt: null });
    expect(st.hold?.state).toBe('held');
  });

  it('what is in flight is counted for the nightly check, and a paid conversion is not', async () => {
    const p = await h.person(0);
    await h.lots(p, [{ points: 5000, days: 30 }]);
    const before = await h.cashOut.inFlightTotals();
    const a = await killedAfterHold(p, 1000);
    const b = await killedAfterHold(p, 1100);
    const mid = await h.cashOut.inFlightTotals();
    expect(mid.count - before.count).toBe(2);
    expect(mid.amountKobo - before.amountKobo).toBe(
      BigInt(cashFor(1000) + cashFor(1100)),
    );
    await h.cashOut.sweep(h.later());
    const after = await h.cashOut.inFlightTotals();
    // Both are paid now, so neither is counted any more.
    expect((await h.state(a.id)).conversion.status).toBe('paid');
    expect((await h.state(b.id)).conversion.status).toBe('paid');
    expect(mid.count - after.count).toBeGreaterThanOrEqual(2);
    expect(mid.amountKobo - after.amountKobo).toBeGreaterThanOrEqual(
      BigInt(cashFor(1000) + cashFor(1100)),
    );
    expect(h.sendsOf(a.reference)).toHaveLength(1);
    expect(h.sendsOf(b.reference)).toHaveLength(1);
  });
});
