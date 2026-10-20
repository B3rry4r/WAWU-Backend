import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import request from 'supertest';
import { Prisma } from '../../../../generated/prisma/client';
import {
  BASE,
  bootSchoolNuvion,
  body,
  PIN,
  type Person,
  type SchoolNuvion,
  type SeededClass,
} from '../../../../test/schools/school-nuvion-harness';
import type {
  PaymentQuoteView,
  PaymentView,
} from '../../../money/money-view.type';
import { SchoolEnrolmentError } from '../school-enrolment-error';
import { describeDatabaseFailure } from '../school-enrolment-failure';
import { SchoolEnrolmentService } from '../school-enrolment.service';

/**
 * FIX-69 (G-FIX-68-3): the school places take their locks in one order.
 *
 * The order is: the student's lock, then enrolment rows, then class (intake)
 * rows lowest id first. Before FIX-69 a swap gave back the old class and then
 * took the new one, and the release sweep went through classes in the order
 * the database returned them, so two swaps (A to B against B to A), or a swap
 * against a sweep, could each hold one class and want the other.
 *
 * Two kinds of check, on a real database with Nuvion stood in at the wallet
 * seam (nothing leaves this machine):
 * - the order itself, shown by holding one class locked from outside and
 *   asking, from a third connection, which rows the blocked call holds;
 * - the crossing, many rounds of crossed swaps and sweeps at once, with paid
 *   and in-flight places among them.
 */

jest.setTimeout(300_000);

const START = '2030-11-03';
const START_2 = '2031-01-12';
const PRICE = 5_000_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('FIX-69 school places: one lock order, and a sweep log that tells a deadlock from a timeout', () => {
  let h: SchoolNuvion;
  let svc: SchoolEnrolmentService;

  // The release sweep reads every reservation in the database, so a second copy of this spec on the same database would release the
  // first copy's places (FIX-81 L1). One copy at a time: a session lock of the database, taken before anything is seeded and given
  // back when the connection ends. A second copy keeps asking until it is free, and the lock is the database's, so it holds across processes.
  const ONE_COPY_AT_A_TIME = 8_100_169;
  let turn: Client | undefined;

  beforeAll(async () => {
    turn = new Client({ connectionString: process.env.DATABASE_URL });
    await turn.connect();
    // Tried again and again, never waited on: a connection waiting on a lock would show in `waitUntilBlocked` below as the call under test.
    for (;;) {
      const got = await turn.query<{ got: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS got',
        [ONE_COPY_AT_A_TIME],
      );
      if (got.rows[0].got) break;
      await sleep(250);
    }
    h = await bootSchoolNuvion('fix69');
    svc = h.app.get(SchoolEnrolmentService);
  }, 600_000);
  afterAll(async () => {
    if (h) await h.close();
    await turn?.end();
  });

  const twoClasses = async (capacity: number): Promise<SeededClass> =>
    h.seed({
      priceKobo: PRICE,
      intakes: [
        { capacity, startDate: START },
        { capacity, startDate: START_2 },
      ],
    });

  const LIVE = ['reserved', 'enrolled'];

  /** Seats taken equal the places held, in every class; one live place per student. */
  async function books(c: SeededClass): Promise<void> {
    for (const id of c.intakeIds) {
      const live = await h.prisma.schoolEnrolment.count({
        where: { intakeId: id, status: { in: LIVE } },
      });
      const row = await h.prisma.courseIntake.findUniqueOrThrow({
        where: { id },
      });
      expect({ id, seatsTaken: row.seatsTaken }).toEqual({
        id,
        seatsTaken: live,
      });
    }
    const per = await h.prisma.schoolEnrolment.groupBy({
      by: ['wawuUserId'],
      where: { courseId: c.courseId, status: { in: LIVE } },
      _count: { _all: true },
    });
    for (const g of per) expect(g._count._all).toBe(1);
  }

  // ---- holding a row from outside, and asking who else holds one --------

  /** Locks one row in a transaction of its own until released. */
  async function holdRow(
    table: 'CourseIntake' | 'SchoolEnrolment',
    id: string,
  ) {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let locked!: () => void;
    const ready = new Promise<void>((r) => (locked = r));
    const done = h.prisma.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe(
          `SELECT "id" FROM "${table}" WHERE "id" = $1 FOR NO KEY UPDATE`,
          id,
        );
        locked();
        await gate;
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
    await Promise.race([ready, done]);
    return {
      release: async () => {
        open();
        await done;
      },
    };
  }

  /** Waits until some other connection of this database is waiting for a lock. */
  async function waitUntilBlocked(): Promise<void> {
    for (let i = 0; i < 200; i += 1) {
      const rows = await h.prisma.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS "n" FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'
           AND pid <> pg_backend_pid()`;
      if (rows[0].n > 0) return;
      await sleep(25);
    }
    throw new Error('the call under test never blocked on a lock');
  }

  /** Whether another connection holds this row now (NOWAIT: never waits). */
  async function probe(
    table: 'CourseIntake' | 'SchoolEnrolment',
    id: string,
  ): Promise<'free' | 'held'> {
    try {
      await h.prisma.$queryRawUnsafe(
        `SELECT "id" FROM "${table}" WHERE "id" = $1 FOR NO KEY UPDATE NOWAIT`,
        id,
      );
      return 'free';
    } catch (e) {
      if (describeDatabaseFailure(e).includes('55P03')) return 'held';
      throw e;
    }
  }

  const expire = (ids: string[], ago: number) =>
    h.prisma.schoolEnrolment.updateMany({
      where: { id: { in: ids } },
      data: { reservedUntil: new Date(Date.now() - ago) },
    });

  // ---- the order ---------------------------------------------------------

  describe('the order, shown by holding one class from outside', () => {
    it('a swap from the higher class to the lower takes the lower class first', async () => {
      const c = await twoClasses(5);
      const [low, high] = [...c.intakeIds].sort();
      const student = randomUUID();
      await svc.enrol(student, { intakeId: high });
      const outside = await holdRow('CourseIntake', high);
      const swap = svc.enrol(student, { intakeId: low });
      try {
        await waitUntilBlocked();
        // Waiting for the higher class, the swap already holds the lower one.
        expect(await probe('CourseIntake', low)).toBe('held');
      } finally {
        await outside.release();
      }
      const view = await swap;
      expect(view.intake.id).toBe(low);
      expect(view.status).toBe('reserved');
      await books(c);
    });

    it('the release sweep takes the classes lowest id first, in whatever order the database hands them back', async () => {
      // The database returns the released rows in an order of its own (it
      // follows a hash of the ids), so the check runs over several pairs of
      // classes: a sweep that follows the returned order fails some of them.
      for (let pair = 0; pair < 8; pair += 1) {
        const c = await twoClasses(5);
        const [low, high] = [...c.intakeIds].sort();
        const first = await svc.enrol(randomUUID(), {
          intakeId: pair % 2 === 0 ? high : low,
        });
        const second = await svc.enrol(randomUUID(), {
          intakeId: pair % 2 === 0 ? low : high,
        });
        await expire([first.id], 7_200_000);
        await expire([second.id], 3_600_000);
        const outside = await holdRow('CourseIntake', high);
        const sweep = svc.releaseExpired();
        try {
          await waitUntilBlocked();
          expect(await probe('CourseIntake', low)).toBe('held');
        } finally {
          await outside.release();
        }
        expect(await sweep).toBe(2);
        await books(c);
        for (const id of c.intakeIds) {
          expect(
            (await h.prisma.courseIntake.findUniqueOrThrow({ where: { id } }))
              .seatsTaken,
          ).toBe(0);
        }
      }
    });

    // FIX-69 L1 (SWEEP-LATE). The release sweep does not take the student's
    // lock, so it can give a place back while a twin request for the same
    // class waits on that order's row. The twin must make the place again,
    // not answer with the released order. Two doors lead to the same row: the
    // quick look at the top of `enrol`, and `claim` under the student's lock.
    /** The sweep's release of one order, held open in a transaction of its own. */
    async function sweepHolding(orderId: string, classId: string) {
      let commit!: () => void;
      const gate = new Promise<void>((r) => (commit = r));
      let held!: () => void;
      const ready = new Promise<void>((r) => (held = r));
      const done = h.prisma.$transaction(
        async (tx) => {
          await tx.schoolEnrolment.update({
            where: { id: orderId },
            data: { status: 'released', releasedAt: new Date() },
          });
          await tx.courseIntake.update({
            where: { id: classId },
            data: { seatsTaken: { decrement: 1 } },
          });
          held();
          await gate;
        },
        { timeout: 60_000, maxWait: 10_000 },
      );
      await Promise.race([ready, done]);
      return {
        release: async () => {
          commit();
          await done;
        },
      };
    }

    it('a request for the class whose place the sweep gives back while it waits gets a new place, not the released one', async () => {
      const c = await twoClasses(5);
      const [classId] = c.intakeIds;
      const student = randomUUID();
      const made = await svc.enrol(student, { intakeId: classId });
      const sweep = await sweepHolding(made.id, classId);
      const again = svc.enrol(student, { intakeId: classId });
      try {
        await waitUntilBlocked();
      } finally {
        await sweep.release();
      }
      const view = await again;
      expect(view.status).toBe('reserved');
      expect(view.id).not.toBe(made.id);
      expect(
        (
          await h.prisma.schoolEnrolment.findUniqueOrThrow({
            where: { id: made.id },
          })
        ).status,
      ).toBe('released');
      await books(c);
    });

    it('the claim under the student lock does the same', async () => {
      const c = await twoClasses(5);
      const [classId] = c.intakeIds;
      const student = randomUUID();
      const made = await svc.enrol(student, { intakeId: classId });
      const intake = await svc['loadIntake'](classId);
      const sweep = await sweepHolding(made.id, classId);
      const claimed = svc['claim'](student, intake, new Date(), {} as never);
      try {
        await waitUntilBlocked();
      } finally {
        await sweep.release();
      }
      const row = await claimed;
      expect(row.status).toBe('reserved');
      expect(row.id).not.toBe(made.id);
      await books(c);
    });

    it('a payment arriving for a released place takes the order row, then the class', async () => {
      const c = await twoClasses(5);
      const [classId] = c.intakeIds;
      const student = randomUUID();
      const made = await svc.enrol(student, { intakeId: classId });
      // The place went back just before the payment arrived.
      await h.prisma.schoolEnrolment.update({
        where: { id: made.id },
        data: { status: 'released', releasedAt: new Date() },
      });
      await h.prisma.courseIntake.update({
        where: { id: classId },
        data: { seatsTaken: { decrement: 1 } },
      });
      const row = await h.prisma.schoolEnrolment.findUniqueOrThrow({
        where: { id: made.id },
      });
      const paymentId = randomUUID();
      const holdId = randomUUID();
      const outside = await holdRow('CourseIntake', classId);
      const retake = svc['retake'](
        row,
        { paymentId, holdId, targetId: row.id } as never,
        new Date(),
      );
      try {
        await waitUntilBlocked();
        expect(await probe('SchoolEnrolment', row.id)).toBe('held');
      } finally {
        await outside.release();
      }
      const out = await retake;
      expect(out.chose).toBe(false);
      expect(out.row).toMatchObject({ status: 'enrolled', paymentId, holdId });
      await books(c);
    });
  });

  // ---- the crossing ------------------------------------------------------

  describe('the crossing, many times', () => {
    it('a payment arriving for a released place against the same student choosing another class: no deadlock, one live place', async () => {
      const c = await twoClasses(30);
      const [classA, classB] = c.intakeIds;
      for (let i = 0; i < 20; i += 1) {
        const student = randomUUID();
        // E1: released, its payment about to arrive. E3: a place held in the
        // same class since.
        const first = await svc.enrol(student, { intakeId: classA });
        await h.prisma.schoolEnrolment.update({
          where: { id: first.id },
          data: { status: 'released', releasedAt: new Date() },
        });
        await h.prisma.courseIntake.update({
          where: { id: classA },
          data: { seatsTaken: { decrement: 1 } },
        });
        await svc.enrol(student, { intakeId: classA });
        const row = await h.prisma.schoolEnrolment.findUniqueOrThrow({
          where: { id: first.id },
        });
        const settled = await Promise.allSettled([
          svc['retake'](
            row,
            {
              paymentId: randomUUID(),
              holdId: randomUUID(),
              targetId: row.id,
            } as never,
            new Date(),
          ),
          svc.enrol(student, { intakeId: classB }),
        ]);
        for (const s of settled) {
          if (s.status === 'rejected') {
            // The only refusal either side may answer.
            expect(s.reason).toBeInstanceOf(SchoolEnrolmentError);
          }
        }
        await books(c);
      }
    });

    it('crossed swaps and two sweeps at once, round after round: no deadlock, no place lost or doubled, every held fee where it was', async () => {
      const c = await twoClasses(80);
      const [classA, classB] = c.intakeIds;

      // Fees already held: two paid places, and two places whose payment is in
      // flight past their time (the sweep must not give those back).
      const paying = [await h.person(50_000_000), await h.person(50_000_000)];
      const paidIds = [
        await h.enrolAndPay(paying[0], classA),
        await h.enrolAndPay(paying[1], classB),
      ];
      const inFlight = [await h.person(50_000_000), await h.person(50_000_000)];
      const inFlightIds: string[] = [];
      for (const [i, p] of inFlight.entries()) {
        inFlightIds.push(await startPayment(p, i === 0 ? classA : classB));
      }
      await expire(inFlightIds, 3_600_000);
      const kept = [...paidIds, ...inFlightIds];
      const snapshot = async () => ({
        places: await h.prisma.schoolEnrolment.findMany({
          where: { id: { in: kept } },
          orderBy: { id: 'asc' },
          select: {
            id: true,
            status: true,
            intakeId: true,
            paymentId: true,
            holdId: true,
            enrolledAt: true,
          },
        }),
        holds: (
          await h.prisma.walletHold.findMany({
            where: {
              payerWawuUserId: {
                in: [...paying, ...inFlight].map((p) => p.id),
              },
            },
            orderBy: { id: 'asc' },
          })
        ).map((x) => ({
          id: x.id,
          status: x.status,
          amountKobo: String(x.amountKobo),
          refundedKobo: x.refundedKobo === null ? null : String(x.refundedKobo),
          settledAt: x.settledAt,
        })),
        payments: (
          await h.prisma.walletPayment.findMany({
            where: {
              payerWawuUserId: {
                in: [...paying, ...inFlight].map((p) => p.id),
              },
            },
            orderBy: { id: 'asc' },
          })
        ).map((x) => ({ id: x.id, status: x.status })),
      });
      const before = await snapshot();
      expect(before.holds).toHaveLength(2);
      expect(before.holds.every((x) => x.status === 'held')).toBe(true);
      expect(before.payments.map((x) => x.status).sort()).toEqual([
        'completed',
        'completed',
        'pending',
        'pending',
      ]);

      // Swappers: three hold a place in each class and trade every round.
      let inA = Array.from({ length: 3 }, () => randomUUID());
      let inB = Array.from({ length: 3 }, () => randomUUID());
      for (const u of inA) await svc.enrol(u, { intakeId: classA });
      for (const u of inB) await svc.enrol(u, { intakeId: classB });

      const rounds = 25;
      let gaveBack = 0;
      for (let round = 0; round < rounds; round += 1) {
        // Places nobody paid for, past their time, in both classes: the sweep's work.
        const fodder: string[] = [];
        for (const intakeId of [classA, classB, classA, classB]) {
          fodder.push((await svc.enrol(randomUUID(), { intakeId })).id);
        }
        for (const id of fodder) {
          await expire([id], 60_000 + Math.floor(Math.random() * 600_000));
        }
        const calls = [
          ...inA.map((u) => svc.enrol(u, { intakeId: classB })),
          ...inB.map((u) => svc.enrol(u, { intakeId: classA })),
          svc.releaseExpired(),
          svc.releaseExpired(),
        ];
        const settled = await Promise.allSettled(calls);
        const failed = settled.flatMap((s) =>
          s.status === 'rejected' ? [describeDatabaseFailure(s.reason)] : [],
        );
        expect(failed).toEqual([]);
        gaveBack += settled
          .slice(-2)
          .reduce(
            (n, s) => n + (s.status === 'fulfilled' ? (s.value as number) : 0),
            0,
          );
        // Each swapper now holds the other class; every fodder place is released.
        [inA, inB] = [inB, inA];
        const gone = await h.prisma.schoolEnrolment.count({
          where: { id: { in: fodder }, status: 'released' },
        });
        expect(gone).toBe(fodder.length);
        await books(c);
      }
      expect(gaveBack).toBe(rounds * 4);
      expect(await snapshot()).toEqual(before);
      // Every swapper still holds exactly one place, in the class they traded to.
      for (const [list, intakeId] of [
        [inA, classA],
        [inB, classB],
      ] as const) {
        for (const u of list) {
          const live = await h.prisma.schoolEnrolment.findMany({
            where: { wawuUserId: u, status: { in: LIVE } },
          });
          expect(live.map((x) => x.intakeId)).toEqual([intakeId]);
        }
      }
    });

    /** A payment started and left pending: the enrolment's id. */
    async function startPayment(p: Person, intakeId: string): Promise<string> {
      const made = await h.enrol(p, intakeId);
      if (made.status !== 201) throw new Error(`enrol ${made.status}`);
      const id = (made.body as { data: { id: string } }).data.id;
      h.nuvion.mode = 'pending';
      const q = body<PaymentQuoteView>(
        await request(h.app.getHttpServer())
          .get(`${BASE}/money/payments/quote?kind=school_fee&targetId=${id}`)
          .set('Authorization', p.auth)
          .expect(200),
      ).data!;
      const res = await request(h.app.getHttpServer())
        .post(`${BASE}/money/payments`)
        .set('Authorization', p.auth)
        .set('Idempotency-Key', randomUUID())
        .set('X-Transaction-Pin', PIN)
        .send({
          kind: q.kind,
          targetId: q.targetId,
          expectedTotalKobo: q.totalKobo,
          quoteToken: q.quoteToken,
        });
      if (res.status !== 201) throw new Error(`payment ${res.status}`);
      expect(body<PaymentView>(res).data!.status).toBe('pending');
      return id;
    }
  });

  // ---- the log -----------------------------------------------------------

  describe('the sweep log', () => {
    it('names the Prisma code and the model, and nothing a person typed', async () => {
      const err = new Prisma.PrismaClientKnownRequestError(
        'Invalid invocation: ada@example.com +2348012345678',
        {
          code: 'P2028',
          clientVersion: 'test',
          meta: { modelName: 'SchoolEnrolment' },
        },
      );
      jest.spyOn(svc, 'releaseExpired').mockRejectedValueOnce(err);
      h.logger.lines.length = 0;
      await svc.sweep();
      const line = h.logger.lines.find((l) =>
        l.includes('release of unpaid school places failed'),
      );
      expect(line).toBeDefined();
      expect(line).toContain('P2028');
      expect(line).toContain('SchoolEnrolment');
      expect(line).not.toMatch(/ada@|2348012345678/);
      expect(line).not.toContain('—');
    });

    it('a real deadlock in the database reads as 40P01, so it is not mistaken for a timeout', async () => {
      const c = await twoClasses(2);
      const [one, two] = c.intakeIds;
      const lock = (tx: Prisma.TransactionClient, id: string) =>
        tx.$queryRaw`SELECT "id" FROM "CourseIntake" WHERE "id" = ${id} FOR NO KEY UPDATE`;
      const crossed = (first: string, second: string) =>
        h.prisma.$transaction(
          async (tx) => {
            await lock(tx, first);
            await sleep(300);
            await lock(tx, second);
          },
          { timeout: 30_000 },
        );
      const settled = await Promise.allSettled([
        crossed(one, two),
        crossed(two, one),
      ]);
      const failed = settled.flatMap((s) =>
        s.status === 'rejected' ? [s.reason as unknown] : [],
      );
      expect(failed).toHaveLength(1);
      const line = describeDatabaseFailure(failed[0]);
      expect(line).toContain('40P01');
      expect(line).not.toContain('P2028');
      jest.spyOn(svc, 'releaseExpired').mockRejectedValueOnce(failed[0]);
      h.logger.lines.length = 0;
      await svc.sweep();
      expect(
        h.logger.lines.find((l) => l.includes('failed') && l.includes('40P01')),
      ).toBeDefined();
    });
  });
});
