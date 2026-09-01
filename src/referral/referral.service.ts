import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import type { CreatorTier } from '../../generated/prisma/enums';

/**
 * Referral codes, and the switch that makes them the only way in.
 *
 * A code is an INVITATION and a PRICE in one object. A blog is given one so
 * its readers can join at a discount; a hand-picked creator is given one so
 * they can join at all while public signup is closed. Splitting those into two
 * systems would mean two things that have to agree about who is allowed in.
 *
 * A 0% code is therefore not a broken code — it is how somebody is let through
 * the closed door at the normal price.
 */

/** What the client is told about a code. Never exposes usage or who redeemed. */
export interface ReferralCodeView {
  code: string;
  discountPercent: number;
  tier: CreatorTier;
  /** The plan price after the discount, in naira, so nothing is recomputed client-side. */
  priceNaira: number;
  originalPriceNaira: number;
}

export interface AdminReferralCodeView extends ReferralCodeView {
  label: string;
  active: boolean;
  maxUses: number | null;
  usedCount: number;
  expiresAt: string | null;
  createdAt: string;
}

@Injectable()
export class ReferralService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Codes are matched uppercase and trimmed.
   *
   * They are read off a blog post and typed by hand, so case and a stray space
   * are typos, not distinctions — a code that works in the email and fails in
   * the form is the most annoying possible bug here.
   */
  static normalise(code: string): string {
    return code.trim().toUpperCase();
  }

  discountedPrice(fullPrice: number, discountPercent: number): number {
    // Rounded to whole naira. Kobo does not exist on these prices anywhere
    // else in the product, and a fractional plan price would render as one.
    return Math.round(fullPrice * (1 - discountPercent / 100));
  }

  async userSignupEnabled(): Promise<boolean> {
    const row = await this.prisma.platformSettings.findUnique({ where: { id: 1 } });
    // Absent row means nothing has been configured, and the safe reading of
    // "not configured" is the product's normal state: open.
    return row?.userSignupEnabled ?? true;
  }

  async setUserSignupEnabled(enabled: boolean): Promise<{ userSignupEnabled: boolean }> {
    const row = await this.prisma.platformSettings.upsert({
      where: { id: 1 },
      create: { id: 1, userSignupEnabled: enabled },
      update: { userSignupEnabled: enabled },
    });
    return { userSignupEnabled: row.userSignupEnabled };
  }

  /**
   * Validates a code and prices it, WITHOUT redeeming it.
   *
   * Called while somebody is still typing it into a form, so it must be free
   * of side effects — incrementing a use here would burn a single-use code on
   * a keystroke.
   */
  async validate(rawCode: string, priceTable: Record<CreatorTier, number>): Promise<ReferralCodeView> {
    const code = ReferralService.normalise(rawCode);
    const row = await this.prisma.referralCode.findUnique({ where: { code } });

    // One message for every rejection. Distinguishing "no such code" from
    // "expired" from "used up" tells somebody probing which guesses were
    // real codes.
    if (!row || !row.active) throw new NotFoundException('That code is not valid.');
    if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
      throw new NotFoundException('That code is not valid.');
    }
    if (row.maxUses !== null && row.usedCount >= row.maxUses) {
      throw new NotFoundException('That code is not valid.');
    }

    const originalPriceNaira = priceTable[row.tier];
    return {
      code: row.code,
      discountPercent: row.discountPercent,
      tier: row.tier,
      originalPriceNaira,
      priceNaira: this.discountedPrice(originalPriceNaira, row.discountPercent),
    };
  }

  /**
   * Claims one use of a code for one account.
   *
   * Race-safe: the use count is incremented with the prior count in the WHERE
   * clause, so two people spending the last use of a code cannot both win.
   * The redemption row's unique key does the same job for one account
   * spending the same code twice.
   */
  async redeem(rawCode: string, wawuUserId: string, tier: CreatorTier): Promise<void> {
    const code = ReferralService.normalise(rawCode);
    const row = await this.prisma.referralCode.findUnique({ where: { code } });
    if (!row || !row.active) throw new NotFoundException('That code is not valid.');
    if (row.tier !== tier) {
      throw new BadRequestException(
        `That code applies to the ${row.tier.replace('_', ' ')} plan.`,
      );
    }

    const already = await this.prisma.referralRedemption.findUnique({
      where: { code_wawuUserId: { code, wawuUserId } },
    });
    if (already) return; // Idempotent: paying twice on a retry must not consume two uses.

    if (row.maxUses !== null) {
      const claimed = await this.prisma.referralCode.updateMany({
        where: { code, usedCount: { lt: row.maxUses } },
        data: { usedCount: { increment: 1 } },
      });
      if (claimed.count === 0) throw new NotFoundException('That code is not valid.');
    } else {
      await this.prisma.referralCode.update({
        where: { code },
        data: { usedCount: { increment: 1 } },
      });
    }

    await this.prisma.referralRedemption.create({ data: { code, wawuUserId } });
  }

  /**
   * The gate on creating a REGULAR (non-creator) account.
   *
   * Creator signup is never gated by this — the product is onboarding
   * creators, so closing the door on them would be backwards. A valid
   * referral code lets a regular account through anyway, which is how a
   * hand-picked early user is admitted.
   *
   * The code is NOT redeemed here. Creating an account is not the same act as
   * buying a plan, and burning a single-use code on a signup that never
   * subscribes would waste it.
   */
  async assertMayCreateUserAccount(rawCode: string | undefined): Promise<void> {
    if (await this.userSignupEnabled()) return;
    if (!rawCode) {
      throw new ForbiddenException(
        'WAWU is onboarding creators by invitation right now. Enter the code you were given to continue.',
      );
    }
    const code = ReferralService.normalise(rawCode);
    const row = await this.prisma.referralCode.findUnique({ where: { code } });
    if (!row || !row.active) throw new ForbiddenException('That code is not valid.');
    if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
      throw new ForbiddenException('That code is not valid.');
    }
    if (row.maxUses !== null && row.usedCount >= row.maxUses) {
      throw new ForbiddenException('That code is not valid.');
    }
  }
}
