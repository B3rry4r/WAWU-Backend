import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { BlockedAccountService } from '../blocked-account/blocked-account.service';
import { NotificationService } from '../notification/notification.service';
import type { Paginated } from '../common/interceptors/response.interceptor';
import type {
  Community,
  CommunityJoinRequest,
  CommunityMembership,
  CommunityResponse,
} from '../common/types';
import { CommunityPassAccess } from './pass/community-pass-access.service';
import { CommunityPassRemoval } from './pass/community-pass-removal.service';
import { passIsActive } from './pass/community-pass-rules';
import type { CommunityPassRemovalQuoteView } from './pass/community-pass-view.type';
import type { CreateCommunityDto } from './dto/create-community.dto';
import type { UpdateCommunityDto } from './dto/update-community.dto';
import { assertContentAllowed } from '../moderation/content-filter';

/**
 * Community resource — registry.json "Community". Frozen contract:
 *   GET  /communities        roles: ["any"]
 *   GET  /communities/:id    roles: ["any"]
 *   POST /communities/:id/join   roles: ["any"]
 *
 * Plus the hosting endpoints, which the registry never carried and which
 * nothing in this backend could do until now:
 *   POST  /communities       creator-only — open a community you host
 *   PATCH /communities/:id   host-only    — edit name/description/image
 * Hosting USED to be a sold subscription feature (Basic bought open-community
 * hosting, Pro added private). Subscriptions are gone (build brief B1), so
 * hosting is now open to any creator account and both kinds are available to
 * all of them. See create() for the single gate that remains.
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
/**
 * Declining someone who is already a member. The wording is the live web
 * answer (DELETE /communities/:id/requests/:userWawuId is a protected route),
 * so it is kept as it is; INBOX-01 reuses it for a decline that loses a race
 * to an approval.
 */
/** Joining a room that sells a pass without one (INBOX-24, R-63). No em-dash: a person reads it. */
export const PASS_REQUIRED_MESSAGE =
  'This private room is joined with a monthly pass. Buy a pass to come in.';

/** What `GET /communities/:id/membership` adds in a room that sells a pass (INBOX-24). */
export interface MembershipPass {
  /** When the person's pass ends (ISO 8601), or null when they never had one. */
  passUntil: string | null;
  /** True when the person has held a pass here and can pay for the next one. */
  canRenew: boolean;
}

const ALREADY_APPROVED =
  'That request was already approved. This person is a member. Remove them instead.';

@Injectable()
export class CommunityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
    private readonly blockedAccounts: BlockedAccountService,
    private readonly passAccess: CommunityPassAccess,
    private readonly passRemoval: CommunityPassRemoval,
  ) {}

  /** Start of "today" in UTC, per the task brief's derivation rule for `messagesToday`. */
  private startOfTodayUtc(): Date {
    const now = new Date();
    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
  }

  /**
   * Public so the rooms routes (INBOX-01) answer with the same counts.
   *
   * `countHost` is for the app's room routes only (FIX-99, L5, owner ruling:
   * the host is a member). The web's routes (GET /communities, GET
   * /communities/:id, POST and PATCH /communities) are protected and keep
   * their count: joined memberships, which never include the host. With it
   * set the host is counted once, whether or not the host holds a row.
   */
  async withDerivedFields(
    community: Community,
    options: { countHost?: boolean } = {},
  ): Promise<CommunityResponse> {
    const startOfToday = this.startOfTodayUtc();
    const countHost = options.countHost === true;
    const [joined, messagesToday] = await this.prisma.$transaction([
      this.prisma.communityMembership.count({
        where: {
          communityId: community.id,
          status: 'joined',
          ...(countHost ? { userWawuId: { not: community.hostWawuId } } : {}),
        },
      }),
      this.prisma.communityMessage.count({
        where: { communityId: community.id, sentAt: { gte: startOfToday } },
      }),
    ]);
    const memberCount = countHost ? joined + 1 : joined;

    return { ...community, memberCount, messagesToday };
  }

  /**
   * GET /communities — no ordering contract given; name asc for a predictable
   * list. A name is not unique, so the id breaks a tie (FIX-28): without it,
   * equal names could repeat or go missing between offset pages.
   */
  async list(
    page: number,
    perPage: number,
    viewerWawuId?: string,
  ): Promise<Paginated<CommunityResponse>> {
    // SETTINGS-04: rooms hosted by somebody the caller blocked (or who
    // blocked the caller) are not listed, and not counted.
    const hidden = await this.blockedAccounts.hiddenFrom(viewerWawuId);
    const where = { hostWawuId: { notIn: hidden } };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.community.findMany({
        where,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.community.count({ where }),
    ]);

    const withDerived = await Promise.all(
      items.map((item) => this.withDerivedFields(item)),
    );

    return { items: withDerived, currentPage: page, perPage, total };
  }

  /** GET /communities/:id — 404s (via AllExceptionsFilter) when the id doesn't exist. */
  async findOne(id: string, viewerWawuId?: string): Promise<CommunityResponse> {
    const community = await this.prisma.community.findUnique({ where: { id } });
    if (!community) {
      throw new NotFoundException('Community not found');
    }
    // SETTINGS-04: a room hosted by a hidden account is a 404, except for
    // somebody already in it, who keeps the room they joined.
    await this.blockedAccounts.assertRoomVisible(
      viewerWawuId,
      community.hostWawuId,
      id,
    );
    return this.withDerivedFields(community);
  }

  /**
   * POST /communities — a creator opens a community they host.
   *
   * ONE gate now, where there used to be three:
   *
   *  1. Creator ACCOUNT TYPE — enforced one layer up by
   *     CommunityController's CreatorAccountGuard (UserProfile.accountType),
   *     same guard-proves-creator / service-proves-entitlement split as
   *     ContentPiece.create. This is the whole gate: a creator account may
   *     host, and may host either kind.
   *
   * The two that are gone were both subscription entitlements, removed with
   * subscriptions (build brief B1): hosting at all required
   * `CreatorState.subscriptionPaid`, and hosting a PRIVATE community required
   * Pro or Pro Max. Keeping either would now be a door with no key, because
   * there is no longer anything a creator could buy to get through it.
   *
   * KYC IS STILL DELIBERATELY NOT A GATE HERE, and that has not changed: KYC
   * gates EARNING, never hosting or uploading. A creator whose KYC is
   * `pending` can host, and the contract spec pins exactly that case, because
   * this independence has been got wrong in this codebase before. It was the
   * payment gate that was removed, not this one.
   *
   * NO CAP on communities hosted per creator, and this is unaffected by the
   * teardown. R-7 limits UPLOADS (5, or 25 with a tick); it says nothing about
   * communities, and a community is not an upload. Inventing "3 per creator"
   * here would be a product rule this backend made up and then enforced
   * against people. If product wants one it belongs beside FREE_UPLOADS and
   * TICK_UPLOADS in src/common/creator-allowance.ts,
   * not hardcoded in this service.
   *
   * The host does NOT get a CommunityMembership row. Host-implies-member is
   * already this codebase's convention: CommunityMessageService.assertMember
   * short-circuits on `userWawuId === hostWawuId`, and no seeded community
   * has a membership row for its own host. So `memberCount` (derived from
   * `joined` membership rows) counts members OTHER than the host, and a
   * brand-new community reports 0 on the web's routes, which are protected.
   * The app's room routes count the host as a member (`countHost`, FIX-99).
   */
  async create(
    hostWawuId: string,
    dto: CreateCommunityDto,
    passPriceKobo?: number,
    countHost = false,
  ): Promise<CommunityResponse> {
    // MOD-ROOMS (R-122). No listed word in a community's name or description (a room is made through this too).
    assertContentAllowed(dto.name, dto.description);
    // Hosting used to need a live subscription, and a PRIVATE community used
    // to need a paid tier above Basic. Both were subscription entitlements and
    // both are gone with it. CreatorAccountGuard on POST /communities still
    // proves the caller is a creator account, which is the gate that decides
    // who may host at all.

    const community = await this.prisma.community.create({
      data: {
        name: dto.name.trim(),
        description: dto.description.trim(),
        hostWawuId,
        kind: dto.kind,
        // Optional. A community with no image is normal — every one that
        // existed before the column has none — and clients keep their
        // placeholder tile for exactly that case.
        imageUrl: dto.imageUrl ?? null,
        // INBOX-24 (R-63). The monthly price of a private room's pass, written
        // with the room. Only POST /communities/rooms passes one.
        ...(passPriceKobo !== undefined
          ? { passPrice: { create: { priceKobo: BigInt(passPriceKobo) } } }
          : {}),
      },
    });

    return this.withDerivedFields(community, { countHost });
  }

  /**
   * PATCH /communities/:id — the host edits the community's name,
   * description and/or image. Only the host: a creator account is necessary
   * but nowhere near sufficient, or any creator could rewrite anyone's
   * community.
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
    // MOD-ROOMS (R-122). Only the words this edit carries are read.
    assertContentAllowed(dto.name, dto.description);
    if (
      dto.name === undefined &&
      dto.description === undefined &&
      dto.imageUrl === undefined
    ) {
      throw new BadRequestException(
        'Nothing to update. Send a name, a description and/or an image.',
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
        // `null` clears the image back to the placeholder; an omitted field
        // leaves whatever is there. See UpdateCommunityDto.imageUrl.
        ...(dto.imageUrl !== undefined ? { imageUrl: dto.imageUrl } : {}),
      },
    });

    return this.withDerivedFields(updated);
  }

  /**
   * POST /communities/:id/join. Idempotent (task brief, judgment call):
   * re-POSTing to a community the caller already has a membership row for
   * (any status — `joined` or `pending`) is a no-op that simply returns the
   * existing row unchanged — it never flips a `pending` row to `joined`.
   * That transition is the HOST's to make, and it now has an endpoint:
   * `POST /communities/:id/requests/:userWawuId/approve` (see
   * approveJoinRequest). Until it existed, `pending` was a dead end —
   * nothing anywhere in this codebase wrote `'joined'` except the open-
   * community branch below, so a private community could be requested but
   * never entered. Only a
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
  ): Promise<(CommunityMembership & Partial<MembershipPass>) | null> {
    const membership = await this.prisma.communityMembership.findUnique({
      where: { userWawuId_communityId: { userWawuId, communityId: id } },
    });
    if (!membership) return null;
    // INBOX-24 (R-63). In a private room that sells a pass the answer also
    // says when the pass ends and whether it can be renewed. Any other room
    // answers exactly what it always did, so the web's response is unchanged.
    if (!(await this.passAccess.roomsWithPass([id])).has(id)) return membership;
    const until = await this.passAccess.passUntil(id, userWawuId);
    return {
      ...membership,
      passUntil: until ? until.toISOString() : null,
      canRenew: until !== null,
    };
  }

  /** Leaves a community. Idempotent: leaving one you are not in is a no-op. */
  async leave(id: string, userWawuId: string): Promise<{ joined: false }> {
    // INBOX-24 round 3 (R-63). In a room that sells a pass a `pending` row is
    // a member the host removed, and only the host's approval lets them back.
    // Leaving must not delete it: with no row, joining again admits anyone
    // whose pass still runs. Only a `joined` row goes.
    const keepRemoved = await this.sellsPass(id);
    await this.prisma.communityMembership.deleteMany({
      where: {
        userWawuId,
        communityId: id,
        ...(keepRemoved ? { status: 'joined' as const } : {}),
      },
    });
    return { joined: false };
  }

  /** True when the room sells a monthly pass (INBOX-24, R-63). */
  private async sellsPass(id: string): Promise<boolean> {
    return (await this.passAccess.roomsWithPass([id])).has(id);
  }

  async join(id: string, userWawuId: string): Promise<CommunityMembership> {
    const community = await this.prisma.community.findUnique({
      where: { id },
      select: { id: true, kind: true, hostWawuId: true },
    });
    if (!community) {
      throw new NotFoundException('Community not found');
    }
    await this.blockedAccounts.assertRoomVisible(
      userWawuId,
      community.hostWawuId,
      id,
    );

    const existing = await this.prisma.communityMembership.findUnique({
      where: { userWawuId_communityId: { userWawuId, communityId: id } },
    });

    // INBOX-24 (R-63). A private room that sells a pass has no request and no
    // host approval: a person is in while their pass runs. Joining here is
    // only for someone whose pass is still running and who has no row (they
    // left); everyone else buys a pass. A row that exists is returned as it
    // is: `pending` is a member the host removed, and only the host lets them
    // back.
    if (await this.sellsPass(id)) {
      if (existing) return existing;
      const until = await this.passAccess.passUntil(id, userWawuId);
      if (!passIsActive(until, new Date())) {
        throw new ConflictException(PASS_REQUIRED_MESSAGE);
      }
      return this.prisma.communityMembership.upsert({
        where: { userWawuId_communityId: { userWawuId, communityId: id } },
        create: {
          userWawuId,
          communityId: id,
          status: 'joined',
          joinedAt: new Date(),
        },
        // A row that appeared in between is left exactly as it is.
        update: {},
      });
    }

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

  /**
   * ---------------------------------------------------------------------
   * The host's side of a private community.
   * ---------------------------------------------------------------------
   *
   * `POST /communities/:id/join` writes `status: 'pending'` for a private
   * community and nothing ever flipped it. `CommunityMessage.assertMember`
   * requires `status === 'joined'`, so a pending member could neither read
   * nor post: a private community was a room with a doorbell and no door.
   * Private hosting is open to every creator account, so that was a room
   * nobody could be admitted to for everybody who opened one. These four
   * methods are the other half of the hosting endpoints.
   *
   * HOST-ONLY, enforced HERE, not only in the guard. CreatorAccountGuard on
   * the controller proves "creator account"; it says nothing about WHICH
   * creator, and without this check any creator could admit people into
   * anyone's private community. Same guard-proves-role /
   * service-proves-ownership split as update() above, and the message shape
   * matches its precedent ("Only the community host can edit this
   * community.").
   */
  private async assertHost(
    id: string,
    actorWawuId: string,
    action: string,
  ): Promise<{ id: string; hostWawuId: string; name: string }> {
    const community = await this.prisma.community.findUnique({
      where: { id },
      select: { id: true, hostWawuId: true, name: true },
    });
    if (!community) {
      throw new NotFoundException('Community not found');
    }
    if (community.hostWawuId !== actorWawuId) {
      throw new ForbiddenException(
        `Only the community host can ${action} this community.`,
      );
    }
    return community;
  }

  /**
   * GET /communities/:id/requests — the review queue.
   *
   * Pending rows only. A `joined` row is not a request, and this list is
   * what the host acts on; mixing settled members into it is how a host
   * ends up "approving" someone who is already in.
   *
   * Ordered oldest-request-first on the `requestedAt` column this feature
   * added (see prisma/migrations/20260821010000_community_join_requests) —
   * a queue that cannot answer "who has been waiting longest" is not a
   * queue, and before that column a pending row carried no timestamp at all
   * (`joinedAt` is null precisely while pending), leaving only a random
   * uuid to sort on.
   *
   * Each row carries the requester's `UserProfile.handle` so the host is
   * deciding about a person rather than a UUID. It is genuinely nullable —
   * handles are optional and a requester may have no profile row — and is
   * returned as null rather than being back-filled with anything invented.
   *
   * Open communities are not an error here: they simply never have pending
   * rows, so the host of one gets an empty queue.
   */
  async listJoinRequests(
    id: string,
    hostWawuId: string,
    page: number,
    perPage: number,
  ): Promise<Paginated<CommunityJoinRequest>> {
    await this.assertHost(id, hostWawuId, 'review join requests for');

    // SETTINGS-04: a host does not see requests from people they blocked
    // or who blocked them.
    const hidden = await this.blockedAccounts.hiddenFrom(hostWawuId);
    const where = {
      communityId: id,
      status: 'pending' as const,
      userWawuId: { notIn: hidden },
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.communityMembership.findMany({
        where,
        orderBy: { requestedAt: 'asc' },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.communityMembership.count({ where }),
    ]);

    const profiles =
      items.length === 0
        ? []
        : await this.prisma.userProfile.findMany({
            where: { wawuUserId: { in: items.map((m) => m.userWawuId) } },
            select: { wawuUserId: true, handle: true, avatarUrl: true },
          });
    const handleFor = new Map(
      profiles.map((p) => [p.wawuUserId, p.handle] as const),
    );
    const avatarFor = new Map(
      profiles.map((p) => [p.wawuUserId, p.avatarUrl] as const),
    );

    return {
      items: items.map((m) => ({
        ...m,
        handle: handleFor.get(m.userWawuId) ?? null,
        avatarUrl: avatarFor.get(m.userWawuId) ?? null,
      })),
      currentPage: page,
      perPage,
      total,
    };
  }

  /**
   * POST /communities/:id/requests/:userWawuId/approve — pending -> joined.
   *
   * Sets `joinedAt` at the moment of approval, not at the moment of
   * request: `joinedAt` is what "member since" reads from, and a private
   * member was not a member while they were waiting.
   *
   * Approving an ALREADY-JOINED row is a deliberate no-op that returns the
   * row untouched rather than erroring or re-stamping `joinedAt`. Two host
   * devices, or one host double-tapping a stale queue, must not turn into a
   * 409 the host cannot act on — and re-stamping would quietly rewrite that
   * member's join date. Same idempotency stance as join()/leave() either
   * side of it.
   *
   * A user with no membership row at all is a 404: there is nothing to
   * approve, and inventing a membership from an approve call would let a
   * host add people who never asked.
   */
  async approveJoinRequest(
    id: string,
    hostWawuId: string,
    userWawuId: string,
  ): Promise<CommunityMembership> {
    const community = await this.assertHost(
      id,
      hostWawuId,
      'review join requests for',
    );

    const membership = await this.prisma.communityMembership.findUnique({
      where: { userWawuId_communityId: { userWawuId, communityId: id } },
    });
    if (!membership) {
      throw new NotFoundException(
        'No join request from this user for this community.',
      );
    }
    if (membership.status === 'joined') {
      return membership;
    }

    // INBOX-01: the change is conditional on the row still being pending, so
    // when approvals (or an approval and a decline) race, exactly one request
    // makes the change and only that one notifies.
    const { count } = await this.prisma.communityMembership.updateMany({
      where: { id: membership.id, status: 'pending' },
      data: { status: 'joined', joinedAt: new Date() },
    });
    const approved = await this.prisma.communityMembership.findUnique({
      where: { id: membership.id },
    });
    if (!approved) {
      // A decline removed the request first: there is nothing to approve,
      // the same answer as a request that never existed.
      throw new NotFoundException(
        'No join request from this user for this community.',
      );
    }
    if (count !== 1) {
      // Another approval got there first. Same answer as approving a member
      // who is already in, and no second notification.
      return approved;
    }
    // INBOX-01: tell the person who asked, once, on the real
    // pending -> joined change. emit() never throws.
    await this.notifications.emit({
      kind: 'community_join_approved',
      userWawuId,
      communityId: community.id,
      communityName: community.name,
    });
    return approved;
  }

  /**
   * DELETE /communities/:id/requests/:userWawuId — decline.
   *
   * DECLINE DELETES THE PENDING ROW. The alternative was a third
   * `MembershipStatus` value (`declined`, plus a migration), and this is
   * deliberately not that. Reasons, in order of weight:
   *
   *  1. Absence already means exactly one thing in this schema. `leave()`
   *     (DELETE /communities/:id/join) deletes the row, and
   *     `assertMember` treats a missing row and a non-`joined` row
   *     identically. A `declined` row would be a fourth thing a
   *     CommunityMembership row can be — one that is not a membership at
   *     all — and every existing query that reasons about "is this person
   *     in this community" would have to learn about it.
   *  2. A `declined` row is a BLOCK LIST, and this product has not
   *     specified one. Persisting the refusal only matters if it stops the
   *     user re-asking, i.e. it is a permanent ban with no expiry, no
   *     unblock endpoint and no UI — a product decision nobody made. WAWU
   *     already has a real, separate blocking feature (BlockedAccount) if
   *     that is ever wanted; smuggling a weaker version of it into an enum
   *     value is not the way to get it.
   *  3. Re-requesting after a decline is the established real-world
   *     behaviour for exactly this interaction (a declined follow request
   *     on a private account can be sent again), and the cost is bounded:
   *     the requester is told it was declined (INBOX-01) and the host
   *     declines again.
   *
   * The trade this accepts, stated plainly: a declined user can immediately
   * request again, and the host cannot see that they were declined before.
   *
   * A row that is already `joined` is REFUSED (409), not deleted. Declines
   * are issued from a queue that may be stale — the host may have approved
   * from another device in between — and silently converting "decline this
   * request" into "eject this member" is a destructive misread of the
   * host's intent. Removing a settled member is its own explicit endpoint
   * (removeMember).
   *
   * Idempotent when there is nothing to decline: no row -> success, no
   * error, mirroring leave(). Declining twice from a stale queue is not a
   * failure the host can do anything about.
   */
  async declineJoinRequest(
    id: string,
    hostWawuId: string,
    userWawuId: string,
  ): Promise<{ declined: true }> {
    const community = await this.assertHost(
      id,
      hostWawuId,
      'review join requests for',
    );

    const membership = await this.prisma.communityMembership.findUnique({
      where: { userWawuId_communityId: { userWawuId, communityId: id } },
      select: { id: true, status: true },
    });
    if (membership?.status === 'joined') {
      throw new ConflictException(ALREADY_APPROVED);
    }
    if (membership && (await this.sellsPass(id))) {
      // INBOX-24 round 2. In a room that sells a pass a pending row is a
      // member the host removed, and declining keeps them out: deleting the
      // row would let them join again while their pass runs.
      return { declined: true };
    }
    if (membership) {
      // INBOX-01: delete only while still pending, so a decline racing an
      // approval cannot remove someone the approval just let in, and of
      // several declines in flight exactly one removes the row and notifies.
      const { count } = await this.prisma.communityMembership.deleteMany({
        where: { id: membership.id, status: 'pending' },
      });
      if (count === 1) {
        // The requester hears the answer (I31, "We'll let you know when
        // she answers"), once.
        await this.notifications.emit({
          kind: 'community_join_declined',
          userWawuId,
          communityName: community.name,
        });
      } else {
        const now = await this.prisma.communityMembership.findUnique({
          where: { id: membership.id },
          select: { status: true },
        });
        if (now?.status === 'joined') {
          // An approval won the race: the same refusal as declining someone
          // who is already a member.
          throw new ConflictException(ALREADY_APPROVED);
        }
        // Another decline removed it first: nothing left to decline, the
        // same success as declining when there is no request.
      }
    }
    return { declined: true };
  }

  /**
   * DELETE /communities/:id/members/:userWawuId — the host removes a member.
   *
   * Implemented because approval without removal is a one-way door: a host
   * who admits the wrong person, or someone who turns the room toxic, had
   * no way back — and unlike declining, this is not a hypothetical, it is
   * the direct consequence of the approve endpoint above existing. It is
   * the same delete the member's own `leave()` already performs, so it
   * introduces no new state: removal returns them to "not a member", and
   * they may request again exactly as a declined user may.
   *
   * Deliberately NOT here: banning, muting, or removal reasons. Those are
   * moderation features with their own product surface; none is invented.
   *
   * The host cannot remove themselves — they hold access via
   * `Community.hostWawuId`, not a membership row (host-implies-member, see
   * create()), so the call could only ever be a confusing no-op. Refused
   * with an explanation instead.
   *
   * Idempotent (`deleteMany`): removing someone already gone succeeds.
   */
  async removeMember(
    id: string,
    hostWawuId: string,
    userWawuId: string,
  ): Promise<{ removed: true }> {
    await this.assertHost(id, hostWawuId, 'remove members from');

    if (userWawuId === hostWawuId) {
      throw new BadRequestException(
        'The host cannot be removed from their own community.',
      );
    }

    // INBOX-25 (R-71). The member the host removes gets the unused days of
    // their paid pass back. The move out of the room and the refund's decision
    // are ONE transaction, and the refund is decided only by the call that
    // really moved a joined member out: a double tap, a second server or a
    // retry finds the member already out and decides nothing. The payout is
    // the pass refund service's; it is told after the commit and the sweep
    // pays it if that misses. Leaving gives nothing: it never reaches here.
    const sells = await this.sellsPass(id);
    const refundId = await this.prisma.$transaction(
      async (tx) => {
        let movedOut: boolean;
        if (sells) {
          // INBOX-24 round 2 (R-63). In a room that sells a pass the person
          // may hold days they paid for, and a deleted row would let them
          // join again at once. They go back to a pending request instead:
          // out of the room until the host approves them.
          const { count } = await tx.communityMembership.updateMany({
            where: { communityId: id, userWawuId, status: 'joined' },
            data: { status: 'pending', joinedAt: null },
          });
          movedOut = count === 1;
        } else {
          const { count } = await tx.communityMembership.deleteMany({
            where: { communityId: id, userWawuId, status: 'joined' },
          });
          movedOut = count === 1;
          await tx.communityMembership.deleteMany({
            where: { communityId: id, userWawuId },
          });
        }
        if (!movedOut) return null;
        return this.passRemoval.decide(tx, {
          communityId: id,
          hostWawuId,
          userWawuId,
        });
      },
      { maxWait: 10_000, timeout: 30_000 },
    );
    if (refundId) this.passRemoval.announce(refundId);
    return { removed: true };
  }

  /**
   * GET /communities/:id/members/:userWawuId/removal-quote: what removing
   * this member would give them back (INBOX-25, R-71), for the host's remove
   * sheet. The Hub figures it, never the app. Host only. A person who is not
   * a joined member of the room gets back nothing: leaving, or being out
   * already, pays nothing, so the figure is 0.
   */
  async removalQuote(
    id: string,
    hostWawuId: string,
    userWawuId: string,
  ): Promise<CommunityPassRemovalQuoteView> {
    await this.assertHost(id, hostWawuId, 'remove members from');
    if (userWawuId === hostWawuId) {
      throw new BadRequestException(
        'The host cannot be removed from their own community.',
      );
    }
    const member = await this.prisma.communityMembership.findUnique({
      where: { userWawuId_communityId: { userWawuId, communityId: id } },
      select: { status: true },
    });
    if (member?.status !== 'joined') {
      return {
        communityId: id,
        userWawuId,
        refundKobo: 0,
        unusedDays: 0,
        asOf: new Date().toISOString(),
      };
    }
    return this.passRemoval.quote(id, userWawuId);
  }
}
