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
import type { CompleteIdentityDto } from './dto/complete-identity.dto';
import type { HandleAvailabilityView } from './dto/handle-availability.dto';
import { checkHandleShape, HANDLE_MESSAGES } from './handle-rules';

export interface IdentityView {
  firstName: string | null;
  lastName: string | null;
  handle: string | null;
}

export const NAMES_TOGETHER = 'Enter your first name and your last name.';
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
 * while the lock is held.
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
    const holder = await this.prisma.userProfile.findFirst({
      where: { handle: { equals: shape.handle, mode: 'insensitive' } },
      select: { wawuUserId: true },
    });
    return holder
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
      ? await this.claim(claims.sub, wanted)
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

  private async heldBy(wawuUserId: string): Promise<string | null> {
    const row = await this.prisma.userProfile.findUnique({
      where: { wawuUserId },
      select: { handle: true },
    });
    return row?.handle ?? null;
  }

  private async claim(wawuUserId: string, handle: string): Promise<string> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`handle:${handle.toLowerCase()}`}, 0))`;
        const other = await tx.userProfile.findFirst({
          where: {
            handle: { equals: handle, mode: 'insensitive' },
            NOT: { wawuUserId },
          },
          select: { wawuUserId: true },
        });
        if (other) throw new ConflictException(HANDLE_MESSAGES.taken);
        const mine = await tx.userProfile.findUnique({
          where: { wawuUserId },
          select: { handle: true },
        });
        if (
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
