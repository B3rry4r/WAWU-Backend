import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import type { Paginated } from '../common/interceptors/response.interceptor';
import type {
  Community,
  CommunityMembership,
  CommunityResponse,
} from '../common/types';
import type { CreateCommunityDto } from './dto/create-community.dto';
import type { UpdateCommunityDto } from './dto/update-community.dto';

/**
 * Community resource — registry.json "Community". Frozen contract:
 *   GET  /communities        roles: ["any"]
 *   GET  /communities/:id    roles: ["any"]
 *   POST /communities/:id/join   roles: ["any"]
 *
 * Plus the hosting endpoints, which the registry never carried and which
 * nothing in this backend could do until now:
 *   POST  /communities       creator-only — open a community you host
 *   PATCH /communities/:id   host-only    — edit name/description
 * Hosting is a SOLD subscription feature (docs/01_SPEC.md — Basic: "cannot
 * open/host private communities"; Pro: "Can open/host private communities",
 * i.e. Basic is sold OPEN-community hosting and Pro adds private), but no
 * endpoint wrote a Community row at all: every Community in the database
 * came from prisma/seed.ts. See create() for the gates.
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
   * POST /communities — a creator opens a community they host.
   *
   * THREE gates, in this order, and no others:
   *
   *  1. Creator ACCOUNT TYPE — enforced one layer up by
   *     CommunityController's CreatorAccountGuard (UserProfile.accountType),
   *     same guard-proves-creator / service-proves-entitlement split as
   *     ContentPiece.create.
   *
   *  2. CreatorState.subscriptionPaid === true. Hosting is a paid-plan
   *     feature on both tiers, so an unpaid (or lapsed — the hourly
   *     scheduler clears this flag) creator cannot open one. Message mirrors
   *     ContentPieceService.create's upload gate verbatim in shape.
   *
   *  3. kind === 'private' requires tier === 'pro'. A Basic creator asking
   *     for a private community is refused with the tier named, never
   *     silently downgraded to an open one — quietly handing someone an
   *     open community when they asked for a private one publishes what they
   *     meant to keep behind a door.
   *
   * KYC IS DELIBERATELY NOT A GATE HERE. CLAUDE.md: the two creator gates are
   * independent — subscriptionPaid gates uploading/hosting, kycStatus gates
   * EARNING — and "paid + uploading + KYC pending" is a normal state, not an
   * edge case. A paid creator whose KYC is still `pending` can host, and the
   * contract spec pins exactly that case, because this independence has been
   * got wrong in this codebase before.
   *
   * NO CAP on communities hosted per creator. The spec (WAWU-Web
   * docs/01_SPEC.md, the monetization tiebreaker doc) states none —
   * it bounds upload slots by tier (src/common/creator-tier-allowance.ts) and
   * says nothing about a community count — so inventing "3 per creator" here
   * would be a product rule this backend made up and then charged people
   * against. If product wants one, it belongs next to uploadAllowanceFor()
   * as a tier allowance, not hardcoded in this service.
   *
   * The host does NOT get a CommunityMembership row. Host-implies-member is
   * already this codebase's convention: CommunityMessageService.assertMember
   * short-circuits on `userWawuId === hostWawuId`, and no seeded community
   * has a membership row for its own host. So `memberCount` (derived from
   * `joined` membership rows) counts members OTHER than the host, and a
   * brand-new community reports 0 — consistent with every existing row
   * rather than a second, contradictory convention.
   */
  async create(
    hostWawuId: string,
    dto: CreateCommunityDto,
  ): Promise<CommunityResponse> {
    const creatorState = await this.prisma.creatorState.findUnique({
      where: { wawuUserId: hostWawuId },
      select: { subscriptionPaid: true, tier: true },
    });

    if (!creatorState || !creatorState.subscriptionPaid) {
      throw new ForbiddenException(
        'A paid subscription is required to host a community (CreatorState.subscriptionPaid=false).',
      );
    }

    if (dto.kind === 'private' && creatorState.tier !== 'pro') {
      throw new ForbiddenException(
        'Private communities are a Pro-tier feature. Your Basic plan can host open communities — upgrade to Pro to host a private one.',
      );
    }

    const community = await this.prisma.community.create({
      data: {
        name: dto.name.trim(),
        description: dto.description.trim(),
        hostWawuId,
        kind: dto.kind,
      },
    });

    return this.withDerivedFields(community);
  }

  /**
   * PATCH /communities/:id — the host edits the community's name and/or
   * description. Only the host: a creator account is necessary but nowhere
   * near sufficient, or any creator could rewrite anyone's community.
   *
   * `kind` is not editable (see UpdateCommunityDto), and there is
   * deliberately no DELETE. Community rows cascade onto CommunityMembership,
   * CommunityMessage AND CreditSpend (prisma/schema.prisma — all three
   * `onDelete: Cascade`), so a hard delete would silently destroy the
   * credit-spend ledger that CreatorEarnings computes a host's community
   * earnings from. Archiving is the coherent alternative and needs a schema
   * column plus a migration, plus a decision about what an archived
   * community does to its members' access — a product call, not a
   * refactor. Neither is invented here.
   */
  async update(
    id: string,
    editorWawuId: string,
    dto: UpdateCommunityDto,
  ): Promise<CommunityResponse> {
    if (dto.name === undefined && dto.description === undefined) {
      throw new BadRequestException(
        'Nothing to update — send a name and/or a description.',
      );
    }

    const existing = await this.prisma.community.findUnique({
      where: { id },
      select: { id: true, hostWawuId: true },
    });
    if (!existing) {
      throw new NotFoundException('Community not found');
    }
    if (existing.hostWawuId !== editorWawuId) {
      throw new ForbiddenException(
        'Only the community host can edit this community.',
      );
    }

    const updated = await this.prisma.community.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description.trim() }
          : {}),
      },
    });

    return this.withDerivedFields(updated);
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
  async myMembership(
    id: string,
    userWawuId: string,
  ): Promise<CommunityMembership | null> {
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
