import { Injectable } from '@nestjs/common';
import type { Prisma, ReferralCode } from '../../../generated/prisma/client';
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

  /** How many places are taken under the code at `now`: paid, and held. */
  async usage(
    db: Db,
    code: string,
    now: Date,
  ): Promise<{ paid: number; held: number }> {
    const paid = await db.waitlistRegistration.count({
      where: { referralCode: code, status: WaitlistStatus.paid },
    });
    const held = await db.waitlistRegistration.count({
      where: {
        referralCode: code,
        status: WaitlistStatus.pending,
        createdAt: { gt: new Date(now.getTime() - REFERRAL_HOLD_MS) },
      },
    });
    return { paid, held };
  }

  /** Whether one more person may use the code: it is on, and under its limit. */
  async decide(
    db: Db,
    row: ReferralCode,
    now: Date,
  ): Promise<ReferralDecision> {
    if (!row.active) return { applied: false, reason: 'inactive' };
    if (row.usageLimit === null) return { applied: true };
    const { paid, held } = await this.usage(db, row.code, now);
    return paid + held >= row.usageLimit
      ? { applied: false, reason: 'full' }
      : { applied: true };
  }
}
