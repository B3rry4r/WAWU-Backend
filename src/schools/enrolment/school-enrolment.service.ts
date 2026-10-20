import {
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  Prisma,
  type CourseIntake,
  type SchoolEnrolment,
} from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { HoldViewService } from '../../money/holds/hold-view.service';
import { WalletHoldService } from '../../money/holds/wallet-hold.service';
import { koboNumber } from '../../money/ledger/ledger.service';
import { MoneyError } from '../../money/money-error';
import {
  type CompletedPayment,
  type PayableLookup,
  PayableRegistry,
  type PayableTarget,
} from '../../money/payments/payable-registry';
import { isUniqueViolation } from '../../money/prisma-unique';
import { intakeView, type PublicIntakeView } from '../schools-public.views';
import { SchoolEnrolmentError } from './school-enrolment-error';
import { describeDatabaseFailure } from './school-enrolment-failure';
import { SchoolReportService } from './school-report.service';
import { type StudentContact } from './school-report';
import {
  DEFAULT_MAX_OPEN_RESERVATIONS,
  DEFAULT_RESERVATION_MINUTES,
  ENROLMENT_MESSAGES,
  type EnrolmentStatus,
  integerSetting,
  intakeStillOpen,
  lagosToday,
  MAX_OPEN_RESERVATIONS_RANGE,
  newEnrolmentReference,
  RESERVATION_MINUTES_RANGE,
  reservedUntil,
  SCHOOL_FEE_KIND,
  splitCourseFee,
} from './school-enrolment-rules';
import {
  decodeListCursor,
  encodeListCursor,
  endDateOf,
  LIST_DEFAULT_LIMIT,
  LISTED_STATUSES,
  tabOf,
} from './school-enrolment-list';
import type {
  SchoolEnrolmentListItem,
  SchoolEnrolmentPage,
  SchoolEnrolmentView,
} from './school-enrolment-view.type';
import type { EnrolDto, ListEnrolmentsDto } from './school-enrolment.dto';

/** Rows one pass of the release sweep gives back, and passes per minute. */
const RELEASE_BATCH = 200;
const RELEASE_PASSES = 5;

/** The payment states that mean money may have moved or may be about to. */
const OPEN_PAYMENT = Prisma.sql`SELECT 1 FROM "WalletPayment" p
  WHERE p."kind" = 'school_fee' AND p."targetId" = e."id"
    AND p."status" IN ('pending', 'completed')`;

/** No details: a call that did not come from a signed-in request (the report then has nothing to send). */
const NO_CONTACT: StudentContact = { name: null, email: null, phone: null };

/** The class had no seat (carries nothing; the caller names the next class). */
class NoSeat extends Error {}

type Tx = Prisma.TransactionClient;

type Intake = CourseIntake & {
  course: {
    id: string;
    title: string;
    priceKobo: number;
    school: { id: string; name: string };
  };
};

/**
 * Enrol in a course and pay for it from the wallet (task SCHOOLS-07).
 *
 * - **A place, then the payment.** `enrol` claims a seat of the intake with
 *   one conditional write (`seatsTaken < capacity`, the Product.stock
 *   pattern) and makes the order: the course, school and class as they are
 *   now, the fee, and the 85/15 split of it (R-12). Two students racing for
 *   the last seat get one `201` and one `409 class_full` that names the next
 *   class. The same request twice is one order and one seat. The fee is then
 *   paid by MONEY-17's `POST /money/payments` with kind `school_fee` and the
 *   order's id as `targetId`.
 * - **Held, not paid out.** The payment is a held kind (R-19): the fee moves
 *   into WAWU's merchant wallet and waits there. The school's 85% leaves it
 *   at the intake's start and a cancelled intake sends the fee back
 *   (SCHOOLS-11), both through WalletHoldService. Nothing here moves money
 *   except a refund when the class filled in the gap between a seat running
 *   out and the payment arriving.
 * - **An unpaid place goes back.** A reserved order is released, and its seat
 *   returned, when `reservedUntil` passes with no payment started. A payment
 *   that is pending or completed keeps the seat whatever the clock says. The
 *   sweep runs every minute and a full class releases its own expired places
 *   before it says no.
 * - **Nothing is held across a network call.** Every transaction here is
 *   database only and short. The refund is requested after the order is
 *   marked, holding nothing.
 * - **At least once, idempotent.** `onCompleted` runs from the request and
 *   from the payment sweep, on any server; every step is a conditional update
 *   or an idempotent hold call.
 * - **Never the Learn tables.** LearnCourse and CourseEnrollment reference
 *   the removed subscription; nothing here reads them.
 * - **One lock order** (FIX-69, G-FIX-68-3). Every transaction here that holds
 *   more than one row takes its locks in the same order: the student's
 *   advisory lock, then enrolment rows, then class (intake) rows lowest id
 *   first (`lockIntakes`). A swap, the release sweep and a payment arriving
 *   for a released place can therefore wait for each other but never each
 *   hold what the other wants. The sweep never waits on an enrolment row
 *   (`SKIP LOCKED`), and the settlement's refund (SCHOOLS-11) already takes
 *   its one enrolment row before its one class.
 */
@Injectable()
export class SchoolEnrolmentService implements OnModuleInit {
  private readonly logger = new Logger(SchoolEnrolmentService.name);
  private releasing = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly registry: PayableRegistry,
    private readonly holds: WalletHoldService,
    private readonly holdViews: HoldViewService,
    private readonly reports: SchoolReportService,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      kind: SCHOOL_FEE_KIND,
      resolve: (lookup) => this.resolve(lookup),
      onCompleted: (payment) => this.onCompleted(payment),
    });
  }

  // -------------------------------------------------------------------------
  // The routes
  // -------------------------------------------------------------------------

  /** SC4 Continue: holds a place in the class and answers the order. */
  async enrol(
    wawuUserId: string,
    dto: EnrolDto,
    now: Date = new Date(),
    contact: StudentContact = NO_CONTACT,
  ): Promise<SchoolEnrolmentView> {
    const intake = await this.loadIntake(dto.intakeId);
    let gaveBack = false;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const live = await this.prisma.schoolEnrolment.findFirst({
        where: {
          wawuUserId,
          courseId: intake.courseId,
          status: { in: ['reserved', 'enrolled'] },
        },
      });
      if (live && live.intakeId === intake.id) {
        // The same request again: the same order, its place kept a while longer.
        if (live.status === 'reserved') {
          await this.prisma.schoolEnrolment.updateMany({
            where: { id: live.id, status: 'reserved' },
            data: { reservedUntil: reservedUntil(now, this.minutes()) },
          });
        }
        return this.viewOf(await this.byId(live.id));
      }
      if (live?.status === 'enrolled') {
        throw new SchoolEnrolmentError(
          'already_enrolled',
          ENROLMENT_MESSAGES.alreadyEnrolled,
          { enrolmentId: live.id },
        );
      }
      if (!intakeStillOpen(intake.startDate, now)) {
        throw new SchoolEnrolmentError(
          'intake_closed',
          ENROLMENT_MESSAGES.intakeClosed,
        );
      }
      try {
        const row = await this.claim(wawuUserId, intake, now, contact);
        // A course with no fee is enrolled at once: the school hears now.
        if (row.status === 'enrolled') this.tellSchool(row.id);
        return this.viewOf(row);
      } catch (e) {
        if (e instanceof NoSeat) {
          // A class with no seat first gives back the places nobody paid
          // for, once, and only then says it is full.
          if (!gaveBack) {
            gaveBack = true;
            if ((await this.releaseExpired(now, intake.id)) > 0) continue;
          }
          throw new SchoolEnrolmentError(
            'class_full',
            ENROLMENT_MESSAGES.classFull,
            { nextIntake: await this.nextIntake(intake, now) },
          );
        }
        // A twin request made the order first, or the reference clashed:
        // look again.
        if (!isUniqueViolation(e)) throw e;
      }
    }
    throw new Error('SchoolEnrolment: the order could not be made.');
  }

  /** One enrolment as it stands (SC7's receipt). Only its student reads it. */
  async read(wawuUserId: string, id: string): Promise<SchoolEnrolmentView> {
    const row = await this.prisma.schoolEnrolment.findFirst({
      where: { id, wawuUserId },
    });
    if (!row) throw new NotFoundException(ENROLMENT_MESSAGES.notFound);
    return this.viewOf(row);
  }

  /**
   * My courses (SC8): this student's enrolments, newest first, each with its
   * class's start and end date. `tab` keeps only the current or only the
   * finished ones. A place given back unpaid (`released`) is not a course and
   * is not listed. It reads our own records only.
   */
  async list(
    wawuUserId: string,
    query: ListEnrolmentsDto,
    now: Date = new Date(),
  ): Promise<SchoolEnrolmentPage> {
    const limit = query.limit ?? LIST_DEFAULT_LIMIT;
    const after = query.cursor ? decodeListCursor(query.cursor) : null;
    const today = lagosToday(now);
    // The last day of the class, in the database: start + weeks x 7 - 1 days.
    const endDay = Prisma.sql`(e."intakeStartDate" + (c."weeks" * 7 - 1))`;
    const tabWhere =
      query.tab === 'current'
        ? Prisma.sql`AND e."status" <> 'refunded' AND ${endDay} >= ${today}::date`
        : query.tab === 'finished'
          ? Prisma.sql`AND (e."status" = 'refunded' OR ${endDay} < ${today}::date)`
          : Prisma.empty;
    const afterWhere = after
      ? Prisma.sql`AND (e."createdAt", e."id") < (${after.createdAt}, ${after.id})`
      : Prisma.empty;
    const ids = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT e."id" FROM "SchoolEnrolment" e
        JOIN "SchoolCourse" c ON c."id" = e."courseId"
       WHERE e."wawuUserId" = ${wawuUserId}
         AND e."status" IN (${Prisma.join([...LISTED_STATUSES])})
         ${tabWhere} ${afterWhere}
       ORDER BY e."createdAt" DESC, e."id" DESC
       LIMIT ${limit + 1}`;
    const pageIds = ids.slice(0, limit).map((r) => r.id);
    const rows = await this.prisma.schoolEnrolment.findMany({
      where: { id: { in: pageIds } },
      include: { course: { select: { weeks: true } } },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const ordered = pageIds.flatMap((id) => {
      const r = byId.get(id);
      return r ? [r] : [];
    });
    const payments = await this.paymentsOf(ordered);
    const items: SchoolEnrolmentListItem[] = [];
    for (const row of ordered) {
      const view = await this.viewOf(row, payments);
      const endDate = endDateOf(view.intake.startDate, row.course.weeks);
      items.push({
        ...view,
        weeks: row.course.weeks,
        endDate,
        tab: tabOf(view.status, endDate, today),
      });
    }
    return {
      items,
      nextCursor:
        ids.length > limit && ordered.length > 0
          ? encodeListCursor(ordered[ordered.length - 1])
          : null,
    };
  }

  private async paymentsOf(
    rows: SchoolEnrolment[],
  ): Promise<Map<string, { providerFeeKobo: bigint; totalKobo: bigint }>> {
    const ids = rows.flatMap((r) => (r.paymentId ? [r.paymentId] : []));
    if (ids.length === 0) return new Map();
    const paid = await this.prisma.walletPayment.findMany({
      where: { id: { in: ids } },
      select: { id: true, providerFeeKobo: true, totalKobo: true },
    });
    return new Map(paid.map((p) => [p.id, p]));
  }

  // -------------------------------------------------------------------------
  // Claiming a place
  // -------------------------------------------------------------------------

  private async loadIntake(id: string): Promise<Intake> {
    const intake = await this.prisma.courseIntake.findFirst({
      where: {
        id,
        hiddenAt: null,
        course: { hiddenAt: null, school: { hiddenAt: null } },
      },
      include: {
        course: {
          select: {
            id: true,
            title: true,
            priceKobo: true,
            school: { select: { id: true, name: true } },
          },
        },
      },
    });
    if (!intake) {
      throw new NotFoundException(ENROLMENT_MESSAGES.intakeNotFound);
    }
    return intake;
  }

  private async byId(id: string): Promise<SchoolEnrolment> {
    return this.prisma.schoolEnrolment.findUniqueOrThrow({ where: { id } });
  }

  /**
   * One short transaction, database only: take the student's lock, look at
   * the course's live order again, give back their other unpaid place in this
   * course (a different class chosen), take the seat, write the order. A seat
   * that is not there rolls all of it back, so the student keeps the place
   * they had.
   *
   * The lock is a transaction-scoped advisory lock on the student, held for
   * these few statements and released at commit, before any caller reaches a
   * provider. It makes the per-student cap and the one-place-per-course rule
   * a check made one request at a time, instead of a count that parallel
   * requests all pass. The live order is read again under it, so a twin
   * request that got there first is answered by what it made (the same class)
   * or swapped for the class now asked (another class), never refused as a
   * payment in progress when none exists.
   */
  private async claim(
    wawuUserId: string,
    intake: Intake,
    now: Date,
    contact: StudentContact,
  ): Promise<SchoolEnrolment> {
    const price = intake.course.priceKobo;
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS "locked" FROM pg_advisory_xact_lock(hashtextextended(${`school-claim:${wawuUserId}`}, 0))`;
      const live = await tx.schoolEnrolment.findFirst({
        where: {
          wawuUserId,
          courseId: intake.courseId,
          status: { in: ['reserved', 'enrolled'] },
        },
      });
      if (live) {
        if (live.intakeId === intake.id) {
          // A twin request made this order a moment ago: it is the answer,
          // its place kept a while longer.
          if (live.status === 'reserved') {
            await tx.schoolEnrolment.updateMany({
              where: { id: live.id, status: 'reserved' },
              data: { reservedUntil: reservedUntil(now, this.minutes()) },
            });
          }
          return tx.schoolEnrolment.findUniqueOrThrow({
            where: { id: live.id },
          });
        }
        if (live.status === 'enrolled') {
          throw new SchoolEnrolmentError(
            'already_enrolled',
            ENROLMENT_MESSAGES.alreadyEnrolled,
            { enrolmentId: live.id },
          );
        }
        // Another class is held: give it back for this one. Only a payment
        // that has started keeps it.
        const gone = await this.releaseIds(tx, [live.id], now, [intake.id]);
        if (gone === 0) {
          const open = await this.openPayment(tx, live.id);
          if (open) throw this.inProgress(open);
        }
      }
      if (price > 0) {
        const open = await tx.schoolEnrolment.count({
          where: { wawuUserId, status: 'reserved' },
        });
        if (open >= this.maxOpen()) {
          throw new SchoolEnrolmentError(
            'reservation_limit',
            ENROLMENT_MESSAGES.tooManyOpen,
          );
        }
      }
      if (!(await this.takeSeat(tx, intake.id))) throw new NoSeat();
      const split = splitCourseFee(price);
      const order = await tx.schoolEnrolment.create({
        data: {
          wawuUserId,
          schoolId: intake.course.school.id,
          courseId: intake.course.id,
          intakeId: intake.id,
          // A course with no fee has nothing to pay: the place is the enrolment.
          status: price === 0 ? 'enrolled' : 'reserved',
          reference: newEnrolmentReference(),
          courseTitle: intake.course.title,
          schoolName: intake.course.school.name,
          intakeStartDate: intake.startDate,
          intakeSchedule: intake.schedule,
          intakeLocation: intake.location,
          priceKobo: price,
          ...split,
          reservedUntil: reservedUntil(now, this.minutes()),
          enrolledAt: price === 0 ? now : null,
        },
      });
      // SC4's Continue is the student's agreement to share their details with
      // the school (SCHOOLS-09): the time and a copy of the details, in the
      // order's own transaction.
      await this.reports.capture(tx, {
        enrolmentId: order.id,
        wawuUserId,
        contact,
        consentAt: now,
      });
      return order;
    });
  }

  /**
   * Starts the report to the school without making the caller wait for the
   * mail relay: the minute sweep sends it if this try does not.
   */
  private tellSchool(enrolmentId: string): void {
    void this.reports.deliverQuietly(enrolmentId);
  }

  /** The conditional write: a seat is taken only while one is left. */
  private async takeSeat(tx: Tx, intakeId: string): Promise<boolean> {
    const taken = await tx.$executeRaw`
      UPDATE "CourseIntake" SET "seatsTaken" = "seatsTaken" + 1
       WHERE "id" = ${intakeId} AND "hiddenAt" IS NULL
         AND "seatsTaken" < "capacity"`;
    return taken === 1;
  }

  /**
   * Releases these reserved orders that have no payment started and returns
   * their seats, in the caller's transaction. Answers how many were released.
   * `alsoLock` names classes the caller will take next: they are locked with
   * the ones given back, in one id order (a swap passes the class it moves to).
   */
  private async releaseIds(
    tx: Tx,
    ids: string[],
    now: Date,
    alsoLock: string[] = [],
  ): Promise<number> {
    const rows = await tx.$queryRaw<{ intakeId: string }[]>`
      UPDATE "SchoolEnrolment" e
         SET "status" = 'released', "releasedAt" = ${now}, "updatedAt" = ${now}
       WHERE e."id" IN (${Prisma.join(ids)}) AND e."status" = 'reserved'
         AND NOT EXISTS (${OPEN_PAYMENT})
      RETURNING e."intakeId"`;
    await this.giveBack(
      tx,
      rows.map((r) => r.intakeId),
      alsoLock,
    );
    return rows.length;
  }

  /**
   * Locks these classes' rows in one order, lowest id first, in a single
   * statement, so two transactions that want the same classes cannot each
   * hold one and wait for the other. Rows already locked by the caller are
   * not waited on again.
   */
  private async lockIntakes(tx: Tx, ids: string[]): Promise<void> {
    const ordered = [...new Set(ids)].sort();
    if (ordered.length === 0) return;
    await tx.$queryRaw`
      SELECT "id" FROM "CourseIntake"
       WHERE "id" IN (${Prisma.join(ordered)})
       ORDER BY "id" COLLATE "C"
         FOR NO KEY UPDATE`;
  }

  /**
   * Returns seats to their classes. Every class involved (these, and
   * `alsoLock`) is locked first, lowest id first, and nothing is locked when
   * there is nothing to give back.
   */
  private async giveBack(
    tx: Tx,
    intakeIds: string[],
    alsoLock: string[] = [],
  ): Promise<void> {
    if (intakeIds.length === 0) return;
    const per = new Map<string, number>();
    for (const id of intakeIds) per.set(id, (per.get(id) ?? 0) + 1);
    await this.lockIntakes(tx, [...per.keys(), ...alsoLock]);
    for (const [id, n] of [...per].sort(([a], [b]) => (a < b ? -1 : 1))) {
      await tx.$executeRaw`
        UPDATE "CourseIntake" SET "seatsTaken" = "seatsTaken" - ${n}
         WHERE "id" = ${id} AND "seatsTaken" >= ${n}`;
    }
  }

  /**
   * Gives back every place whose time ran out with no payment started, in
   * one class or in all of them. Runs every minute and before a full class
   * says no.
   */
  async releaseExpired(
    now: Date = new Date(),
    intakeId?: string,
  ): Promise<number> {
    let released = 0;
    for (let pass = 0; pass < RELEASE_PASSES; pass += 1) {
      const n = await this.prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<{ intakeId: string }[]>`
          UPDATE "SchoolEnrolment"
             SET "status" = 'released', "releasedAt" = ${now}, "updatedAt" = ${now}
           WHERE "id" IN (
             SELECT e."id" FROM "SchoolEnrolment" e
              WHERE e."status" = 'reserved' AND e."reservedUntil" <= ${now}
                AND ${intakeId === undefined ? Prisma.sql`true` : Prisma.sql`e."intakeId" = ${intakeId}`}
                AND NOT EXISTS (${OPEN_PAYMENT})
              ORDER BY e."reservedUntil"
              LIMIT ${RELEASE_BATCH}
                FOR UPDATE OF e SKIP LOCKED)
          RETURNING "intakeId"`;
        await this.giveBack(
          tx,
          rows.map((r) => r.intakeId),
        );
        return rows.length;
      });
      released += n;
      if (n < RELEASE_BATCH) break;
    }
    return released;
  }

  @Cron(CronExpression.EVERY_MINUTE, { name: 'school-places-release' })
  async sweep(): Promise<void> {
    if (this.releasing) return;
    this.releasing = true;
    try {
      const n = await this.releaseExpired();
      if (n > 0) this.logger.log(`released ${n} unpaid school places`);
    } catch (e) {
      // The Prisma code and the Postgres state tell a timeout (P2024, P2028)
      // from a deadlock (40P01); nothing a person typed is ever printed.
      this.logger.error(
        `release of unpaid school places failed (${describeDatabaseFailure(e)}; models SchoolEnrolment and CourseIntake)`,
      );
    } finally {
      this.releasing = false;
    }
  }

  /** The id of a payment of this order that is pending or completed, in the caller's transaction. */
  private async openPayment(
    tx: Tx,
    enrolmentId: string,
  ): Promise<string | null> {
    const open = await tx.walletPayment.findFirst({
      where: {
        kind: SCHOOL_FEE_KIND,
        targetId: enrolmentId,
        status: { in: ['pending', 'completed'] },
      },
      select: { id: true },
    });
    return open?.id ?? null;
  }

  /** Why a place cannot be swapped: its payment has started. */
  private inProgress(paymentId: string): MoneyError {
    return new MoneyError(
      'payment_in_progress',
      ENROLMENT_MESSAGES.confirming,
      { paymentId },
    );
  }

  /**
   * SC11: the soonest other class of the course that has a seat and has not
   * started, or null when there is none.
   */
  private async nextIntake(
    full: Intake,
    now: Date,
  ): Promise<PublicIntakeView | null> {
    const rows = await this.prisma.courseIntake.findMany({
      where: {
        courseId: full.courseId,
        id: { not: full.id },
        hiddenAt: null,
        startDate: { gte: new Date(`${lagosToday(now)}T00:00:00.000Z`) },
      },
      orderBy: [{ startDate: 'asc' }, { id: 'asc' }],
    });
    const open = rows.find((r) => r.seatsTaken < r.capacity);
    return open ? intakeView(open) : null;
  }

  // -------------------------------------------------------------------------
  // The payable kind (MONEY-17)
  // -------------------------------------------------------------------------

  /**
   * The price of an enrolment for the payment service: the fee that was
   * quoted when the place was held (the student pays what they were shown),
   * with the school as a payee who is not on WAWU so the 85/15 is recorded
   * with the payment and its hold (R-12). Asked again inside the payment's
   * claim, so a class that closed or started since is `target_not_payable`
   * and nothing is taken.
   */
  private async resolve(lookup: PayableLookup): Promise<PayableTarget> {
    const row = await this.prisma.schoolEnrolment.findFirst({
      where: { id: lookup.targetId, wawuUserId: lookup.payerWawuUserId },
    });
    if (!row) {
      throw new MoneyError('target_not_found', ENROLMENT_MESSAGES.notFound);
    }
    const refuse = (message: string) =>
      new MoneyError('target_not_payable', message);
    switch (row.status as EnrolmentStatus) {
      case 'enrolled':
        throw refuse(
          row.priceKobo === 0
            ? ENROLMENT_MESSAGES.free
            : ENROLMENT_MESSAGES.paid,
        );
      case 'released':
        throw refuse(ENROLMENT_MESSAGES.released);
      case 'refunded':
        throw refuse(ENROLMENT_MESSAGES.refunded);
      case 'reserved':
        break;
    }
    const intake = await this.prisma.courseIntake.findFirst({
      where: {
        id: row.intakeId,
        hiddenAt: null,
        course: { hiddenAt: null, school: { hiddenAt: null } },
      },
      select: { startDate: true },
    });
    if (!intake) throw refuse(ENROLMENT_MESSAGES.notOpen);
    if (!intakeStillOpen(intake.startDate, new Date())) {
      throw refuse(ENROLMENT_MESSAGES.intakeClosed);
    }
    return {
      title: row.courseTitle,
      priceKobo: row.priceKobo,
      payee: null,
      payeeOutsideWawu: true,
    };
  }

  /**
   * The payment is confirmed and the fee is held. Marks the order enrolled,
   * once. A place that was released in the gap is taken again if the class
   * still has a seat; if it does not, the order is marked refunded and the
   * fee goes back through the hold. Resolves only when the order is settled
   * either way.
   */
  private async onCompleted(payment: CompletedPayment): Promise<void> {
    await this.settleCompleted(payment);
    // Paid and enrolled: the school hears (a refunded order is not sent).
    this.tellSchool(payment.targetId);
  }

  private async settleCompleted(payment: CompletedPayment): Promise<void> {
    const now = new Date();
    const won = await this.prisma.schoolEnrolment.updateMany({
      where: { id: payment.targetId, status: 'reserved', paymentId: null },
      data: {
        status: 'enrolled',
        paymentId: payment.paymentId,
        holdId: payment.holdId,
        enrolledAt: now,
      },
    });
    if (won.count === 1) return;
    let row = await this.prisma.schoolEnrolment.findUnique({
      where: { id: payment.targetId },
    });
    if (!row) {
      throw new Error(
        `enrolment ${payment.targetId}: no such order to deliver`,
      );
    }
    let chose = false;
    if (row.status === 'released' && row.paymentId === null) {
      // The place went back to the class just as the payment arrived: take a
      // seat again if there is one.
      ({ row, chose } = await this.retake(row, payment, now));
    }
    if (row.paymentId !== null && row.paymentId !== payment.paymentId) {
      // Another payment paid this order: this one is a second payment for one
      // place, which the payment service already flags. The fee goes back.
      this.logger.error(
        `enrolment ${row.id}: payment ${payment.paymentId} completed for an order another payment paid; it is refunded`,
      );
      await this.holds.refund({ paymentId: payment.paymentId });
      return;
    }
    switch (row.status as EnrolmentStatus) {
      case 'enrolled':
        if (row.holdId === null && payment.holdId !== null) {
          await this.prisma.schoolEnrolment.updateMany({
            where: { id: row.id, holdId: null },
            data: { holdId: payment.holdId },
          });
        }
        return;
      case 'released': {
        // No seat: the order is marked first, then the fee goes back, holding
        // nothing across the provider's answer.
        const marked = await this.prisma.schoolEnrolment.updateMany({
          where: { id: row.id, status: 'released', paymentId: null },
          data: {
            status: 'refunded',
            paymentId: payment.paymentId,
            holdId: payment.holdId,
            refundedAt: now,
            failureReason: chose
              ? 'The student chose this course again before the payment arrived.'
              : 'The class filled before the payment arrived.',
          },
        });
        if (chose && marked.count === 1) {
          this.logger.warn(
            `enrolment ${row.id}: payment ${payment.paymentId} completed after the student chose the course again; it is refunded`,
          );
        }
        await this.holds.refund({ paymentId: payment.paymentId });
        return;
      }
      case 'refunded':
        await this.holds.refund({ paymentId: payment.paymentId });
        return;
      case 'reserved':
        throw new Error(
          `enrolment ${row.id}: still reserved after its payment`,
        );
    }
  }

  /**
   * Takes a seat for a released order whose payment arrived. Answers the order
   * as it stands: enrolled, or still released when the class is full or when
   * the student has chosen a class of the course again since (`chose`; a
   * course has one live order per student, so this one cannot be revived
   * beside it). Either way the caller refunds through the hold.
   */
  private async retake(
    row: SchoolEnrolment,
    payment: CompletedPayment,
    now: Date,
  ): Promise<{ row: SchoolEnrolment; chose: boolean }> {
    try {
      const enrolled = await this.prisma.$transaction(async (tx) => {
        // The student's lock first, as in `claim`: this order and a claim by
        // the same student cannot cross on the one-live-order index. Then the
        // order row, then the class (the common lock order).
        await tx.$queryRaw`SELECT 1 AS "locked" FROM pg_advisory_xact_lock(hashtextextended(${`school-claim:${row.wawuUserId ?? row.id}`}, 0))`;
        const { count } = await tx.schoolEnrolment.updateMany({
          where: { id: row.id, status: 'released', paymentId: null },
          data: {
            status: 'enrolled',
            paymentId: payment.paymentId,
            holdId: payment.holdId,
            enrolledAt: now,
            releasedAt: null,
          },
        });
        // Another server settled this order first: nothing was changed.
        if (count !== 1) throw new NoSeat();
        // No seat: the order row goes back with the rest of the transaction.
        if (!(await this.takeSeat(tx, row.intakeId))) throw new NoSeat();
        return tx.schoolEnrolment.findUniqueOrThrow({ where: { id: row.id } });
      });
      return { row: enrolled, chose: false };
    } catch (e) {
      if (e instanceof NoSeat) {
        return { row: await this.byId(row.id), chose: false };
      }
      // The one-live-order-per-course index: the student holds or has paid for
      // another place in this course now. The order row is rolled back.
      if (isUniqueViolation(e)) {
        return { row: await this.byId(row.id), chose: true };
      }
      throw e;
    }
  }

  // -------------------------------------------------------------------------
  // The view
  // -------------------------------------------------------------------------

  async viewOf(
    row: SchoolEnrolment,
    prefetched?: Map<string, { providerFeeKobo: bigint; totalKobo: bigint }>,
  ): Promise<SchoolEnrolmentView> {
    const paid = row.paymentId
      ? prefetched
        ? (prefetched.get(row.paymentId) ?? null)
        : await this.prisma.walletPayment.findUnique({
            where: { id: row.paymentId },
            select: { providerFeeKobo: true, totalKobo: true },
          })
      : null;
    let returned: SchoolEnrolmentView['returned'] = null;
    if (row.status === 'refunded' && row.paymentId) {
      const hold = await this.holdViews.forPayment(row.paymentId);
      if (hold) {
        returned = {
          holdStatus: hold.status,
          returned: hold.status === 'refunded',
          returnedKobo: hold.status === 'refunded' ? hold.refundedKobo : null,
        };
      }
    }
    return {
      id: row.id,
      status: row.status as EnrolmentStatus,
      reference: row.reference,
      course: { id: row.courseId, title: row.courseTitle },
      school: { id: row.schoolId, name: row.schoolName },
      intake: {
        id: row.intakeId,
        startDate: row.intakeStartDate.toISOString().slice(0, 10),
        schedule: row.intakeSchedule,
        location: row.intakeLocation,
      },
      priceKobo: row.priceKobo,
      paymentId: row.paymentId,
      providerFeeKobo: paid ? koboNumber(paid.providerFeeKobo) : null,
      totalKobo: paid ? koboNumber(paid.totalKobo) : null,
      reservedUntil:
        row.status === 'reserved' ? row.reservedUntil.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      enrolledAt: row.enrolledAt?.toISOString() ?? null,
      returned,
    };
  }

  private minutes(): number {
    return integerSetting(
      this.config.get<string>('SCHOOL_RESERVATION_MINUTES'),
      DEFAULT_RESERVATION_MINUTES,
      RESERVATION_MINUTES_RANGE,
    );
  }

  private maxOpen(): number {
    return integerSetting(
      this.config.get<string>('SCHOOL_MAX_OPEN_RESERVATIONS'),
      DEFAULT_MAX_OPEN_RESERVATIONS,
      MAX_OPEN_RESERVATIONS_RANGE,
    );
  }
}
