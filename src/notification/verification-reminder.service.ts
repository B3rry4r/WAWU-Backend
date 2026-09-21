import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../common/prisma/prisma.service';
import { NotificationService } from './notification.service';
import type { NotificationEvent } from './notification-event';

/**
 * How long a reminded account is left alone before the next prompt.
 *
 * Build brief B1 asks for prompts that are "persistent, recurring". Persistent
 * is the point; daily is harassment, and an account that has been reminded
 * eleven times has told you something a twelfth will not fix. Fortnightly is
 * the slowest cadence that still reads as persistent.
 */
export const REMINDER_INTERVAL_DAYS = 14;

/**
 * Accounts reminded per run. A ceiling rather than a target: this exists so a
 * first run against a large unverified population is a known amount of work
 * instead of an unbounded one, and the rest are picked up tomorrow.
 */
export const REMINDERS_PER_RUN = 1000;

const DAY_MS = 86_400_000;

/**
 * The mechanism behind build brief B1's "unverified creators and
 * professionals receive persistent, recurring prompts to verify".
 *
 * ── WHY THIS IS A REAL MECHANISM AND NOT A STRING ────────────────────────────
 * The `unbacked_promises` gate exists because this repo shipped "We'll notify
 * you when you're verified" with nothing behind it. The prompt this service
 * sends is the opposite shape on purpose: it makes no promise about a future
 * act at all. It states two things that are true the moment somebody is
 * approved (the tick renders, and the verification screen takes a submission)
 * and it opens that screen. The only recurring behaviour it claims is the one
 * this file implements.
 *
 * ── WHO GETS ONE ─────────────────────────────────────────────────────────────
 * Answerable entirely from this database, which is the constraint that shaped
 * it:
 *   creators            UserProfile.accountType = creator
 *   professionals       an APPROVED ProfessionalProfile
 *   verified            at least one APPROVED VerificationSubmission
 * and the audience is (creators + professionals) minus verified.
 *
 * "Verified" is read as an approved submission rather than as the
 * `verificationTier` claim because that claim lives on WAWU ID, a separate
 * service this backend cannot query per user. The two agree in practice:
 * VerificationSubmissionService.review() elevates the tier at WAWU ID and
 * writes the approved row in the same transition, so an approved row is
 * exactly the set of accounts whose tier was raised from here.
 *
 * ── WHY IT LIVES HERE AND NOT IN SchedulerService ────────────────────────────
 * Every other sweep in this backend is a method on SchedulerService. This one
 * is not, because it is not a sweep over a transaction that has gone stale:
 * it is part of the notification vocabulary itself, it shares this module's
 * frequency rule and its copy, and a reviewer reading `verify_reminder` in
 * notification-event.ts should find its only writer in the same directory.
 * @Cron is inert without ScheduleModule.forRoot(), which app.module.ts
 * registers, so contract suites that mount NotificationModule alone get the
 * method and no timer.
 */
@Injectable()
export class VerificationReminderService {
  private readonly logger = new Logger(VerificationReminderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
  ) {}

  /**
   * Mid-morning rather than overnight: this is a prompt to go and do
   * something, and a notification that lands at 3am is read at 9am with a
   * night of other rows on top of it.
   */
  @Cron(CronExpression.EVERY_DAY_AT_9AM, { name: 'remind-unverified-to-verify' })
  async remindUnverified(): Promise<void> {
    const written = await this.run();
    if (written > 0) {
      this.logger.log(`Sent ${written} verification reminders.`);
    }
  }

  /**
   * The sweep itself, callable directly. Idempotent within
   * REMINDER_INTERVAL_DAYS: running it twice in one day sends nothing the
   * second time, because the frequency check reads the notifications the
   * first run wrote rather than a "last reminded" column that could drift
   * away from them.
   */
  async run(now: Date = new Date()): Promise<number> {
    const since = new Date(now.getTime() - REMINDER_INTERVAL_DAYS * DAY_MS);

    const [creators, professionals, verified] = await Promise.all([
      this.prisma.userProfile.findMany({
        where: { accountType: 'creator' },
        select: { wawuUserId: true },
      }),
      this.prisma.professionalProfile.findMany({
        where: { status: 'approved' },
        select: { wawuUserId: true },
        distinct: ['wawuUserId'],
      }),
      this.prisma.verificationSubmission.findMany({
        where: { status: 'approved' },
        select: { wawuUserId: true },
        distinct: ['wawuUserId'],
      }),
    ]);

    const verifiedIds = new Set(verified.map((v) => v.wawuUserId));
    const professionalIds = new Set(professionals.map((p) => p.wawuUserId));

    // A professional who is also a creator account is one person and gets one
    // prompt. The professional wording wins: it is the stronger claim of the
    // two and the one whose credentials they already sent us.
    const candidates = new Map<string, 'creator' | 'professional'>();
    for (const id of professionalIds) {
      if (!verifiedIds.has(id)) candidates.set(id, 'professional');
    }
    for (const { wawuUserId } of creators) {
      if (verifiedIds.has(wawuUserId)) continue;
      if (!candidates.has(wawuUserId)) candidates.set(wawuUserId, 'creator');
    }
    if (candidates.size === 0) return 0;

    const recentlyReminded = new Set(
      (
        await this.prisma.notification.findMany({
          where: {
            kind: 'verify_reminder',
            userWawuId: { in: [...candidates.keys()] },
            createdAt: { gte: since },
          },
          select: { userWawuId: true },
          distinct: ['userWawuId'],
        })
      ).map((n) => n.userWawuId),
    );

    const due: NotificationEvent[] = [];
    for (const [userWawuId, audience] of candidates) {
      if (recentlyReminded.has(userWawuId)) continue;
      due.push({ kind: 'verify_reminder', userWawuId, audience });
      if (due.length >= REMINDERS_PER_RUN) break;
    }

    return this.notifications.emitMany(due);
  }
}
