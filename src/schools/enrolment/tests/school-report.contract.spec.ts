import { randomUUID } from 'node:crypto';
import {
  bootSchoolNuvion,
  body,
  type Person,
  type SchoolNuvion,
} from '../../../../test/schools/school-nuvion-harness';
import { until } from '../../../../test/transfers/harness';
import { SchoolEnrolmentService } from '../school-enrolment.service';
import { SchoolReportService } from '../school-report.service';
import { longDay, lagosStamp } from '../school-report';
import type {
  SchoolEnrolmentPage,
  SchoolEnrolmentView,
} from '../school-enrolment-view.type';

/**
 * The enrolment report to the school and My courses (task SCHOOLS-09, SC7 and
 * SC8) on Nuvion stood in at the wallet seam: the real Hub modules, a real
 * database, WAWU ID's mail relay stood in (it answers a repeated
 * Idempotency-Key with the first mail). Nothing leaves this machine.
 */

jest.setTimeout(120_000);

const day = (n: number) =>
  new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

describe('Enrolment report to the school and My courses (SCHOOLS-09)', () => {
  let h: SchoolNuvion;
  let reports: SchoolReportService;

  beforeAll(async () => {
    h = await bootSchoolNuvion('s09');
    reports = h.app.get(SchoolReportService);
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  beforeEach(() => {
    h.mail.reset();
  });

  const reportOf = (enrolmentId: string) =>
    h.prisma.schoolEnrolmentReport.findUniqueOrThrow({
      where: { enrolmentId },
    });
  /**
   * Waits until the first try, which the enrolment starts in the background,
   * has been made AND has finished: a try claims the row (`attempts` goes up
   * and the lease is taken) before it asks the relay, and writes its result
   * with the lease let go. A test that sets the relay's mode or clears its
   * requests on `attempts >= 1` alone does it while that try is still on its
   * way to the relay, so the late request lands in the new mode and the new
   * list (FIX-93).
   */
  const firstTryDone = (enrolmentId: string) =>
    until(async () => {
      const row = await reportOf(enrolmentId);
      return row.attempts >= 1 && row.leaseUntil === null;
    });
  /** Lets the next try happen now. */
  const dueNow = (enrolmentId: string) =>
    h.prisma.schoolEnrolmentReport.update({
      where: { enrolmentId },
      data: { nextAttemptAt: null, leaseUntil: null },
    });

  describe('the report', () => {
    it('a course with no fee: the school gets one mail with the student, course, intake and consent time', async () => {
      const c = await h.seed({
        priceKobo: 0,
        intakes: [{ capacity: 5, startDate: day(40) }],
        title: 'Pattern Cutting Basics',
        schoolName: 'Aba Fashion Institute',
      });
      const school = await h.prisma.school.findUniqueOrThrow({
        where: { id: c.schoolId },
      });
      const p = await h.person(0, {
        firstName: 'Chidi',
        lastName: 'Okafor',
        email: 'chidi.okafor@example.test',
        phone: '+2348031234567',
      });
      const before = Date.now();
      const res = await h.enrol(p, c.intakeIds[0]);
      expect(res.status).toBe(201);
      const view = body<SchoolEnrolmentView>(res).data!;
      expect(view.status).toBe('enrolled');

      await until(() => Promise.resolve(h.mail.mails.size === 1));
      const mail = [...h.mail.mails.values()][0];
      expect(mail.to).toBe(school.reportEmail);
      expect(mail.text).toContain('Student: Chidi Okafor');
      expect(mail.text).toContain('Email: chidi.okafor@example.test');
      expect(mail.text).toContain('Phone: +2348031234567');
      expect(mail.text).toContain('Course: Pattern Cutting Basics');
      expect(mail.text).toContain(
        `starts ${longDay(day(40))} (Saturdays, Yaba)`,
      );
      expect(mail.text).toContain(`Reference: ${view.reference}`);
      const row = await reportOf(view.id);
      expect(row.consentAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(mail.text).toContain(
        `agreed to share these details with Aba Fashion Institute on ${lagosStamp(row.consentAt)} (Lagos time)`,
      );
      // No em-dash in anything a school reads.
      expect(mail.text).not.toContain('—');
      expect(h.mail.requests[0].serviceKey).toBe('school-test-service-key');
      expect(h.mail.requests[0].key).toBe(`school-report-${view.id}`);
      // Sent: recorded once, and the copy of the details is gone.
      await until(async () => (await reportOf(view.id)).sentAt !== null);
      const sent = await reportOf(view.id);
      expect(sent.messageId).toBe(mail.id);
      expect(sent.studentName).toBeNull();
      expect(sent.studentEmail).toBeNull();
      expect(sent.studentPhone).toBeNull();
    });

    it('a paid course: nothing goes while the place is only held, one mail goes after the payment', async () => {
      const c = await h.seed({
        priceKobo: 5_000_000,
        intakes: [{ capacity: 5, startDate: day(40) }],
      });
      const p = await h.person(10_000_000);
      const made = await h.enrol(p, c.intakeIds[0]);
      expect(made.status).toBe(201);
      const view = body<SchoolEnrolmentView>(made).data!;
      expect(view.status).toBe('reserved');
      expect(await reports.deliver(view.id)).toBe('not_due');
      expect(h.mail.requests).toHaveLength(0);

      await h.pay(p, view.id);
      await until(() => Promise.resolve(h.mail.mails.size === 1));
      await until(async () => (await reportOf(view.id)).sentAt !== null);
      // Asked again, from the request and from a sweep: still the one mail.
      expect(await reports.deliver(view.id)).toBe('not_due');
      await reports.sweep();
      expect(h.mail.requests).toHaveLength(1);
      expect(h.mail.mails.size).toBe(1);
    });

    it('five servers sending the same report at once make one mail', async () => {
      h.mail.mode = 'down';
      const c = await h.seed({
        priceKobo: 0,
        intakes: [{ capacity: 5, startDate: day(40) }],
      });
      const p = await h.person(0);
      const made = await h.enrol(p, c.intakeIds[0]);
      const id = body<SchoolEnrolmentView>(made).data!.id;
      await firstTryDone(id);
      expect((await reportOf(id)).sentAt).toBeNull();
      h.mail.mode = 'ok';
      h.mail.requests.length = 0;
      await dueNow(id);
      const answers = await Promise.all(
        Array.from({ length: 5 }, () => reports.deliver(id)),
      );
      expect(answers.filter((a) => a === 'sent')).toHaveLength(1);
      expect(answers.filter((a) => a === 'not_due')).toHaveLength(4);
      expect(h.mail.requests).toHaveLength(1);
      expect(h.mail.mails.size).toBe(1);
    });

    it('the relay takes the mail and the answer is lost: the retry does not make a second mail', async () => {
      h.mail.mode = 'lose';
      const c = await h.seed({
        priceKobo: 0,
        intakes: [{ capacity: 5, startDate: day(40) }],
      });
      const p = await h.person(0);
      const made = await h.enrol(p, c.intakeIds[0]);
      const id = body<SchoolEnrolmentView>(made).data!.id;
      await firstTryDone(id);
      expect(h.mail.mails.size).toBe(1);
      expect((await reportOf(id)).sentAt).toBeNull();
      expect((await reportOf(id)).lastError).toContain('transient');
      h.mail.mode = 'ok';
      await dueNow(id);
      expect(await reports.deliver(id)).toBe('sent');
      expect(h.mail.mails.size).toBe(1);
      // Both requests carried the one key.
      expect(new Set(h.mail.requests.map((r) => r.key)).size).toBe(1);
    });

    it('a relay that is down: the sweep sends it when it is back, resting between tries', async () => {
      h.mail.mode = 'down';
      const c = await h.seed({
        priceKobo: 0,
        intakes: [{ capacity: 5, startDate: day(40) }],
      });
      const p = await h.person(0);
      const made = await h.enrol(p, c.intakeIds[0]);
      const id = body<SchoolEnrolmentView>(made).data!.id;
      await firstTryDone(id);
      const first = await reportOf(id);
      expect(first.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
      // Resting: a sweep now does not try it.
      h.mail.requests.length = 0;
      await reports.sweep();
      expect(h.mail.requests).toHaveLength(0);
      h.mail.mode = 'ok';
      const out = await reports.sweep(new Date(Date.now() + 5 * 60_000));
      expect(out.sent).toBeGreaterThanOrEqual(1);
      expect((await reportOf(id)).sentAt).not.toBeNull();
    });

    it('a relay that refuses ten times: the report is given up, the copy of the details is cleared and an error is logged', async () => {
      h.mail.mode = 'refuse';
      const c = await h.seed({
        priceKobo: 0,
        intakes: [{ capacity: 5, startDate: day(40) }],
      });
      const p = await h.person(0);
      const made = await h.enrol(p, c.intakeIds[0]);
      const id = body<SchoolEnrolmentView>(made).data!.id;
      await firstTryDone(id);
      for (let i = 0; i < 20; i += 1) {
        const row = await reportOf(id);
        if (row.gaveUpAt) break;
        await dueNow(id);
        await reports.deliver(id);
      }
      const row = await reportOf(id);
      expect(row.attempts).toBe(10);
      expect(row.gaveUpAt).not.toBeNull();
      expect(row.studentEmail).toBeNull();
      expect(row.lastError).toContain('refused');
      expect(h.mail.mails.size).toBe(0);
      expect(
        h.logger.lines.some((l) => l.includes(`school report ${id}: given up`)),
      ).toBe(true);
      h.mail.mode = 'ok';
      expect(await reports.deliver(id)).toBe('not_due');
    });

    it('a student who removed their account before the report went: nothing is sent', async () => {
      h.mail.mode = 'down';
      const c = await h.seed({
        priceKobo: 0,
        intakes: [{ capacity: 5, startDate: day(40) }],
      });
      const p = await h.person(0);
      const made = await h.enrol(p, c.intakeIds[0]);
      const id = body<SchoolEnrolmentView>(made).data!.id;
      await firstTryDone(id);
      // What the account purge does to the row (account-data-map.ts).
      await h.prisma.schoolEnrolmentReport.update({
        where: { enrolmentId: id },
        data: {
          wawuUserId: null,
          studentName: null,
          studentEmail: null,
          studentPhone: null,
          nextAttemptAt: null,
          leaseUntil: null,
        },
      });
      h.mail.mode = 'ok';
      h.mail.requests.length = 0;
      expect(await reports.deliver(id)).toBe('gave_up');
      expect(h.mail.requests).toHaveLength(0);
    });

    it('a student whose token gave no name, email or phone is not a removed account: the school is told what exists', async () => {
      h.mail.mode = 'down';
      const c = await h.seed({
        priceKobo: 0,
        intakes: [{ capacity: 5, startDate: day(40) }],
        title: 'Beadwork Basics',
      });
      const p = await h.person(0);
      const made = await h.enrol(p, c.intakeIds[0]);
      const view = body<SchoolEnrolmentView>(made).data!;
      await until(async () => (await reportOf(view.id)).nextAttemptAt !== null);
      // The account is there (its id stays); the token gave no details.
      await h.prisma.schoolEnrolmentReport.update({
        where: { enrolmentId: view.id },
        data: {
          studentName: null,
          studentEmail: null,
          studentPhone: null,
          nextAttemptAt: null,
          leaseUntil: null,
        },
      });
      h.mail.mode = 'ok';
      h.mail.requests.length = 0;
      expect(await reports.deliver(view.id)).toBe('sent');
      expect(h.mail.requests).toHaveLength(1);
      const mail = [...h.mail.mails.values()].at(-1)!;
      expect(mail.text).toContain('Student: not given');
      expect(mail.text).toContain('Course: Beadwork Basics');
      expect(mail.text).toContain(`Reference: ${view.reference}`);
      const row = await reportOf(view.id);
      expect(row.sentAt).not.toBeNull();
      expect(row.gaveUpAt).toBeNull();
    });

    it('an order whose fee went back is never reported', async () => {
      h.mail.mode = 'down';
      const c = await h.seed({
        priceKobo: 0,
        intakes: [{ capacity: 5, startDate: day(40) }],
      });
      const p = await h.person(0);
      const made = await h.enrol(p, c.intakeIds[0]);
      const id = body<SchoolEnrolmentView>(made).data!.id;
      await firstTryDone(id);
      await h.prisma.schoolEnrolment.update({
        where: { id },
        data: { status: 'refunded', refundedAt: new Date() },
      });
      h.mail.mode = 'ok';
      h.mail.requests.length = 0;
      await dueNow(id);
      expect(await reports.deliver(id)).toBe('not_due');
      expect(h.mail.requests).toHaveLength(0);
    });
  });

  describe('My courses', () => {
    async function order(
      p: Person,
      opts: {
        status: 'reserved' | 'enrolled' | 'released' | 'refunded';
        startDate: string;
        weeks: number;
        title: string;
      },
    ) {
      const c = await h.seed({
        priceKobo: 5_000_000,
        intakes: [{ capacity: 5, startDate: opts.startDate }],
        title: opts.title,
        weeks: opts.weeks,
      });
      const row = await h.prisma.schoolEnrolment.create({
        data: {
          wawuUserId: p.id,
          schoolId: c.schoolId,
          courseId: c.courseId,
          intakeId: c.intakeIds[0],
          status: opts.status,
          reference: `WAW-${randomUUID().slice(0, 4).toUpperCase()}-${randomUUID().slice(0, 4).toUpperCase()}`,
          courseTitle: opts.title,
          schoolName: 'Greenfield',
          intakeStartDate: new Date(`${opts.startDate}T00:00:00.000Z`),
          intakeSchedule: 'Saturdays',
          priceKobo: 5_000_000,
          schoolShareKobo: 4_250_000,
          wawuShareKobo: 750_000,
          commissionBps: 1500,
          reservedUntil: new Date(Date.now() + 30 * 60_000),
          enrolledAt: opts.status === 'enrolled' ? new Date() : null,
        },
      });
      return row;
    }

    it('lists a student their enrolments with the intake date, the end date and the tab, and no one else', async () => {
      const a = await h.person(0);
      const b = await h.person(0);
      const upcoming = await order(a, {
        status: 'enrolled',
        startDate: day(30),
        weeks: 6,
        title: 'Upcoming',
      });
      const running = await order(a, {
        status: 'enrolled',
        startDate: day(-7),
        weeks: 6,
        title: 'Running',
      });
      const over = await order(a, {
        status: 'enrolled',
        startDate: day(-100),
        weeks: 4,
        title: 'Over',
      });
      const held = await order(a, {
        status: 'reserved',
        startDate: day(20),
        weeks: 6,
        title: 'Held',
      });
      const refunded = await order(a, {
        status: 'refunded',
        startDate: day(20),
        weeks: 6,
        title: 'Refunded',
      });
      await order(a, {
        status: 'released',
        startDate: day(20),
        weeks: 6,
        title: 'Released',
      });
      await order(b, {
        status: 'enrolled',
        startDate: day(30),
        weeks: 6,
        title: 'Someone else',
      });

      const all = body<SchoolEnrolmentPage>(
        await h.get(a, '/schools/enrolments').expect(200),
      ).data!;
      const titles = all.items.map((i) => i.course.title).sort();
      expect(titles).toEqual(
        ['Held', 'Over', 'Refunded', 'Running', 'Upcoming'].sort(),
      );
      expect(all.nextCursor).toBeNull();
      const up = all.items.find((i) => i.id === upcoming.id)!;
      expect(up.status).toBe('enrolled');
      expect(up.intake.startDate).toBe(day(30));
      expect(up.weeks).toBe(6);
      expect(up.endDate).toBe(day(30 + 6 * 7 - 1));
      expect(up.tab).toBe('current');
      expect(up.reference).toBe(upcoming.reference);

      const current = body<SchoolEnrolmentPage>(
        await h.get(a, '/schools/enrolments?tab=current').expect(200),
      ).data!;
      expect(current.items.map((i) => i.id).sort()).toEqual(
        [upcoming.id, running.id, held.id].sort(),
      );
      const finished = body<SchoolEnrolmentPage>(
        await h.get(a, '/schools/enrolments?tab=finished').expect(200),
      ).data!;
      expect(finished.items.map((i) => i.id).sort()).toEqual(
        [over.id, refunded.id].sort(),
      );
      expect(finished.items.every((i) => i.tab === 'finished')).toBe(true);
      expect(
        body<SchoolEnrolmentPage>(
          await h.get(b, '/schools/enrolments').expect(200),
        ).data!.items.map((i) => i.course.title),
      ).toEqual(['Someone else']);
    });

    it('pages by cursor, newest first, and refuses a cursor it did not give', async () => {
      const a = await h.person(0);
      const made: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        made.push(
          (
            await order(a, {
              status: 'enrolled',
              startDate: day(30 + i),
              weeks: 4,
              title: `Course ${i}`,
            })
          ).id,
        );
      }
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let pages = 0; pages < 5; pages += 1) {
        const url: string =
          '/schools/enrolments?limit=2' + (cursor ? `&cursor=${cursor}` : '');
        const page: SchoolEnrolmentPage = body<SchoolEnrolmentPage>(
          await h.get(a, url).expect(200),
        ).data!;
        expect(page.items.length).toBeLessThanOrEqual(2);
        seen.push(...page.items.map((i) => i.id));
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      expect(seen).toEqual([...made].reverse());
      await h.get(a, '/schools/enrolments?cursor=nope').expect(400);
      await h.get(a, '/schools/enrolments?limit=0').expect(400);
      await h.get(a, '/schools/enrolments?tab=other').expect(400);
    });

    it('lists the enrolment a student just made through the app, with its intake date', async () => {
      const c = await h.seed({
        priceKobo: 0,
        intakes: [{ capacity: 5, startDate: day(45) }],
        title: 'Made through the app',
      });
      const p = await h.person(0);
      const made = await h.enrol(p, c.intakeIds[0]);
      expect(made.status).toBe(201);
      const list = body<SchoolEnrolmentPage>(
        await h.get(p, '/schools/enrolments').expect(200),
      ).data!;
      expect(list.items).toHaveLength(1);
      expect(list.items[0].intake.startDate).toBe(day(45));
      expect(list.items[0].status).toBe('enrolled');
      expect(h.app.get(SchoolEnrolmentService)).toBeDefined();
    });
  });
});
