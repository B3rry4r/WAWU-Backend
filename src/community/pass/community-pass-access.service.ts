import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * Who may be inside a private community that sells a pass (task INBOX-24,
 * R-63).
 *
 * A room sells a pass when it has a row of `CommunityPassPrice`. In such a
 * room a member (a `joined` membership) may read and post only while they hold
 * a pass that has not ended; the host always may. A room with no price row is
 * not touched: open rooms, and private rooms with the older join request flow,
 * behave exactly as they did.
 *
 * This file only reads, and reaches nothing but the database, so the modules
 * that gate a room (messages, rooms, live, inbox) can import it without the
 * wallet provider's settings.
 */
@Injectable()
export class CommunityPassAccess {
  constructor(private readonly prisma: PrismaService) {}

  /** The rooms among `communityIds` that sell a pass. */
  async roomsWithPass(communityIds: string[]): Promise<Set<string>> {
    if (communityIds.length === 0) return new Set();
    const rows = await this.prisma.communityPassPrice.findMany({
      where: { communityId: { in: communityIds } },
      select: { communityId: true },
    });
    return new Set(rows.map((r) => r.communityId));
  }

  /** The end of the person's pass in one room (the latest of their passes), or null when they never had one. */
  async passUntil(
    communityId: string,
    userWawuId: string,
  ): Promise<Date | null> {
    const latest = await this.prisma.communityPass.aggregate({
      where: { communityId, userWawuId },
      _max: { endsAt: true },
    });
    return latest._max.endsAt;
  }

  /**
   * The rooms among `communityIds` that sell a pass and where the person has
   * none that is still running. They keep their membership, and lose the room
   * until they renew.
   */
  async lapsedRooms(
    userWawuId: string,
    communityIds: string[],
    now: Date = new Date(),
  ): Promise<Set<string>> {
    const priced = await this.roomsWithPass(communityIds);
    if (priced.size === 0) return priced;
    const running = await this.prisma.communityPass.findMany({
      where: {
        userWawuId,
        communityId: { in: [...priced] },
        endsAt: { gt: now },
      },
      select: { communityId: true },
      distinct: ['communityId'],
    });
    for (const r of running) priced.delete(r.communityId);
    return priced;
  }

  /** Of `userWawuIds`, the ones with no running pass in a room that sells one. Nobody for a room that does not. */
  async lapsedMembers(
    communityId: string,
    userWawuIds: string[],
    now: Date = new Date(),
  ): Promise<Set<string>> {
    if (userWawuIds.length === 0) return new Set();
    const priced = await this.roomsWithPass([communityId]);
    if (priced.size === 0) return new Set();
    const running = await this.prisma.communityPass.findMany({
      where: {
        communityId,
        userWawuId: { in: userWawuIds },
        endsAt: { gt: now },
      },
      select: { userWawuId: true },
      distinct: ['userWawuId'],
    });
    const lapsed = new Set(userWawuIds);
    for (const r of running) lapsed.delete(r.userWawuId);
    return lapsed;
  }

  /** True unless the room sells a pass and the person has none running. The host is not asked. */
  async mayEnter(
    communityId: string,
    userWawuId: string,
    now: Date = new Date(),
  ): Promise<boolean> {
    return !(await this.lapsedRooms(userWawuId, [communityId], now)).has(
      communityId,
    );
  }
}

/** What a member who lost the room is told (403). No em-dash: a person reads it. */
export const PASS_ENDED_MESSAGE =
  'Your pass for this room has ended. Renew it to read or post here.';
