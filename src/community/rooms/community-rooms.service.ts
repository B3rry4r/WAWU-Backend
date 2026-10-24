import { BlockedAccountService } from '../../blocked-account/blocked-account.service';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationService } from '../../notification/notification.service';
import type { Paginated } from '../../common/interceptors/response.interceptor';
import { CommunityMessageService } from '../../community-message/community-message.service';
import { CommunityService } from '../community.service';
import type { CreateRoomDto } from '../dto/create-room.dto';
import {
  CommunityPassAccess,
  PASS_ENDED_MESSAGE,
} from '../pass/community-pass-access.service';
import {
  passPriceBounds,
  passPriceProblem,
} from '../pass/community-pass-rules';
import { Prisma } from '../../../generated/prisma/client';
import { normaliseSlug, shareLink, slugBase } from './community-slug';
import {
  CommunityViewerRole,
  type CommunityLastMessage,
  type CommunityLinkView,
  type CommunityMessageCost,
  type CommunityReadView,
  type CommunityRoom,
  type CommunityRoomView,
  type MyCommunity,
  type SuggestedCommunity,
} from './community-room.type';

/** Prisma's unique-constraint refusal (P2002). */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'P2002'
  );
}

/** How many times a slug is retried when two rooms race for the same one. */
const LINK_ATTEMPTS = 5;

/**
 * INBOX-01: the app's side of communities. Every route here is new; nothing
 * the web calls changes (POST /communities, GET /communities/:id and the rest
 * answer exactly as before).
 *
 *   GET  /communities/mine          the caller's rooms, newest activity first,
 *                                   with the last message and an unread count
 *   POST /communities/:id/read      the caller has read up to now
 *   GET  /communities/:id/link      the room's share link (made on first ask)
 *   GET  /communities/links/:slug   open a wawu/c/<slug> link
 *   POST /communities/rooms         create a room the way the app does: a
 *                                   private room needs a cover, and the
 *                                   answer carries the share link
 *
 * INBOX-05 adds three reads for the app's Communities list and room:
 *
 *   GET  /communities/:id/room      a room as the caller sees it: role and
 *                                   what one message costs them there
 *   GET  /communities/message-cost  what one message costs a member
 *   GET  /communities/suggested     rooms the caller could join
 */
@Injectable()
export class CommunityRoomsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly communities: CommunityService,
    private readonly messages: CommunityMessageService,
    private readonly blockedAccounts: BlockedAccountService,
    private readonly passAccess: CommunityPassAccess,
    private readonly notifications: NotificationService,
  ) {}

  /**
   * POST /communities/rooms. The same create as POST /communities (one
   * service method, one set of gates), plus the rule the app's form states:
   * a private room needs a cover image (I32, "You approve every member.
   * Needs a cover image."). POST /communities keeps accepting a private
   * room without one, because the web calls it and its behaviour is frozen.
   */
  async createRoom(
    hostWawuId: string,
    dto: CreateRoomDto,
  ): Promise<CommunityRoom> {
    if (dto.kind === 'private' && !dto.imageUrl) {
      throw new BadRequestException('A private room needs a cover image.');
    }
    // INBOX-24 (R-63). A private room sells a monthly pass: the host types
    // the price here and it is stored with the room, in one write. R-63 has
    // no host approval step, so a private room made here always has a price
    // (SWEEP-INBOX, INBOX-24 L3). POST /communities, which the web calls,
    // still makes one without a price and keeps the older join request flow.
    if (dto.kind === 'private' && dto.passPriceKobo === undefined) {
      throw new BadRequestException('A private room needs a monthly price.');
    }
    if (dto.passPriceKobo !== undefined) {
      if (dto.kind !== 'private') {
        throw new BadRequestException(
          'Only a private room has a monthly price.',
        );
      }
      const problem = passPriceProblem(dto.passPriceKobo, passPriceBounds());
      if (problem) throw new BadRequestException(problem);
    }
    const community = await this.communities.create(
      hostWawuId,
      dto,
      dto.passPriceKobo,
      true,
    );
    const slug = await this.ensureLink(community.id, community.name);
    return { ...community, slug, link: shareLink(slug) };
  }

  /** GET /communities/:id/link. Any signed-in user may share any room. */
  async linkFor(
    communityId: string,
    viewerWawuId?: string,
  ): Promise<CommunityLinkView> {
    const community = await this.prisma.community.findUnique({
      where: { id: communityId },
      select: { id: true, name: true, hostWawuId: true },
    });
    if (!community) {
      throw new NotFoundException('Community not found');
    }
    await this.blockedAccounts.assertRoomVisible(
      viewerWawuId,
      community.hostWawuId,
      community.id,
    );
    const slug = await this.ensureLink(community.id, community.name);
    return { communityId: community.id, slug, link: shareLink(slug) };
  }

  /**
   * GET /communities/links/:slug. Opens the room a link names, members or
   * not: what the caller may then do (read, ask to join) is decided by the
   * room routes exactly as it is for a room found any other way.
   */
  async resolve(
    rawSlug: string,
    viewerWawuId?: string,
  ): Promise<CommunityRoom> {
    const slug = normaliseSlug(rawSlug);
    const link = slug
      ? await this.prisma.communityLink.findUnique({
          where: { slug },
          include: { community: true },
        })
      : null;
    if (!link) {
      throw new NotFoundException('No community has this link.');
    }
    await this.blockedAccounts.assertRoomVisible(
      viewerWawuId,
      link.community.hostWawuId,
      link.community.id,
      'No community has this link.',
    );
    const community = await this.communities.withDerivedFields(link.community, {
      countHost: true,
    });
    return { ...community, slug: link.slug, link: shareLink(link.slug) };
  }

  /**
   * POST /communities/:id/read. Only someone who can read the room can mark
   * it read: the host, or a member whose request was approved. The same
   * refusal as GET /communities/:id/messages gives.
   */
  async markRead(
    communityId: string,
    userWawuId: string,
  ): Promise<CommunityReadView> {
    const community = await this.prisma.community.findUnique({
      where: { id: communityId },
      select: { id: true, hostWawuId: true },
    });
    if (!community) {
      throw new NotFoundException('Community not found');
    }
    await this.blockedAccounts.assertRoomVisible(
      userWawuId,
      community.hostWawuId,
      community.id,
    );
    if (community.hostWawuId !== userWawuId) {
      const membership = await this.prisma.communityMembership.findUnique({
        where: { userWawuId_communityId: { userWawuId, communityId } },
        select: { status: true },
      });
      if (membership?.status !== 'joined') {
        throw new ForbiddenException(
          'Join this community to read or post in it.',
        );
      }
      // INBOX-24 (R-63): a member whose pass has ended reads nothing.
      if (!(await this.passAccess.mayEnter(communityId, userWawuId))) {
        throw new ForbiddenException(PASS_ENDED_MESSAGE);
      }
    }

    const lastReadAt = new Date();
    await this.prisma.communityReadMarker.upsert({
      where: { userWawuId_communityId: { userWawuId, communityId } },
      create: { userWawuId, communityId, lastReadAt },
      update: { lastReadAt },
    });
    // FIX-105 (R-81): opening the room closes the person's grouped "new
    // messages" notice; the next message after this starts a new one.
    await this.notifications.closeCommunityMessages(userWawuId, communityId);
    return { communityId, lastReadAt };
  }

  /**
   * GET /communities/mine. Rooms the caller hosts and rooms they were let
   * into. A request still waiting for the host is not listed: the person
   * cannot read that room yet (GET /communities/:id/membership answers
   * "am I waiting?").
   *
   * Ordered by the newest message, or by when the caller joined for a room
   * with none, then by name. The order needs every room's last message, so
   * the whole set is ranked before the page is cut; a person's own rooms are
   * a short list, and two small queries per room is the cost.
   */
  async mine(
    userWawuId: string,
    page: number,
    perPage: number,
  ): Promise<Paginated<MyCommunity>> {
    const [memberships, hosted] = await Promise.all([
      this.prisma.communityMembership.findMany({
        where: { userWawuId, status: 'joined' },
        select: { communityId: true, joinedAt: true },
      }),
      this.prisma.community.findMany({
        where: { hostWawuId: userWawuId },
        select: { id: true },
      }),
    ]);

    const roles = new Map<
      string,
      { role: 'host' | 'member'; joinedAt: Date | null }
    >();
    for (const m of memberships) {
      roles.set(m.communityId, { role: 'member', joinedAt: m.joinedAt });
    }
    for (const h of hosted) {
      roles.set(h.id, { role: 'host', joinedAt: null });
    }
    const ids = [...roles.keys()];
    if (ids.length === 0) {
      return { items: [], currentPage: page, perPage, total: 0 };
    }

    const [communities, markers] = await Promise.all([
      this.prisma.community.findMany({ where: { id: { in: ids } } }),
      this.prisma.communityReadMarker.findMany({
        where: { userWawuId, communityId: { in: ids } },
        select: { communityId: true, lastReadAt: true },
      }),
    ]);
    const readUpTo = new Map(markers.map((m) => [m.communityId, m.lastReadAt]));

    // SETTINGS-04: a room's preview line and unread count leave out what
    // people the caller blocked (or who blocked the caller) wrote.
    const hidden = await this.blockedAccounts.hiddenFrom(userWawuId);
    // INBOX-24 (R-63). A room whose pass has ended is still listed, so the
    // person can renew it, but shows no message and no unread count: reading
    // is part of what the pass pays for.
    const lapsed = await this.passAccess.lapsedRooms(
      userWawuId,
      communities.filter((c) => c.hostWawuId !== userWawuId).map((c) => c.id),
    );
    const ranked = await Promise.all(
      communities.map(async (community) => {
        const { role, joinedAt } = roles.get(community.id)!;
        if (lapsed.has(community.id)) {
          return {
            community,
            role,
            joinedAt,
            last: null,
            unreadCount: 0,
            lastActivityAt: joinedAt,
          };
        }
        const since = readUpTo.get(community.id) ?? joinedAt ?? null;
        const [last, unreadCount] = await this.prisma.$transaction([
          this.prisma.communityMessage.findFirst({
            where: {
              communityId: community.id,
              senderWawuId: { notIn: hidden },
            },
            orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
          }),
          this.prisma.communityMessage.count({
            where: {
              communityId: community.id,
              senderWawuId: { notIn: [userWawuId, ...hidden] },
              ...(since ? { sentAt: { gt: since } } : {}),
            },
          }),
        ]);
        return {
          community,
          role,
          joinedAt,
          last,
          unreadCount,
          lastActivityAt: last?.sentAt ?? joinedAt ?? null,
        };
      }),
    );

    ranked.sort((a, b) => {
      const at = a.lastActivityAt?.getTime() ?? -Infinity;
      const bt = b.lastActivityAt?.getTime() ?? -Infinity;
      if (at !== bt) return bt - at;
      const byName = a.community.name.localeCompare(b.community.name);
      return byName !== 0
        ? byName
        : a.community.id.localeCompare(b.community.id);
    });

    const pageRows = ranked.slice((page - 1) * perPage, page * perPage);
    const senders = await this.messages.lookupSenders(
      pageRows.flatMap((r) => (r.last ? [r.last.senderWawuId] : [])),
    );

    const items = await Promise.all(
      pageRows.map(async (row): Promise<MyCommunity> => {
        const [withCounts, slug] = await Promise.all([
          this.communities.withDerivedFields(row.community, {
            countHost: true,
          }),
          this.ensureLink(row.community.id, row.community.name),
        ]);
        // The links are signed fresh, as the room's list signs them (FIX-71).
        const last = row.last
          ? await this.messages.withFreshMedia(row.last)
          : null;
        const lastMessage: CommunityLastMessage | null = last
          ? {
              id: last.id,
              text: last.text,
              imageUrl: last.imageUrl,
              videoUrl: last.videoUrl,
              voiceUrl: last.voiceUrl,
              sentAt: last.sentAt,
              senderWawuId: last.senderWawuId,
              sender: senders.get(last.senderWawuId) ?? null,
            }
          : null;
        return {
          ...withCounts,
          slug,
          link: shareLink(slug),
          role: row.role,
          joinedAt: row.joinedAt,
          lastMessage,
          unreadCount: row.unreadCount,
          lastActivityAt: row.lastActivityAt,
        };
      }),
    );

    return { items, currentPage: page, perPage, total: ranked.length };
  }

  /**
   * INBOX-05, GET /communities/:id/room. The room I25 draws: its counts and
   * link, where the caller stands in it, and what one message costs them
   * there. Anyone signed in may look (open rooms are joined from here), except
   * that a room hosted by somebody hidden from the caller is a 404, as
   * GET /communities/:id is, unless the caller is already in it.
   */
  async room(
    communityId: string,
    viewerWawuId: string,
  ): Promise<CommunityRoomView> {
    const community = await this.prisma.community.findUnique({
      where: { id: communityId },
    });
    if (!community) {
      throw new NotFoundException('Community not found');
    }
    await this.blockedAccounts.assertRoomVisible(
      viewerWawuId,
      community.hostWawuId,
      community.id,
    );

    const [withCounts, slug, membership, messageCostInCredits] =
      await Promise.all([
        this.communities.withDerivedFields(community, { countHost: true }),
        this.ensureLink(community.id, community.name),
        community.hostWawuId === viewerWawuId
          ? Promise.resolve(null)
          : this.prisma.communityMembership.findUnique({
              where: {
                userWawuId_communityId: {
                  userWawuId: viewerWawuId,
                  communityId,
                },
              },
              select: { status: true },
            }),
        this.messages.messageCostFor(community, viewerWawuId),
      ]);

    // INBOX-24 (R-63). In a room that sells a pass, a member whose pass has
    // ended is not inside: they are shown the room as someone who has to pay.
    const lapsed =
      community.hostWawuId !== viewerWawuId &&
      membership?.status === 'joined' &&
      !(await this.passAccess.mayEnter(communityId, viewerWawuId));
    const role: CommunityViewerRole =
      community.hostWawuId === viewerWawuId
        ? CommunityViewerRole.Host
        : membership?.status === 'joined' && !lapsed
          ? CommunityViewerRole.Member
          : membership?.status === 'pending'
            ? CommunityViewerRole.Pending
            : CommunityViewerRole.None;

    return {
      ...withCounts,
      slug,
      link: shareLink(slug),
      role,
      messageCostInCredits,
    };
  }

  /** INBOX-05, GET /communities/message-cost. The price line on I24's card. */
  messageCost(): CommunityMessageCost {
    return {
      creditsPerMessage: this.messages.meteredMessageCost(),
      creditsByKind: this.messages.costsByKind(),
    };
  }

  /**
   * INBOX-05, GET /communities/suggested. Rooms the caller could join: not
   * one they host, not one they are in or have asked to join, and not one
   * hosted by somebody hidden from them (SETTINGS-04). Most members first,
   * then by name, then by id, so the order is total and a page never repeats
   * or skips a room while nothing changes.
   *
   * Default (agent), owner may override: "suggested" is ranked by member
   * count alone. There is no interest or follow signal for rooms yet.
   */
  async suggested(
    viewerWawuId: string,
    page: number,
    perPage: number,
  ): Promise<Paginated<SuggestedCommunity>> {
    const hidden = await this.blockedAccounts.hiddenFrom(viewerWawuId);
    const excludedHosts = [viewerWawuId, ...hidden];
    const offset = (page - 1) * perPage;

    const [rows, total] = await Promise.all([
      this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT c."id"
          FROM "Community" c
         WHERE c."hostWawuId" <> ALL(${excludedHosts}::text[])
           AND NOT EXISTS (
                 SELECT 1 FROM "CommunityMembership" m
                  WHERE m."communityId" = c."id"
                    AND m."userWawuId" = ${viewerWawuId})
         ORDER BY (SELECT COUNT(*) FROM "CommunityMembership" j
                    WHERE j."communityId" = c."id"
                      AND j."status" = 'joined') DESC,
                  c."name" ASC,
                  c."id" ASC
         OFFSET ${offset}
         LIMIT ${perPage}`),
      this.prisma.community.count({
        where: {
          hostWawuId: { notIn: excludedHosts },
          memberships: { none: { userWawuId: viewerWawuId } },
        },
      }),
    ]);

    const ids = rows.map((r) => r.id);
    const found = await this.prisma.community.findMany({
      where: { id: { in: ids } },
    });
    const byId = new Map(found.map((c) => [c.id, c]));
    const items = await Promise.all(
      ids.flatMap((id) => {
        const community = byId.get(id);
        return community
          ? [this.communities.withDerivedFields(community, { countHost: true })]
          : [];
      }),
    );
    return { items, currentPage: page, perPage, total };
  }

  /**
   * The room's slug, made the first time anyone needs it and fixed from then
   * on. Rooms that existed before links did get theirs this way, so there is
   * no backfill. Two requests for the same room, or two rooms wanting the
   * same slug, can race: the unique keys decide, and the loser re-reads.
   */
  async ensureLink(communityId: string, name: string): Promise<string> {
    const existing = await this.prisma.communityLink.findUnique({
      where: { communityId },
      select: { slug: true },
    });
    if (existing) return existing.slug;

    const base = slugBase(name);
    for (let attempt = 0; attempt < LINK_ATTEMPTS; attempt += 1) {
      const taken = new Set(
        (
          await this.prisma.communityLink.findMany({
            where: { slug: { startsWith: base } },
            select: { slug: true },
          })
        ).map((l) => l.slug),
      );
      let candidate = base;
      for (let n = 2; taken.has(candidate); n += 1) {
        candidate = `${base}-${n}`;
      }
      try {
        await this.prisma.communityLink.create({
          data: { communityId, slug: candidate },
        });
        return candidate;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        const raced = await this.prisma.communityLink.findUnique({
          where: { communityId },
          select: { slug: true },
        });
        if (raced) return raced.slug;
      }
    }
    throw new ConflictException(
      'We could not make a link for this community. Please try again.',
    );
  }
}
