import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { BlockedAccountService } from '../blocked-account/blocked-account.service';

/** The one wording every "you cannot see this person" answer uses. */
export const USER_NOT_FOUND = 'User not found';

/**
 * A path value Postgres could be asked about. A NUL byte in a string makes
 * the driver throw (a 500 for the caller), and nothing real is that long, so
 * either one is simply "no such thing".
 */
export function isSafeLookupKey(value: string): boolean {
  return value.length > 0 && value.length <= 128 && !value.includes('\u0000');
}

/**
 * Who may read somebody's featured works and education (ME-16).
 *
 * A visitor sees the page of a person who has a public creator profile (the
 * same rule `GET /users/:wawuId/profile-fields` applies), and never the page
 * of a person who blocked them or whom they blocked, in either direction.
 *
 * Three different reasons to refuse, ONE answer: an unknown id, an account
 * with no public creator profile and a blocked pair all give the same 404 with
 * the same message, so the response can never be used to learn that somebody
 * blocked you, or that an account exists. The owner reading their own page
 * is always let in: nobody is hidden from themselves.
 */
@Injectable()
export class ProfileAudienceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly blockedAccounts: BlockedAccountService,
  ) {}

  /**
   * The WAWU ID of the profile `idOrHandle` names, when `viewer` may read its
   * works and education. Throws the one 404 otherwise.
   */
  async resolveVisible(idOrHandle: string, viewer: string): Promise<string> {
    if (!isSafeLookupKey(idOrHandle))
      throw new NotFoundException(USER_NOT_FOUND);
    const profile =
      (await this.prisma.userProfile.findUnique({
        where: { wawuUserId: idOrHandle },
        select: { wawuUserId: true },
      })) ??
      (await this.prisma.userProfile.findUnique({
        where: { handle: idOrHandle.replace(/^@/, '') },
        select: { wawuUserId: true },
      }));
    if (!profile) throw new NotFoundException(USER_NOT_FOUND);
    const owner = profile.wawuUserId;
    if (owner === viewer) return owner;

    if (await this.blockedAccounts.isBlockedEitherWay(viewer, owner)) {
      throw new NotFoundException(USER_NOT_FOUND);
    }
    const creator = await this.prisma.creatorState.findUnique({
      where: { wawuUserId: owner },
      select: { wawuUserId: true },
    });
    if (!creator) throw new NotFoundException(USER_NOT_FOUND);
    return owner;
  }
}
