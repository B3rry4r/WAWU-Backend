import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { AccountType } from '../../generated/prisma/enums';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  EXPLORE_CATEGORIES,
  normaliseInterest,
} from '../explore/explore-categories';
import { MIN_SIGNUP_INTERESTS } from './signup-interests';

export interface InterestOption {
  id: string;
  label: string;
}

export interface InterestsView {
  /** How many a person picks before A12 lets them on. */
  minimum: number;
  /** The chips, in the order drawn. The same twelve as Explore's categories. */
  options: InterestOption[];
  /** The ids already saved on this person's profile, in the chips' order. */
  selected: string[];
}

/**
 * What the sign-up sequence writes to the Hub's profile (AUTH-06): the account
 * type picked at A2 and the interests picked at A12. Neither opens a wallet
 * (R-6): `PATCH /users/me` does for a creator (BACKEND_GAPS G-34), so these are
 * routes of their own, and the web's route is left exactly as it is.
 */
@Injectable()
export class SignupProfileService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records the account type and creates the profile row when there is none, so
   * `GET /users/me` answers it right after sign-up. Idempotent. A person only
   * ever moves from `user` to `creator` here: a request for `user` on a creator
   * changes nothing, and the answer names the type the profile holds, so the
   * caller reads the truth and not its own request.
   */
  async setAccountType(
    wawuUserId: string,
    want: 'user' | 'creator',
  ): Promise<{ accountType: AccountType }> {
    const row = await this.prisma.userProfile.upsert({
      where: { wawuUserId },
      create: { wawuUserId, accountType: want, interests: [] },
      update: {},
      select: { accountType: true },
    });
    if (row.accountType === AccountType.user && want === 'creator') {
      // Only a `user` row moves, and in one statement: two taps at once both end as `creator`.
      await this.prisma.userProfile.updateMany({
        where: { wawuUserId, accountType: AccountType.user },
        data: { accountType: AccountType.creator },
      });
      return { accountType: AccountType.creator };
    }
    return { accountType: row.accountType };
  }

  async getInterests(wawuUserId: string): Promise<InterestsView> {
    const profile = await this.prisma.userProfile.findUnique({
      where: { wawuUserId },
      select: { interests: true },
    });
    const held = new Set((profile?.interests ?? []).map(normaliseInterest));
    return {
      minimum: MIN_SIGNUP_INTERESTS,
      options: EXPLORE_CATEGORIES.map((c) => ({ id: c.id, label: c.label })),
      selected: EXPLORE_CATEGORIES.filter((c) =>
        held.has(normaliseInterest(c.id)),
      ).map((c) => c.id),
    };
  }

  /**
   * Saves the picked ids as the profile's chip interests. An interest on the
   * profile that is none of the twelve (a creator's own tags) stays after them,
   * so a save here never wipes what the profile editor wrote.
   */
  async saveInterests(
    wawuUserId: string,
    picked: string[],
  ): Promise<InterestsView> {
    const chips = new Set(
      EXPLORE_CATEGORIES.map((c) => normaliseInterest(c.id)),
    );
    try {
      const existing = await this.prisma.userProfile.findUnique({
        where: { wawuUserId },
        select: { interests: true },
      });
      const own = (existing?.interests ?? []).filter(
        (i) => !chips.has(normaliseInterest(i)),
      );
      await this.prisma.userProfile.upsert({
        where: { wawuUserId },
        create: {
          wawuUserId,
          accountType: AccountType.user,
          interests: picked,
        },
        update: { interests: [...picked, ...own] },
      });
    } catch (error) {
      if (!(
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      )) {
        throw error;
      }
      // Two first saves raced to make the row: the second finds it and updates.
      await this.prisma.userProfile.update({
        where: { wawuUserId },
        data: { interests: picked },
      });
    }
    return this.getInterests(wawuUserId);
  }
}
