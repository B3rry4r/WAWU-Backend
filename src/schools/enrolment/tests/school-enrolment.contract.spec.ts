import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { MERCHANT_ACCOUNT } from '../../../../test/fintava/fintava-double';
import { body, until } from '../../../../test/payments/poll-helpers';
import {
  api,
  type Person,
  type SchoolHarness,
  type SeededClass,
  bootSchoolApp,
} from '../../../../test/schools/school-enrolment-harness';
import { AccountPurgeService } from '../../../account-purge/account-purge.service';
import { EXPORT_SECTIONS } from '../../../data-export-request/data-export-sections';
import type {
  PaymentQuoteView,
  PaymentView,
} from '../../../money/money-view.type';
import type { SchoolEnrolmentView } from '../school-enrolment-view.type';

/**
 * SCHOOLS-07 over HTTP: the real modules and a real database, Fintava's real
 * client over a socket to the local double (no provider is called).
 *
 * The figures: a ₦150,000 course is ₦150,000 plus Fintava's ₦15.75
 * balance-transfer charge (R-10), ₦150,015.75 in all, with no WAWU fee on
 * top because WAWU's share of a school fee is the 15% of the split (R-12).
 */

const PRICE = 15_000_000;
const FEE = 1_575;
const TOTAL = PRICE + FEE;
const START = 20_000_000;
const NOV = '2030-11-03';
const JAN = '2031-01-12';
const MAR = '2031-03-02';

describe('SCHOOLS-07 enrol in a course and pay from the wallet', () => {
  let h: SchoolHarness;
  let r: ReturnType<typeof api>;

  beforeAll(async () => {
    h = await bootSchoolApp('schools07');
    r = api(h);
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(() => {
    h.wallets.mode = 'live';
  });

  const view = (res: request.Response) => body<SchoolEnrolmentView>(res).data!;
  const seats = async (intakeId: string) =>
    (await h.prisma.courseIntake.findUniqueOrThrow({ where: { id: intakeId } }))
      .seatsTaken;

  async function enrol(
    p: Person,
    intakeId: string,
  ): Promise<SchoolEnrolmentView> {
    return view(await r.enrol(p, { intakeId }).expect(201));
  }

  async function payFor(
    p: Person,
    enrolmentId: string,
    key: string = randomUUID(),
  ): Promise<PaymentView> {
    const q = body<PaymentQuoteView>(
      await r.quote(p, enrolmentId).expect(200),
    ).data!;
    const res = await r
      .pay(
        p,
        {
          kind: 'school_fee',
          targetId: enrolmentId,
          expectedTotalKobo: q.totalKobo,
          quoteToken: q.quoteToken,
        },
        { key },
      )
      .expect(201);
    return body<PaymentView>(res).data!;
  }

  const balance = (p: Person) => h.wallets.kobo.get(p.accountNumber);

  describe('SC4 Continue: a place is held', () => {
    it('makes the order with the course, school and class as they are, the fee and a reference', async () => {
      const c = await h.seed({
        priceKobo: PRICE,
        intakes: [{ capacity: 8, startDate: NOV }],
        title: 'Product Design',
        schoolName: 'Greenfield Tech Academy',
      });
      const p = await h.buyer(START);
      const e = await enrol(p, c.intakeIds[0]);
      expect(e).toMatchObject({
        status: 'reserved',
        course: { id: c.courseId, title: 'Product Design' },
        school: { id: c.schoolId, name: 'Greenfield Tech Academy' },
        intake: {
          id: c.intakeIds[0],
          startDate: NOV,
          schedule: 'Weekend class',
          location: 'Yaba',
        },
        priceKobo: PRICE,
        paymentId: null,
        providerFeeKobo: null,
        totalKobo: null,
        enrolledAt: null,
        returned: null,
      });
      expect(e.reference).toMatch(/^WAW-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
      expect(new Date(e.reservedUntil!).getTime()).toBeGreaterThan(Date.now());
      expect(await seats(c.intakeIds[0])).toBe(1);
      // The public page counts the held seat (SC3's "7 seats left").
      const page = await r.course(c.courseId).expect(200);
      expect(
        body<{ intakes: Array<{ seatsLeft: number }> }>(page).data!.intakes[0]
          .seatsLeft,
      ).toBe(7);
    });

    it('records the 85/15 split of the fee on the order (R-12), whole kobo that add up', async () => {
      const c = await h.seed({
        priceKobo: 1_000_001,
        intakes: [{ capacity: 2, startDate: NOV }],
      });
      const e = await enrol(await h.buyer(START), c.intakeIds[0]);
      const row = await h.prisma.schoolEnrolment.findUniqueOrThrow({
        where: { id: e.id },
      });
      expect(row.priceKobo).toBe(1_000_001);
      expect(row.schoolShareKobo).toBe(850_000);
      expect(row.wawuShareKobo).toBe(150_001);
      expect(row.commissionBps).toBe(1500);
    });

    it('the same enrol request twice is one order and one seat', async () => {
      const c = await h.seed({
        priceKobo: PRICE,
        intakes: [{ capacity: 5, startDate: NOV }],
      });
      const p = await h.buyer(START);
      const a = await enrol(p, c.intakeIds[0]);
      const b = await enrol(p, c.intakeIds[0]);
      expect(b.id).toBe(a.id);
      expect(b.reference).toBe(a.reference);
      expect(await seats(c.intakeIds[0])).toBe(1);
    });

    it('six identical requests at once are one order and one seat', async () => {
      const c = await h.seed({
        priceKobo: PRICE,
        intakes: [{ capacity: 5, startDate: NOV }],
      });
      const p = await h.buyer(START);
      const all = await Promise.all(
        Array.from({ length: 6 }, () =>
          r.enrol(p, { intakeId: c.intakeIds[0] }),
        ),
      );
      expect(all.map((x) => x.status)).toEqual(Array(6).fill(201));
      expect(new Set(all.map((x) => view(x).id)).size).toBe(1);
      expect(await seats(c.intakeIds[0])).toBe(1);
      expect(
        await h.prisma.schoolEnrolment.count({ where: { wawuUserId: p.id } }),
      ).toBe(1);
    });

    it('asking for another class of the course moves the place and gives the seat back', async () => {
      const c = await h.seed({
        priceKobo: PRICE,
        intakes: [
          { capacity: 3, startDate: NOV },
          { capacity: 3, startDate: JAN },
        ],
      });
      const p = await h.buyer(START);
      const a = await enrol(p, c.intakeIds[0]);
      const b = await enrol(p, c.intakeIds[1]);
      expect(b.id).not.toBe(a.id);
      expect(await seats(c.intakeIds[0])).toBe(0);
      expect(await seats(c.intakeIds[1])).toBe(1);
      expect(view(await r.read(p, a.id).expect(200)).status).toBe('released');
      // The released order can no longer be paid.
      const res = await r.quote(p, a.id).expect(409);
      expect(body<unknown>(res).reason).toMatchObject({
        code: 'target_not_payable',
      });
    });

    it('an unknown, hidden or foreign class is 404; a body without a class is 400; no token is 401', async () => {
      const c = await h.seed({
        priceKobo: PRICE,
        intakes: [
          { capacity: 3, startDate: NOV, hidden: true },
          { capacity: 3, startDate: JAN },
        ],
      });
      const p = await h.buyer(START);
      await r.enrol(p, { intakeId: randomUUID() }).expect(404);
      await r.enrol(p, { intakeId: c.intakeIds[0] }).expect(404);
      await r.enrol(p, {}).expect(400);
      await r.enrol(p, { intakeId: 'nope' }).expect(400);
      await request(h.app.getHttpServer())
        .post('/api/hub/schools/enrolments')
        .send({ intakeId: c.intakeIds[1] })
        .expect(401);
      // A school that is hidden hides its classes.
      await h.prisma.school.update({
        where: { id: c.schoolId },
        data: { hiddenAt: new Date() },
      });
      await r.enrol(p, { intakeId: c.intakeIds[1] }).expect(404);
    });

    it('a class that has started is closed', async () => {
      const c = await h.seed({
        priceKobo: PRICE,
        intakes: [{ capacity: 3, startDate: '2020-01-06' }],
      });
      const res = await r
        .enrol(await h.buyer(START), { intakeId: c.intakeIds[0] })
        .expect(409);
      expect(body<unknown>(res).reason).toMatchObject({
        code: 'intake_closed',
      });
      expect(await seats(c.intakeIds[0])).toBe(0);
    });

    it('a student can hold only so many unpaid places', async () => {
      const p = await h.buyer(START);
      for (let i = 0; i < 3; i += 1) {
        const c = await h.seed({
          priceKobo: PRICE,
          intakes: [{ capacity: 3, startDate: NOV }],
        });
        await enrol(p, c.intakeIds[0]);
      }
      const extra = await h.seed({
        priceKobo: PRICE,
        intakes: [{ capacity: 3, startDate: NOV }],
      });
      const res = await r
        .enrol(p, { intakeId: extra.intakeIds[0] })
        .expect(409);
      expect(body<unknown>(res).reason).toMatchObject({
        code: 'reservation_limit',
      });
      expect(await seats(extra.intakeIds[0])).toBe(0);
    });

    it('a course with no fee enrols at once and has nothing to pay', async () => {
      const c = await h.seed({
        priceKobo: 0,
        intakes: [{ capacity: 3, startDate: NOV }],
      });
      const p = await h.buyer(START);
      const e = await enrol(p, c.intakeIds[0]);
      expect(e).toMatchObject({ status: 'enrolled', priceKobo: 0 });
      expect(e.enrolledAt).not.toBeNull();
      expect(await seats(c.intakeIds[0])).toBe(1);
      const res = await r.quote(p, e.id).expect(409);
      expect(body<unknown>(res).reason).toMatchObject({
        code: 'target_not_payable',
      });
    });
  });

  describe('SC11: the last seat', () => {
    it('two students racing for the last seat: one is held a place, the other is told the class is full and offered the next class', async () => {
      const c = await h.seed({
        priceKobo: PRICE,
        intakes: [
          { capacity: 1, startDate: NOV },
          { capacity: 4, startDate: JAN },
        ],
      });
      const [a, b] = [await h.buyer(START), await h.buyer(START)];
      const res = await Promise.all([
        r.enrol(a, { intakeId: c.intakeIds[0] }),
        r.enrol(b, { intakeId: c.intakeIds[0] }),
      ]);
      expect(res.map((x) => x.status).sort()).toEqual([201, 409]);
      const full = res.find((x) => x.status === 409)!;
      const reason = body<unknown>(full).reason as unknown as {
        code: string;
        message: string;
        nextIntake: Record<string, unknown>;
      };
      expect(reason.code).toBe('class_full');
      expect(reason.message).toBe('This class is full.');
      expect(reason.nextIntake).toMatchObject({
        id: c.intakeIds[1],
        startDate: JAN,
        seatsLeft: 4,
        full: false,
      });
      expect(await seats(c.intakeIds[0])).toBe(1);
      expect(
        await h.prisma.schoolEnrolment.count({
          where: { intakeId: c.intakeIds[0] },
        }),
      ).toBe(1);
      // The student who was told it is full takes the next class.
      const loser = res[0].status === 409 ? a : b;
      const e = await enrol(loser, c.intakeIds[1]);
      expect(e.intake.startDate).toBe(JAN);
    });

    it('many students at once never take more seats than the class has', async () => {
      const c = await h.seed({
        priceKobo: PRICE,
        intakes: [{ capacity: 2, startDate: NOV }],
      });
      const people = await Promise.all(
        Array.from({ length: 8 }, () => h.buyer(START)),
      );
      const res = await Promise.all(
        people.map((p) => r.enrol(p, { intakeId: c.intakeIds[0] })),
      );
      expect(res.filter((x) => x.status === 201)).toHaveLength(2);
      expect(res.filter((x) => x.status === 409)).toHaveLength(6);
      for (const x of res.filter((y) => y.status === 409)) {
        expect(body<unknown>(x).reason).toMatchObject({ code: 'class_full' });
      }
      expect(await seats(c.intakeIds[0])).toBe(2);
    });

    it('names no next class when the course has none with a seat, skipping hidden, full and started classes', async () => {
      const c = await h.seed({
        priceKobo: PRICE,
        intakes: [
          { capacity: 1, startDate: NOV },
          { capacity: 4, startDate: JAN, hidden: true },
          { capacity: 1, startDate: MAR },
          { capacity: 4, startDate: '2020-01-06' },
        ],
      });
      await enrol(await h.buyer(START), c.intakeIds[0]);
      await enrol(await h.buyer(START), c.intakeIds[2]);
      const res = await r
        .enrol(await h.buyer(START), { intakeId: c.intakeIds[0] })
        .expect(409);
      expect(
        (body<unknown>(res).reason as unknown as { nextIntake: unknown })
          .nextIntake,
      ).toBeNull();
    });

    it('a full class gives back the places nobody paid for before it says no', async () => {
      const c = await h.seed({
        priceKobo: PRICE,
        intakes: [{ capacity: 1, startDate: NOV }],
      });
      const a = await h.buyer(START);
      const held = await enrol(a, c.intakeIds[0]);
      await h.prisma.schoolEnrolment.update({
        where: { id: held.id },
        data: { reservedUntil: new Date(Date.now() - 60_000) },
      });
      const b = await h.buyer(START);
      const e = await enrol(b, c.intakeIds[0]);
      expect(e.status).toBe('reserved');
      expect(view(await r.read(a, held.id).expect(200)).status).toBe(
        'released',
      );
      expect(await seats(c.intakeIds[0])).toBe(1);
    });
  });

  describe('places that are not paid for go back', () => {
    it('the sweep releases a place whose time ran out and returns its seat, once', async () => {
      const c = await h.seed({
        priceKobo: PRICE,
        intakes: [{ capacity: 3, startDate: NOV }],
      });
      const p = await h.buyer(START);
      const e = await enrol(p, c.intakeIds[0]);
      expect(await h.enrolments.releaseExpired()).toBe(0);
      await h.prisma.schoolEnrolment.update({
        where: { id: e.id },
        data: { reservedUntil: new Date(Date.now() - 1000) },
      });
      expect(await h.enrolments.releaseExpired()).toBeGreaterThanOrEqual(1);
      expect(await h.enrolments.releaseExpired()).toBe(0);
      expect(view(await r.read(p, e.id).expect(200)).status).toBe('released');
      expect(await seats(c.intakeIds[0])).toBe(0);
      // The student can hold a place again.
      const again = await enrol(p, c.intakeIds[0]);
      expect(again.id).not.toBe(e.id);
      expect(await seats(c.intakeIds[0])).toBe(1);
    });

    it('a payment that has started keeps the seat whatever the clock says', async () => {
      const c = await h.seed({
        priceKobo: PRICE,
        intakes: [{ capacity: 1, startDate: NOV }],
      });
      const p = await h.buyer(START);
      const e = await enrol(p, c.intakeIds[0]);
      // Fintava takes the transfer and the answer is lost: the payment is
      // pending and the money may have moved.
      h.wallets.mode = 'timeout';
      const pending = await payFor(p, e.id);
      expect(pending.status).toBe('pending');
      await h.prisma.schoolEnrolment.update({
        where: { id: e.id },
        data: { reservedUntil: new Date(Date.now() - 60_000) },
      });
      await h.enrolments.releaseExpired();
      expect(view(await r.read(p, e.id).expect(200)).status).toBe('reserved');
      expect(await seats(c.intakeIds[0])).toBe(1);
      // Another student is told the class is full.
      await r
        .enrol(await h.buyer(START), { intakeId: c.intakeIds[0] })
        .expect(409);
      // Moving the place is refused while its payment is open.
      const res = await r.enrol(p, { intakeId: c.intakeIds[0] }).expect(201);
      expect(view(res).id).toBe(e.id);
      // The payment settles and the student is enrolled.
      h.wallets.mode = 'live';
      await until(async () => {
        await h.sweepLater();
        return view(await r.read(p, e.id).expect(200)).status === 'enrolled';
      }, 'the pending payment to settle into an enrolment');
      expect(await seats(c.intakeIds[0])).toBe(1);
    });
  });

  describe('SC5 to SC7: the fee is paid from the wallet', () => {
    it('quotes the fee and Fintava charge, pays with the PIN, and the receipt shows what was charged', async () => {
      const c = await h.seed({
        priceKobo: PRICE,
        intakes: [{ capacity: 8, startDate: NOV }],
        title: 'Product Design',
        schoolName: 'Greenfield Tech Academy',
      });
      const p = await h.buyer(START);
      const e = await enrol(p, c.intakeIds[0]);
      const q = body<PaymentQuoteView>(
        await r.quote(p, e.id).expect(200),
      ).data!;
      expect(q).toMatchObject({
        kind: 'school_fee',
        targetId: e.id,
        title: 'Product Design',
        payee: null,
        priceKobo: PRICE,
        totalKobo: TOTAL,
        balanceKobo: START,
        shortfallKobo: 0,
        willBeHeld: true,
      });
      expect(q.fee).toMatchObject({
        providerFeeKobo: FEE,
        wawuFeeKobo: 0,
        totalFeeKobo: FEE,
      });
      const merchantBefore = h.wallets.kobo.get(MERCHANT_ACCOUNT)!;
      const paid = await payFor(p, e.id);
      expect(paid).toMatchObject({
        kind: 'school_fee',
        status: 'completed',
        priceKobo: PRICE,
        totalKobo: TOTAL,
        delivered: true,
      });
      expect(balance(p)).toBe(START - TOTAL);
      expect(h.wallets.kobo.get(MERCHANT_ACCOUNT)).toBe(merchantBefore + PRICE);
      const receipt = view(await r.read(p, e.id).expect(200));
      expect(receipt).toMatchObject({
        status: 'enrolled',
        course: { title: 'Product Design' },
        school: { name: 'Greenfield Tech Academy' },
        intake: { startDate: NOV },
        priceKobo: PRICE,
        paymentId: paid.id,
        providerFeeKobo: FEE,
        totalKobo: TOTAL,
        reservedUntil: null,
        returned: null,
      });
      expect(receipt.enrolledAt).not.toBeNull();
      // The seat stays taken.
      expect(await seats(c.intakeIds[0])).toBe(1);
    });

    it('the fee waits in WAWU merchant wallet in a hold that carries the 85/15 split (R-12, R-19)', async () => {
      const c = await h.seed({
        priceKobo: PRICE,
        intakes: [{ capacity: 8, startDate: NOV }],
      });
      const p = await h.buyer(START);
      const e = await enrol(p, c.intakeIds[0]);
      const paid = await payFor(p, e.id);
      expect(paid.hold).toMatchObject({
        status: 'held',
        releaseCondition: 'intake_started',
        amountKobo: PRICE,
      });
      const hold = await h.prisma.walletHold.findUniqueOrThrow({
        where: { paymentId: paid.id },
      });
      expect(hold).toMatchObject({
        kind: 'school_fee',
        targetId: e.id,
        status: 'held',
        action: null,
        payeeWawuUserId: null,
        amountKobo: BigInt(PRICE),
        payeeShareKobo: 12_750_000n,
        wawuShareKobo: 2_250_000n,
      });
      const row = await h.prisma.schoolEnrolment.findUniqueOrThrow({
        where: { id: e.id },
      });
      expect(row.holdId).toBe(hold.id);
      expect(row.schoolShareKobo).toBe(12_750_000);
      expect(row.wawuShareKobo).toBe(2_250_000);
      // Nothing left the merchant wallet: the school is paid at the start of
      // the intake, not when the student pays.
      expect(
        h.wallets.sends.filter((s) => s.from === MERCHANT_ACCOUNT),
      ).toHaveLength(0);
    });

    it('the same pay request twice charges once (same key); a new key is refused as already paid', async () => {
      const c = await h.seed({
        priceKobo: PRICE,
        intakes: [{ capacity: 8, startDate: NOV }],
      });
      const p = await h.buyer(START);
      const e = await enrol(p, c.intakeIds[0]);
      const q = body<PaymentQuoteView>(
        await r.quote(p, e.id).expect(200),
      ).data!;
      const send = {
        kind: 'school_fee',
        targetId: e.id,
        expectedTotalKobo: q.totalKobo,
        quoteToken: q.quoteToken,
      };
      const key = randomUUID();
      const first = await r.pay(p, send, { key }).expect(201);
      const again = await r.pay(p, send, { key }).expect(201);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(body<PaymentView>(again).data!.id).toBe(
        body<PaymentView>(first).data!.id,
      );
      expect(balance(p)).toBe(START - TOTAL);
      // A second tap with a fresh key is not a second charge.
      const other = await r
        .pay(p, send, { key: randomUUID() })
        .expect((res) => expect(res.status).toBeGreaterThanOrEqual(400));
      expect(body<unknown>(other).reason).toMatchObject({
        code: 'target_not_payable',
      });
      expect(balance(p)).toBe(START - TOTAL);
      expect(
        await h.prisma.walletPayment.count({
          where: { payerWawuUserId: p.id, kind: 'school_fee' },
        }),
      ).toBe(1);
    });

    it('two pay requests at once with different keys charge once', async () => {
      const c = await h.seed({
        priceKobo: PRICE,
        intakes: [{ capacity: 8, startDate: NOV }],
      });
      const p = await h.buyer(START);
      const e = await enrol(p, c.intakeIds[0]);
      const q = body<PaymentQuoteView>(
        await r.quote(p, e.id).expect(200),
      ).data!;
      const send = {
        kind: 'school_fee',
        targetId: e.id,
        expectedTotalKobo: q.totalKobo,
        quoteToken: q.quoteToken,
      };
      const res = await Promise.all([
        r.pay(p, send, { key: randomUUID() }),
        r.pay(p, send, { key: randomUUID() }),
      ]);
      expect(res.filter((x) => x.status === 201)).toHaveLength(1);
      expect(balance(p)).toBe(START - TOTAL);
    });

    it('a student already enrolled is told so, on the same class and on another', async () => {
      const c = await h.seed({
        priceKobo: PRICE,
        intakes: [
          { capacity: 8, startDate: NOV },
          { capacity: 8, startDate: JAN },
        ],
      });
      const p = await h.buyer(START);
      const e = await enrol(p, c.intakeIds[0]);
      await payFor(p, e.id);
      const same = await enrol(p, c.intakeIds[0]);
      expect(same).toMatchObject({ id: e.id, status: 'enrolled' });
      const res = await r.enrol(p, { intakeId: c.intakeIds[1] }).expect(409);
      expect(body<unknown>(res).reason).toMatchObject({
        code: 'already_enrolled',
        enrolmentId: e.id,
      });
      expect(await seats(c.intakeIds[1])).toBe(0);
    });

    it('a student without a wallet can hold a place and is sent to open one to pay', async () => {
      const c = await h.seed({
        priceKobo: PRICE,
        intakes: [{ capacity: 8, startDate: NOV }],
      });
      const p = h.walletless();
      const e = await enrol(p, c.intakeIds[0]);
      const res = await r.quote(p, e.id).expect(409);
      expect(body<unknown>(res).reason).toMatchObject({
        code: 'wallet_not_open',
      });
    });

    it('a wallet short of the total is told the shortfall and nothing is taken', async () => {
      const c = await h.seed({
        priceKobo: PRICE,
        intakes: [{ capacity: 8, startDate: NOV }],
      });
      const p = await h.buyer(1_000_000);
      const e = await enrol(p, c.intakeIds[0]);
      const q = body<PaymentQuoteView>(
        await r.quote(p, e.id).expect(200),
      ).data!;
      expect(q.shortfallKobo).toBe(TOTAL - 1_000_000);
      const res = await r
        .pay(p, {
          kind: 'school_fee',
          targetId: e.id,
          expectedTotalKobo: q.totalKobo,
          quoteToken: q.quoteToken,
        })
        .expect(402);
      expect(body<unknown>(res).reason).toMatchObject({
        code: 'insufficient_funds',
      });
      expect(balance(p)).toBe(1_000_000);
      expect(view(await r.read(p, e.id).expect(200)).status).toBe('reserved');
    });

    it("another student's order is not found, to read or to pay", async () => {
      const c = await h.seed({
        priceKobo: PRICE,
        intakes: [{ capacity: 8, startDate: NOV }],
      });
      const owner = await h.buyer(START);
      const other = await h.buyer(START);
      const e = await enrol(owner, c.intakeIds[0]);
      await r.read(other, e.id).expect(404);
      const res = await r.quote(other, e.id).expect(404);
      expect(body<unknown>(res).reason).toMatchObject({
        code: 'target_not_found',
      });
      await r.read(owner, randomUUID()).expect(404);
    });

    it('the receipt keeps what was charged when the school edits the course afterwards', async () => {
      const c = await h.seed({
        priceKobo: PRICE,
        intakes: [{ capacity: 8, startDate: NOV }],
        title: 'Product Design',
      });
      const p = await h.buyer(START);
      const e = await enrol(p, c.intakeIds[0]);
      // The fee goes up after the place was held: the student pays what they were shown.
      await h.prisma.schoolCourse.update({
        where: { id: c.courseId },
        data: { priceKobo: PRICE * 2, title: 'Renamed' },
      });
      const q = body<PaymentQuoteView>(
        await r.quote(p, e.id).expect(200),
      ).data!;
      expect(q.priceKobo).toBe(PRICE);
      await payFor(p, e.id);
      const receipt = view(await r.read(p, e.id).expect(200));
      expect(receipt.course.title).toBe('Product Design');
      expect(receipt.priceKobo).toBe(PRICE);
      expect(receipt.totalKobo).toBe(TOTAL);
    });

    it('a class hidden or started since the place was held cannot be paid, and nothing is taken', async () => {
      const c = await h.seed({
        priceKobo: PRICE,
        intakes: [{ capacity: 8, startDate: NOV }],
      });
      const p = await h.buyer(START);
      const e = await enrol(p, c.intakeIds[0]);
      await h.prisma.courseIntake.update({
        where: { id: c.intakeIds[0] },
        data: { hiddenAt: new Date() },
      });
      const res = await r.quote(p, e.id).expect(409);
      expect(body<unknown>(res).reason).toMatchObject({
        code: 'target_not_payable',
      });
      expect(balance(p)).toBe(START);
    });
  });

  describe('a payment that arrives after its place went back', () => {
    async function paidThenReleased(c: SeededClass, p: Person) {
      const e = await enrol(p, c.intakeIds[0]);
      const paid = await payFor(p, e.id);
      const hold = await h.prisma.walletHold.findUniqueOrThrow({
        where: { paymentId: paid.id },
      });
      // As if the release sweep had run just before the payment was claimed.
      await h.prisma.schoolEnrolment.update({
        where: { id: e.id },
        data: {
          status: 'released',
          paymentId: null,
          holdId: null,
          enrolledAt: null,
          releasedAt: new Date(),
        },
      });
      await h.prisma.courseIntake.update({
        where: { id: c.intakeIds[0] },
        data: { seatsTaken: { decrement: 1 } },
      });
      return { e, paid, hold };
    }
    const deliver = (
      e: SchoolEnrolmentView,
      paid: PaymentView,
      p: Person,
      holdId: string,
    ) =>
      h.registry.get('school_fee')!.onCompleted!({
        paymentId: paid.id,
        payerWawuUserId: p.id,
        kind: 'school_fee',
        targetId: e.id,
        priceKobo: PRICE,
        payeeWawuUserId: null,
        note: null,
        holdId,
      });

    it('takes the seat again when the class still has one', async () => {
      const c = await h.seed({
        priceKobo: PRICE,
        intakes: [{ capacity: 2, startDate: NOV }],
      });
      const p = await h.buyer(START);
      const { e, paid, hold } = await paidThenReleased(c, p);
      await deliver(e, paid, p, hold.id);
      const row = await h.prisma.schoolEnrolment.findUniqueOrThrow({
        where: { id: e.id },
      });
      expect(row).toMatchObject({
        status: 'enrolled',
        paymentId: paid.id,
        holdId: hold.id,
      });
      expect(await seats(c.intakeIds[0])).toBe(1);
      // Told twice, it is still one enrolment and one seat.
      await deliver(e, paid, p, hold.id);
      expect(await seats(c.intakeIds[0])).toBe(1);
    });

    it('refunds the fee through the hold when the class filled in the gap', async () => {
      const c = await h.seed({
        priceKobo: PRICE,
        intakes: [{ capacity: 1, startDate: NOV }],
      });
      const p = await h.buyer(START);
      const { e, paid, hold } = await paidThenReleased(c, p);
      // Someone else took the seat in the gap.
      await enrol(await h.buyer(START), c.intakeIds[0]);
      expect(await seats(c.intakeIds[0])).toBe(1);
      const settled = async () => {
        const row = await h.prisma.schoolEnrolment.findUniqueOrThrow({
          where: { id: e.id },
        });
        expect(row.status).toBe('refunded');
        expect(row.paymentId).toBe(paid.id);
        expect(row.refundedAt).not.toBeNull();
        expect(await seats(c.intakeIds[0])).toBe(1);
        const after = await h.prisma.walletHold.findUniqueOrThrow({
          where: { id: hold.id },
        });
        expect(after).toMatchObject({ action: 'refund', status: 'refunded' });
        // The price is back in the wallet; Fintava's charge is not returned (R-10).
        expect(balance(p)).toBe(START - FEE);
      };
      await deliver(e, paid, p, hold.id);
      await settled();
      // Told again, nothing moves twice.
      await deliver(e, paid, p, hold.id);
      await settled();
      const receipt = view(await r.read(p, e.id).expect(200));
      expect(receipt.status).toBe('refunded');
      expect(receipt.returned).toMatchObject({
        holdStatus: 'refunded',
        returned: true,
        returnedKobo: PRICE,
      });
    });
  });
  describe('the person leaves', () => {
    it('their enrolments are in their data export, and deleting the account keeps the money record without them', async () => {
      const c = await h.seed({
        priceKobo: PRICE,
        intakes: [{ capacity: 3, startDate: NOV }],
      });
      const p = await h.buyer(START);
      const e = await enrol(p, c.intakeIds[0]);
      await payFor(p, e.id);

      const section = EXPORT_SECTIONS.find((x) => x.key === 'schoolEnrolments');
      expect(section?.models).toEqual(['SchoolEnrolment']);
      const exported = (await section?.load(h.prisma, p.id)) as Array<
        Record<string, unknown>
      >;
      expect(exported).toHaveLength(1);
      expect(exported[0]).toMatchObject({
        reference: e.reference,
        status: 'enrolled',
        priceKobo: PRICE,
      });
      expect(Object.keys(exported[0])).not.toContain('wawuUserId');

      const out = await new AccountPurgeService(h.prisma).purge(p.id);
      expect(out.deleted['SchoolEnrolment.wawuUserId (anonymised)']).toBe(1);
      const row = await h.prisma.schoolEnrolment.findUniqueOrThrow({
        where: { id: e.id },
      });
      expect(row).toMatchObject({
        wawuUserId: null,
        status: 'enrolled',
        schoolShareKobo: 12_750_000,
      });
    });
  });
});

describe('SCHOOLS-07 and the daily purchase limit (WALLET-23)', () => {
  let h: SchoolHarness;
  let r: ReturnType<typeof api>;

  beforeAll(async () => {
    // Room for one course fee and its charge in a day, not two.
    h = await bootSchoolApp('schools07lim', {
      WAWU_LIMIT_PURCHASE_DAILY_KOBO: String(TOTAL + 100_000),
    });
    r = api(h);
  });
  afterAll(async () => {
    await h.close();
  });

  const hold = async (p: Person) => {
    const c = await h.seed({
      priceKobo: PRICE,
      intakes: [{ capacity: 3, startDate: NOV }],
    });
    const e = body<SchoolEnrolmentView>(
      await r.enrol(p, { intakeId: c.intakeIds[0] }).expect(201),
    ).data!;
    const q = body<PaymentQuoteView>(await r.quote(p, e.id).expect(200)).data!;
    return {
      c,
      e,
      q,
      send: {
        kind: 'school_fee',
        targetId: e.id,
        expectedTotalKobo: q.totalKobo,
        quoteToken: q.quoteToken,
      },
    };
  };

  it('counts a school fee as a purchase: a second fee in the day is stopped before anything is sent, and a refunded one frees the room', async () => {
    const p = await h.buyer(START * 3);
    const first = await hold(p);
    expect(first.q.withinDailyLimit).toBe(true);
    await r.pay(p, first.send).expect(201);

    const second = await hold(p);
    expect(second.q.withinDailyLimit).toBe(false);
    const refused = await r.pay(p, second.send);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(body<unknown>(refused).reason).toMatchObject({
      code: expect.stringMatching(/limit/),
    });
    expect(
      await h.prisma.walletPayment.count({
        where: { payerWawuUserId: p.id, kind: 'school_fee' },
      }),
    ).toBe(1);

    // The first fee goes back through its hold (the class filled in the gap).
    const paid = await h.prisma.walletPayment.findFirstOrThrow({
      where: { payerWawuUserId: p.id, kind: 'school_fee' },
    });
    const held = await h.prisma.walletHold.findUniqueOrThrow({
      where: { paymentId: paid.id },
    });
    await h.prisma.schoolEnrolment.update({
      where: { id: first.e.id },
      data: {
        status: 'released',
        paymentId: null,
        holdId: null,
        enrolledAt: null,
        releasedAt: new Date(),
      },
    });
    await h.prisma.courseIntake.update({
      where: { id: first.c.intakeIds[0] },
      data: { seatsTaken: 3 },
    });
    await h.registry.get('school_fee')!.onCompleted!({
      paymentId: paid.id,
      payerWawuUserId: p.id,
      kind: 'school_fee',
      targetId: first.e.id,
      priceKobo: PRICE,
      payeeWawuUserId: null,
      note: null,
      holdId: held.id,
    });
    expect(
      (
        await h.prisma.walletHold.findUniqueOrThrow({
          where: { id: held.id },
        })
      ).status,
    ).toBe('refunded');

    const third = body<PaymentQuoteView>(
      await r.quote(p, second.e.id).expect(200),
    ).data!;
    expect(third.withinDailyLimit).toBe(true);
    await r
      .pay(p, {
        kind: 'school_fee',
        targetId: second.e.id,
        expectedTotalKobo: third.totalKobo,
        quoteToken: third.quoteToken,
      })
      .expect(201);
  });
});
