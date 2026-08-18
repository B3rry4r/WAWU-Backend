import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import type { Paginated } from '../common/interceptors/response.interceptor';
import type {
  Community,
  CommunityMembership,
  CommunityResponse,
} from '../common/types';

/**
 * Community resource — registry.json "Community". Frozen contract:
 *   GET  /communities        roles: ["any"]
 *   GET  /communities/:id    roles: ["any"]
 *   POST /communities/:id/join   roles: ["any"]
 *
 * `memberCount` / `messagesToday` are DERIVED (registry note) — never
 * stored columns. Computed via count() over CommunityMembership /
 * CommunityMessage at read time:
 *   - memberCount    = count(CommunityMembership where status = 'joined')
 *   - messagesToday  = count(CommunityMessage where sentAt >= start of today, UTC)
 *
 * CommunityMembership creation for POST /:id/join is built directly against
 * `prisma.communityMembership` here (task brief: CommunityMembership is a
 * separate wave resource with an empty `endpoints` array of its own — pure
 * data-model, no module/service of its own to depend on — `POST
 * /communities/:id/join` is explicitly this resource's endpoint per
 * registry.json).
 */
@Injectable()
export class CommunityService {
  constructor(private readonly prisma: PrismaService) {}

  /** Start of "today" in UTC, per the task brief's derivation rule for `messagesToday`. */
  private startOfTodayUtc(): Date {
    const now = new Date();
    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
  }

  private async withDerivedFields(
    community: Community,
  ): Promise<CommunityResponse> {
    const startOfToday = this.startOfTodayUtc();
    const [memberCount, messagesToday] = await this.prisma.$transaction([
      this.prisma.communityMembership.count({
        where: { communityId: community.id, status: 'joined' },
      }),
      this.prisma.communityMessage.count({
        where: { communityId: community.id, sentAt: { gte: startOfToday } },
      }),
    ]);

    return { ...community, memberCount, messagesToday };
  }

  /** GET /communities — no ordering contract given; name asc for a stable, predictable list. */
  async list(
    page: number,
    perPage: number,
  ): Promise<Paginated<CommunityResponse>> {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.community.findMany({
        orderBy: { name: 'asc' },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.community.count(),
    ]);

    const withDerived = await Promise.all(
      items.map((item) => this.withDerivedFields(item)),
    );

    return { items: withDerived, currentPage: page, perPage, total };
  }

  /** GET /communities/:id — 404s (via AllExceptionsFilter) when the id doesn't exist. */
  async findOne(id: string): Promise<CommunityResponse> {
    const community = await this.prisma.community.findUnique({ where: { id } });
    if (!community) {
      throw new NotFoundException('Community not found');
    }
    return this.withDerivedFields(community);
  }

  /**
   * POST /communities/:id/join. Idempotent (task brief, judgment call):
   * re-POSTing to a community the caller already has a membership row for
   * (any status — `joined` or `pending`) is a no-op that simply returns the
   * existing row unchanged — it never flips a `pending` row to `joined`
   * (that transition belongs to whatever approves a private community's
   * membership request, out of scope here) and never errors. Only a
   * genuinely *new* membership decides its initial status from the
   * community's `kind`:
   *   - open    -> status: joined,  joinedAt: now
   *   - private -> status: pending, joinedAt: null
   */
  /**
   * The caller's own membership, or null. There was no way to ask whether
   * you had joined, so the client guessed from local state and showed
   * "Joined" on one device and "Join" on another.
   */
  async myMembership(id: string, userWawuId: string): Promise<CommunityMembership | null> {
    return this.prisma.communityMembership.findUnique({
      where: { userWawuId_communityId: { userWawuId, communityId: id } },
    });
  }

  /** Leaves a community. Idempotent: leaving one you are not in is a no-op. */
  async leave(id: string, userWawuId: string): Promise<{ joined: false }> {
    await this.prisma.communityMembership.deleteMany({
      where: { userWawuId, communityId: id },
    });
    return { joined: false };
  }

  async join(id: string, userWawuId: string): Promise<CommunityMembership> {
    const community = await this.prisma.community.findUnique({
      where: { id },
      select: { id: true, kind: true },
    });
    if (!community) {
      throw new NotFoundException('Community not found');
    }

    const existing = await this.prisma.communityMembership.findUnique({
      where: { userWawuId_communityId: { userWawuId, communityId: id } },
    });
    if (existing) {
      return existing;
    }

    return this.prisma.communityMembership.create({
      data:
        community.kind === 'open'
          ? {
              userWawuId,
              communityId: id,
              status: 'joined',
              joinedAt: new Date(),
            }
          : { userWawuId, communityId: id, status: 'pending', joinedAt: null },
    });
  }
}
