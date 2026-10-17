import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Prisma } from '../../../generated/prisma/client';
import { WawuIdMailRelay } from '../../admin/notifications/email/email-provider';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  reportMail,
  reportMailKey,
  reportRestMs,
  REPORT_LEASE_MS,
  REPORT_MAX_ATTEMPTS,
  REPORT_SWEEP_BATCH,
  REPORT_UNUSED_KEEP_DAYS,
  type StudentContact,
} from './school-report';

type Tx = Prisma.TransactionClient;

/** How one try of a report ended. */
export type ReportOutcome =
  'sent' | 'sent_before' | 'waiting' | 'gave_up' | 'not_due';

/**
 * The enrolment report to the school (task SCHOOLS-09, SC7).
 *
 * - **Consent, then the copy.** `capture` runs in the transaction that makes
 *   the order: it keeps the time the student tapped Continue on SC4 and a copy
 *   of the contact details on their token. (WAWU ID alone holds addresses and
 *   phones, and the payment that enrols the student may be confirmed by the
 *   payment sweep, with no token in hand, so the copy is the only way the
 *   report can say who enrolled.)
 * - **One mail.** The report is sent once the order is `enrolled`. A try is
 *   claimed by a short lease (`leaseUntil`) won by one caller only, then the
 *   relay is called holding nothing, then the result is recorded. The mail
 *   goes under the key `school-report-<enrolment id>`, so a try whose answer
 *   was lost, or a second server, gets the first mail's answer from the relay
 *   instead of making a second mail. A failed try rests 1, 2, 4 ... 60
 *   minutes and the report is given up after ten tries (an error in the log).
 * - **No details kept.** The send clears the copy. A report whose student
 *   deleted the account before it went is given up, not sent. An order that
 *   was released and never enrolled has its copy cleared after a month.
 */
@Injectable()
export class SchoolReportService {
  private readonly logger = new Logger(SchoolReportService.name);
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly relay: WawuIdMailRelay,
  ) {}

  /** In the order's transaction: the consent time and the copy of the details. */
  async capture(
    tx: Tx,
    input: {
      enrolmentId: string;
      wawuUserId: string;
      contact: StudentContact;
      consentAt: Date;
    },
  ): Promise<void> {
    await tx.schoolEnrolmentReport.create({
      data: {
        enrolmentId: input.enrolmentId,
        wawuUserId: input.wawuUserId,
        studentName: input.contact.name,
        studentEmail: input.contact.email,
        studentPhone: input.contact.phone,
        consentAt: input.consentAt,
      },
    });
  }

  /**
   * Sends one report if it is due. Never throws for a mail that did not go:
   * the answer says what happened and the sweep tries again.
   */
  async deliver(
    enrolmentId: string,
    now: Date = new Date(),
  ): Promise<ReportOutcome> {
    const claimed = await this.prisma.schoolEnrolmentReport.updateMany({
      where: {
        enrolmentId,
        sentAt: null,
        gaveUpAt: null,
        enrolment: { status: 'enrolled' },
        AND: [
          { OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] },
          { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
        ],
      },
      data: {
        leaseUntil: new Date(now.getTime() + REPORT_LEASE_MS),
        attempts: { increment: 1 },
      },
    });
    if (claimed.count === 0) return 'not_due';

    const row = await this.prisma.schoolEnrolmentReport.findUniqueOrThrow({
      where: { enrolmentId },
      include: {
        enrolment: {
          select: {
            reference: true,
            courseTitle: true,
            schoolName: true,
            intakeStartDate: true,
            intakeSchedule: true,
            intakeLocation: true,
            school: { select: { reportEmail: true } },
          },
        },
      },
    });
    const student: StudentContact = {
      name: row.studentName,
      email: row.studentEmail,
      phone: row.studentPhone,
    };
    if (row.wawuUserId === null) {
      // The student's account is gone (the purge clears the id and the
      // details together): nothing to send. A token that gave no name, email
      // or phone is not this: the account is there, and the school is told
      // what exists (the course, the reference, the consent).
      await this.giveUp(enrolmentId, 'the student removed their account');
      return 'gave_up';
    }
    const e = row.enrolment;
    const mail = reportMail({
      schoolName: e.schoolName,
      courseTitle: e.courseTitle,
      intakeStartDate: e.intakeStartDate.toISOString().slice(0, 10),
      intakeSchedule: e.intakeSchedule,
      intakeLocation: e.intakeLocation,
      reference: e.reference,
      consentAt: row.consentAt,
      student,
    });

    const result = await this.relay.send({
      from: '',
      to: e.school.reportEmail,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      headers: {},
      idempotencyKey: reportMailKey(enrolmentId),
    });

    if (result.ok) {
      await this.prisma.schoolEnrolmentReport.updateMany({
        where: { enrolmentId, sentAt: null },
        data: {
          sentAt: new Date(),
          messageId: result.id.slice(0, 200),
          lastError: null,
          leaseUntil: null,
          nextAttemptAt: null,
          studentName: null,
          studentEmail: null,
          studentPhone: null,
        },
      });
      return 'sent';
    }

    // The address is never logged, only what went wrong.
    const why = `${result.transient ? 'transient' : 'refused'}: ${result.error}`;
    if (row.attempts >= REPORT_MAX_ATTEMPTS) {
      await this.giveUp(enrolmentId, why);
      return 'gave_up';
    }
    await this.prisma.schoolEnrolmentReport.updateMany({
      where: { enrolmentId, sentAt: null },
      data: {
        leaseUntil: null,
        lastError: why.slice(0, 300),
        nextAttemptAt: new Date(Date.now() + reportRestMs(row.attempts)),
      },
    });
    this.logger.warn(
      `school report ${enrolmentId}: try ${row.attempts} did not go (${why.slice(0, 120)})`,
    );
    return 'waiting';
  }

  private async giveUp(enrolmentId: string, why: string): Promise<void> {
    const { count } = await this.prisma.schoolEnrolmentReport.updateMany({
      where: { enrolmentId, sentAt: null, gaveUpAt: null },
      data: {
        gaveUpAt: new Date(),
        leaseUntil: null,
        nextAttemptAt: null,
        lastError: why.slice(0, 300),
        studentName: null,
        studentEmail: null,
        studentPhone: null,
      },
    });
    if (count > 0) {
      this.logger.error(
        `school report ${enrolmentId}: given up (${why.slice(0, 120)}); the school was not told`,
      );
    }
  }

  /**
   * Best effort straight after an order becomes `enrolled`: the sweep is the
   * safety net, so a failure here is never the enrolment's.
   */
  async deliverQuietly(enrolmentId: string): Promise<void> {
    try {
      await this.deliver(enrolmentId);
    } catch (e) {
      this.logger.error(
        `school report ${enrolmentId}: the send could not be tried (${e instanceof Error ? e.name : 'error'})`,
      );
    }
  }

  /** Every minute: reports that are due, and a month-old copy of an order that never enrolled. */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'school-report-send' })
  async sweep(now: Date = new Date()): Promise<{ sent: number }> {
    const out = { sent: 0 };
    if (this.sweeping) return out;
    this.sweeping = true;
    try {
      const due = await this.prisma.schoolEnrolmentReport.findMany({
        where: {
          sentAt: null,
          gaveUpAt: null,
          enrolment: { status: 'enrolled' },
          AND: [
            { OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] },
            { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
          ],
        },
        orderBy: { createdAt: 'asc' },
        take: REPORT_SWEEP_BATCH,
        select: { enrolmentId: true },
      });
      for (const { enrolmentId } of due) {
        try {
          if ((await this.deliver(enrolmentId, now)) === 'sent') out.sent += 1;
        } catch (e) {
          this.logger.error(
            `school report ${enrolmentId}: the sweep could not send it (${e instanceof Error ? e.name : 'error'})`,
          );
        }
      }
      await this.prisma.schoolEnrolmentReport.updateMany({
        where: {
          sentAt: null,
          enrolment: {
            status: { in: ['released', 'refunded'] },
            updatedAt: {
              lte: new Date(
                now.getTime() - REPORT_UNUSED_KEEP_DAYS * 86_400_000,
              ),
            },
          },
          NOT: {
            studentName: null,
            studentEmail: null,
            studentPhone: null,
          },
        },
        data: { studentName: null, studentEmail: null, studentPhone: null },
      });
    } catch (e) {
      this.logger.error(
        `school report sweep failed (${e instanceof Error ? e.name : 'error'})`,
      );
    } finally {
      this.sweeping = false;
    }
    return out;
  }
}
