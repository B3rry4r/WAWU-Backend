import { BlockedAccountService } from '../../blocked-account/blocked-account.service';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Paginated } from '../../common/interceptors/response.interceptor';
import { CommunityMessageService } from '../../community-message/community-message.service';
import { CommunityService } from '../community.service';
import type { CreateCommunityDto } from '../dto/create-community.dto';
import { normaliseSlug, shareLink, slugBase } from './community-slug';
import type {
  CommunityLastMessage,
  CommunityLinkView,
  CommunityReadView,
  CommunityRoom,
  MyCommunity,
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
 */
@Injectable()
export class CommunityRoomsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly communities: CommunityService,
    private readonly messages: CommunityMessageService,
    private readonly blockedAccounts: BlockedAccountService,
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
    dto: CreateCommunityDto,
  ): Promise<CommunityRoom> {
    if (dto.kind === 'private' && !dto.imageUrl) {
      throw new BadRequestException('A private room needs a cover image.');
    }
    const community = await this.communities.create(hostWawuId, dto);
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
    const community = await this.communities.withDerivedFields(link.community);
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
    }

    const lastReadAt = new Date();
    await this.prisma.communityReadMarker.upsert({
      where: { userWawuId_communityId: { userWawuId, communityId } },
      create: { userWawuId, communityId, lastReadAt },
      update: { lastReadAt },
    });
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
    const ranked = await Promise.all(
      communities.map(async (community) => {
        const { role, joinedAt } = roles.get(community.id)!;
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
          this.communities.withDerivedFields(row.community),
          this.ensureLink(row.community.id, row.community.name),
        ]);
        const lastMessage: CommunityLastMessage | null = row.last
          ? {
              id: row.last.id,
              text: row.last.text,
              imageUrl: row.last.imageUrl,
              sentAt: row.last.sentAt,
              senderWawuId: row.last.senderWawuId,
              sender: senders.get(row.last.senderWawuId) ?? null,
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
