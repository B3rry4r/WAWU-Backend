import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { AccountType } from '../../generated/prisma/enums';
import { WawuIdClient } from '../common/auth/wawu-id.client';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { PrismaService } from '../common/prisma/prisma.service';
import type { ChangeHandleDto } from './dto/change-handle.dto';
import type { CompleteIdentityDto } from './dto/complete-identity.dto';
import type { HandleAvailabilityView } from './dto/handle-availability.dto';
import { checkHandleShape, HANDLE_MESSAGES } from './handle-rules';

export interface IdentityView {
  firstName: string | null;
  lastName: string | null;
  handle: string | null;
}

export const NAMES_TOGETHER = 'Enter your first name and your last name.';
export const NAME_CHARACTERS =
  'Your name has a character that cannot be saved. Remove it and try again.';
/** Control characters (a NUL byte, a tab, a line break, DEL and the C1 range: Unicode's Cc) have no place in a name. */
const CONTROL_CHARACTERS = /\p{Cc}/u;
export const NOTHING_TO_SAVE = 'Send a name or a username to save.';

/**
 * The name and the username a person gives at sign-up (SIGNUP-NAMES, R-82).
 *
 * WHERE THEY LIVE. The name is WAWU ID's, as it always was (a government-ID match depends on it), and is saved
 * there. The username is the Hub profile's `handle`, the @handle the app already shows and links to, so it has
 * one home and one set of rules; there is no second username anywhere.
 *
 * UNIQUE IGNORING CASE. The column's own unique index is case sensitive, and rows written before this task may
 * already differ only by case, so an index on `lower(handle)` could not be added without choosing a loser.
 * The rule is kept here instead: a claim takes a lock on the lowercase name for the length of one short
 * transaction, looks for anyone else holding the name in any case, and writes. Nothing waits on a network call
 * while the lock is held. The look compares `lower(handle) = lower($1)` and never `ILIKE` (Prisma's
 * `mode: 'insensitive'`): `_` is allowed in a username and is a one-character wildcard in a pattern, so `sg_wXild`
 * would have held `sg_wXil_` too (verifier M1).
 *
 * TWO DOORS, ONE RULE SET. `PUT /users/me/identity` completes a profile (sign-up, and the step an old account is
 * shown once); `PUT /users/me/handle` is the app's Edit profile changing a username it already has. Both go
 * through `checkHandleShape` and `claim`, so the characters, the length, the reserved words, the case-blind
 * uniqueness and the lock are the same. `PATCH /users/me` is a route the web calls and stays as it was.
 */
@Injectable()
export class SignupIdentityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wawuId: WawuIdClient,
  ) {}

  /** Free or taken, for the sign-up form while a person types. Reads only; says nothing about who holds a name. */
  async availability(
    typed: string | undefined,
  ): Promise<HandleAvailabilityView> {
    const shape = checkHandleShape(typed);
    if (!shape.ok) {
      return {
        handle: (typed ?? '').trim().replace(/^@+/, ''),
        available: false,
        message: shape.message,
      };
    }
    const holders = await this.prisma.$queryRaw<
      { wawuUserId: string }[]
    >`SELECT "wawuUserId" FROM "UserProfile" WHERE lower("handle") = lower(${shape.handle}) LIMIT 1`;
    return holders.length > 0
      ? {
          handle: shape.handle,
          available: false,
          message: HANDLE_MESSAGES.taken,
        }
      : { handle: shape.handle, available: true, message: null };
  }

  /** Saves the parts that were sent. Idempotent: the same call again changes nothing and answers the same. */
  async complete(
    claims: WawuJwtClaims,
    dto: CompleteIdentityDto,
  ): Promise<IdentityView> {
    const first = dto.firstName?.trim();
    const last = dto.lastName?.trim();
    const sendsName = dto.firstName !== undefined || dto.lastName !== undefined;
    if (sendsName && (!first || !last)) {
      throw new BadRequestException(NAMES_TOGETHER);
    }
    if (
      (first && CONTROL_CHARACTERS.test(first)) ||
      (last && CONTROL_CHARACTERS.test(last))
    ) {
      throw new BadRequestException(NAME_CHARACTERS);
    }
    if (!sendsName && dto.handle === undefined) {
      throw new BadRequestException(NOTHING_TO_SAVE);
    }
    let wanted: string | null = null;
    if (dto.handle !== undefined) {
      const shape = checkHandleShape(dto.handle);
      if (!shape.ok) throw new BadRequestException(shape.message);
      wanted = shape.handle;
    }

    // The username first: it is the part another person can take, and it is one short transaction.
    const handle = wanted
      ? await this.claim(claims.sub, wanted, false)
      : await this.heldBy(claims.sub);

    // The name second, outside any lock. A failure here leaves the username claimed, and the same call again completes.
    if (first && last) {
      await this.wawuId.updateName(claims.sub, {
        firstName: first,
        lastName: last,
      });
    }
    return {
      firstName: first ?? claims.firstName ?? null,
      lastName: last ?? claims.lastName ?? null,
      handle,
    };
  }

  /**
   * The app's Edit profile changing a username (SIGNUP-NAMES round 3, M2). The same checks and the same lock as
   * a claim at sign-up; the only difference is that a person who already has a username may take another.
   * Idempotent: asking for the name already held answers the same. Its old name is free the moment this commits.
   */
  async changeHandle(
    claims: WawuJwtClaims,
    dto: ChangeHandleDto,
  ): Promise<{ handle: string }> {
    const shape = checkHandleShape(dto.handle);
    if (!shape.ok) throw new BadRequestException(shape.message);
    return { handle: await this.claim(claims.sub, shape.handle, true) };
  }

  private async heldBy(wawuUserId: string): Promise<string | null> {
    const row = await this.prisma.userProfile.findUnique({
      where: { wawuUserId },
      select: { handle: true },
    });
    return row?.handle ?? null;
  }

  private async claim(
    wawuUserId: string,
    handle: string,
    mayChange: boolean,
  ): Promise<string> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`handle:${handle.toLowerCase()}`}, 0))`;
        const others = await tx.$queryRaw<
          { wawuUserId: string }[]
        >`SELECT "wawuUserId" FROM "UserProfile" WHERE lower("handle") = lower(${handle}) AND "wawuUserId" <> ${wawuUserId} LIMIT 1`;
        if (others.length > 0)
          throw new ConflictException(HANDLE_MESSAGES.taken);
        const mine = await tx.userProfile.findUnique({
          where: { wawuUserId },
          select: { handle: true },
        });
        if (
          !mayChange &&
          mine?.handle &&
          mine.handle.toLowerCase() !== handle.toLowerCase()
        ) {
          // This route completes a profile; changing a username is Edit profile's.
          throw new ConflictException(HANDLE_MESSAGES.alreadySet);
        }
        // A profile row may not exist yet (the account type is copied right after sign-up): one is made, as
        // `PUT /users/me/account-type` does, and a later move to creator still works.
        await tx.userProfile.upsert({
          where: { wawuUserId },
          create: {
            wawuUserId,
            accountType: AccountType.user,
            handle,
            interests: [],
          },
          update: { handle },
        });
        return handle;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(HANDLE_MESSAGES.taken);
      }
      throw error;
    }
  }
}
