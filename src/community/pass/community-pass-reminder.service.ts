import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationService } from '../../notification/notification.service';
import { reminderWindowEnd } from './community-pass-rules';

/** Passes looked at in one pass of the sweep; the rest wait for the next. */
export const REMINDERS_PER_RUN = 500;

/**
 * The reminder 3 days before a monthly pass ends (task INBOX-24, R-63): one
 * in-app notice, pushed to the phone through INBOX-03 (the kind
 * `community_pass_ending` is sent by the push policy), with the renew tap as
 * its destination. It only tells the person. Nothing is debited, here or
 * anywhere: renewing is a payment the person confirms with their PIN.
 *
 * **One per pass.** A pass is reminded when it is the person's latest (no later
 * pass of theirs in the room, so a person who already renewed is not told to),
 * still running, inside the 3 day window, and its member is still in the room.
 * The pass row is claimed first with a conditional write
 * (`reminderSentAt IS NULL`), so two servers, or two runs, notify once.
 * `NotificationService.emit` never throws; a lost notice is the lesser harm
 * to a claimed, never repeated one.
 */
@Injectable()
export class CommunityPassReminderService {
  private readonly logger = new Logger(CommunityPassReminderService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'community-pass-reminders' })
  async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const sent = await this.run();
      if (sent > 0) this.logger.log(`Sent ${sent} pass reminders.`);
    } catch (e) {
      this.logger.error(
        `The pass reminders failed (${e instanceof Error ? e.name : 'error'}).`,
      );
    } finally {
      this.running = false;
    }
  }

  /** The sweep itself, callable directly. Returns how many reminders it sent. */
  async run(now: Date = new Date()): Promise<number> {
    const windowEnd = reminderWindowEnd(now);
    // The passes that are due (a store pass is not one: the store renews it, IAP-01): running, inside the window, not reminded, the
    // person's latest in the room (so not renewed), and the person still in.
    const due = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT p."id"
        FROM "CommunityPass" p
       WHERE p."reminderSentAt" IS NULL
         AND p."endsAt" > ${now} AND p."endsAt" <= ${windowEnd}
         AND p."walletPaymentId" NOT LIKE 'store:%'
         AND NOT EXISTS (SELECT 1 FROM "CommunityPass" q
                          WHERE q."communityId" = p."communityId"
                            AND q."userWawuId" = p."userWawuId"
                            AND q."endsAt" > p."endsAt")
         AND EXISTS (SELECT 1 FROM "CommunityMembership" m
                      WHERE m."communityId" = p."communityId"
                        AND m."userWawuId" = p."userWawuId"
                        AND m."status" = 'joined')
       ORDER BY p."endsAt" ASC, p."id" ASC
       LIMIT ${REMINDERS_PER_RUN}`);
    let sent = 0;
    for (const { id } of due) {
      // Claim it first, with a conditional write: of two servers, one wins.
      const claimed = await this.prisma.communityPass.updateMany({
        where: { id, reminderSentAt: null },
        data: { reminderSentAt: now },
      });
      if (claimed.count !== 1) continue;
      const pass = await this.prisma.communityPass.findUniqueOrThrow({
        where: { id },
        include: { community: { select: { name: true } } },
      });
      await this.notifications.emit({
        kind: 'community_pass_ending',
        userWawuId: pass.userWawuId,
        communityId: pass.communityId,
        communityName: pass.community.name,
        endsAt: pass.endsAt,
      });
      sent += 1;
    }
    return sent;
  }
}
