import { Injectable } from '@nestjs/common';
import { Prisma, type ReferralCode } from '../../../generated/prisma/client';
import { WaitlistStatus } from '../../../generated/prisma/enums';
import { PrismaService } from '../../common/prisma/prisma.service';
import { REFERRAL_HOLD_MS } from '../waitlist-config';
import type { ReferralNotApplied } from './referral-code';

type Db = PrismaService | Prisma.TransactionClient;

/** What a code's limit says about one more person. */
export type ReferralDecision =
  { applied: true } | { applied: false; reason: ReferralNotApplied };

/**
 * Referral codes, as the registration needs them (REF-01).
 *
 * THE LIMIT. A code's limit counts the registrations that hold a place under
 * it: every `paid` one, and every unpaid (`pending`) one started in the last
 * REFERRAL_HOLD_MS (a held place, so a person on the payment window is not
 * overtaken). A `failed` row (a second payment kept for a refund) holds
 * nothing. A held place that is paid after its hold ended is honoured: the
 * payment settles by its own checks and never looks at the limit.
 *
 * ONE PERSON, ONE PLACE (SWEEP-JOIN D3). Held places are counted by person,
 * never by registration: the unpaid starts of one phone or one email are one
 * place, however many times they were started, so repeating the call cannot
 * use up a limited code's places. A person's own earlier unpaid starts are
 * left out when they start another, so someone who closed the checkout and
 * begins again keeps their place instead of finding the code full. People are
 * counted as the larger of the distinct phones and the distinct emails among
 * the unpaid starts: a family sharing an email count as several, and changing
 * only the phone or only the email does not make a new person.
 *
 * THE RACE. Two people asking for the last place must not both get it. The
 * registration locks the code's row (`SELECT ... FOR UPDATE`) inside the same
 * transaction that counts and inserts, so the second one waits for the first
 * to commit and then counts its row. Nothing here counts outside that lock
 * except the public check, which only advises: the registration decides again.
 */
@Injectable()
export class ReferralService {
  constructor(private readonly prisma: PrismaService) {}

  /** The code's row, or null when no code has this (already upper case) text. */
  find(code: string): Promise<ReferralCode | null> {
    return this.prisma.referralCode.findUnique({ where: { code } });
  }

  /**
   * The code's row, locked until the transaction ends. Null when there is no
   * such code. Call it first in the transaction, before counting.
   */
  async lock(
    tx: Prisma.TransactionClient,
    code: string,
  ): Promise<ReferralCode | null> {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "ReferralCode" WHERE "code" = ${code} FOR UPDATE`;
    if (locked.length === 0) return null;
    return tx.referralCode.findUnique({ where: { id: locked[0].id } });
  }

  /**
   * How many places are taken under the code at `now`: paid, and held. The
   * held count is people (see ONE PERSON, ONE PLACE), and leaves out the
   * unpaid starts of `requester` when one is named: they are about to be
   * replaced by the start being decided.
   */
  async usage(
    db: Db,
    code: string,
    now: Date,
    requester?: { phone: string; email: string },
  ): Promise<{ paid: number; held: number }> {
    const paid = await db.waitlistRegistration.count({
      where: { referralCode: code, status: WaitlistStatus.paid },
    });
    const since = new Date(now.getTime() - REFERRAL_HOLD_MS);
    const own = requester
      ? Prisma.sql`AND "phone" <> ${requester.phone} AND "email" <> ${requester.email}`
      : Prisma.empty;
    const people = await db.$queryRaw<{ phones: number; emails: number }[]>(
      Prisma.sql`
        SELECT COUNT(DISTINCT "phone")::int AS "phones",
               COUNT(DISTINCT "email")::int AS "emails"
        FROM "WaitlistRegistration"
        WHERE "referralCode" = ${code}
          AND "status" = 'pending'::"WaitlistStatus"
          AND "createdAt" > (${since}::timestamptz AT TIME ZONE 'UTC')
          ${own}`,
    );
    const held = Math.max(people[0]?.phones ?? 0, people[0]?.emails ?? 0);
    return { paid, held };
  }

  /**
   * Held places per code at `now`, counted as `usage` counts them, for the
   * team's list. Codes with none held are absent.
   */
  async heldByCode(db: Db, now: Date): Promise<Map<string, number>> {
    const since = new Date(now.getTime() - REFERRAL_HOLD_MS);
    const rows = await db.$queryRaw<
      { code: string; phones: number; emails: number }[]
    >(Prisma.sql`
      SELECT "referralCode" AS "code",
             COUNT(DISTINCT "phone")::int AS "phones",
             COUNT(DISTINCT "email")::int AS "emails"
      FROM "WaitlistRegistration"
      WHERE "referralCode" IS NOT NULL
        AND "status" = 'pending'::"WaitlistStatus"
        AND "createdAt" > (${since}::timestamptz AT TIME ZONE 'UTC')
      GROUP BY "referralCode"`);
    return new Map(rows.map((r) => [r.code, Math.max(r.phones, r.emails)]));
  }

  /** Whether one more person may use the code: it is on, and under its limit. */
  async decide(
    db: Db,
    row: ReferralCode,
    now: Date,
    requester?: { phone: string; email: string },
  ): Promise<ReferralDecision> {
    if (!row.active) return { applied: false, reason: 'inactive' };
    if (row.usageLimit === null) return { applied: true };
    const { paid, held } = await this.usage(db, row.code, now, requester);
    return paid + held >= row.usageLimit
      ? { applied: false, reason: 'full' }
      : { applied: true };
  }
}
