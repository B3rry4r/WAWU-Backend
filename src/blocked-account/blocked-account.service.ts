import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { deriveVerificationState } from '../common/verification/verification-state';
import type { Paginated } from '../common/interceptors/response.interceptor';
import type { BlockedAccount, BlockedAccountUser } from '../common/types';
import { WawuIdClient } from '../common/auth/wawu-id.client';
import type { CreateBlockedAccountDto } from './dto/create-blocked-account.dto';

/**
 * BlockedAccount resource — registry.json "BlockedAccount", plus the create
 * endpoint the contract never had.
 *
 * WHAT WAS BROKEN. The table existed, GET (list) and DELETE (unblock) were
 * implemented, and the web app shipped a privacy screen offering "Blocked
 * accounts" — but nothing in the entire codebase ever called
 * `blockedAccount.create`, so a block could not be made; and nothing read
 * the table either, so even a row inserted by hand changed nothing. Both
 * halves are fixed here: `create()` is the write path, and
 * `assertNotBlocked()` is the read path every interaction that must respect
 * a block calls. A block that writes a row and gates nothing is the same
 * bug in a new coat.
 *
 * SYMMETRY. Blocking is enforced in BOTH directions by
 * `isBlockedEitherWay()`: if A blocked B, then B cannot reach A *and* A
 * cannot reach B. The alternative — a one-way mute — lets the blocker keep
 * paying, tipping and messaging someone they have declared they want no
 * contact with, which is not what "block" means on any consumer product.
 */
@Injectable()
export class BlockedAccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wawuId: WawuIdClient,
  ) {}

  /**
   * Batch identity lookup for a page of blocked accounts — same shape as
   * CreatorDiscoveryService.list() and DirectMessageService's
   * lookupOtherParties: one WawuIdClient.lookupPublicIdentities call plus
   * one userProfile.findMany, merged by id. Called once per page in list(),
   * not once per row.
   */
  private async lookupBlockedUsers(
    blockedIds: string[],
  ): Promise<Map<string, BlockedAccountUser>> {
    const unique = [...new Set(blockedIds)];
    const out = new Map<string, BlockedAccountUser>();
    if (unique.length === 0) return out;

    const [identities, profiles] = await Promise.all([
      this.wawuId.lookupPublicIdentities(unique),
      this.prisma.userProfile.findMany({
        where: { wawuUserId: { in: unique } },
        select: {
          wawuUserId: true,
          handle: true,
          avatarUrl: true,
          creatorVerifiedAt: true,
          creatorVerifiedUntil: true,
          professionalVerifiedAt: true,
          professionalVerifiedUntil: true,
        },
      }),
    ]);
    const profileBy = new Map(profiles.map((p) => [p.wawuUserId, p]));

    for (const id of unique) {
      const identity = identities.get(id);
      const profile = profileBy.get(id);
      const fullName = [identity?.firstName, identity?.lastName]
        .filter(Boolean)
        .join(' ')
        .trim();
      out.set(id, {
        wawuId: id,
        name: fullName || profile?.handle || '',
        handle: profile?.handle ?? null,
        avatarUrl: profile?.avatarUrl ?? null,
        // Both ticks, derived through the one function. An id with no profile
        // row on this service carries neither.
        verification: deriveVerificationState(profile ?? null),
      });
    }
    return out;
  }

  /**
   * POST /settings/privacy/blocked — block an account.
   *
   * Additive endpoint on the existing `settings/privacy/blocked` path; no
   * existing route or response shape changes. Returns the BlockedAccount row
   * (the same wire shape GET already returns), so the client can hold the
   * row `id` it needs for the DELETE.
   *
   * Idempotent: blocking someone already blocked returns the existing row
   * rather than 409ing on the `@@unique([userWawuId, blockedWawuId])`
   * constraint — the user's intent ("I do not want contact with this
   * person") is already satisfied, and a second tap on a stale screen is not
   * an error.
   *
   * SIDE EFFECT — follows are severed both ways. Leaving a follow edge in
   * place would keep the blocked account on the blocker's following list and
   * keep feeding them into follower-derived reads, which is the sort of
   * "block that changes nothing" this whole change exists to remove.
   */
  async create(
    userWawuId: string,
    dto: CreateBlockedAccountDto,
  ): Promise<BlockedAccount> {
    if (dto.blockedWawuId === userWawuId) {
      throw new BadRequestException('You cannot block yourself');
    }

    const target = await this.prisma.userProfile.findUnique({
      where: { wawuUserId: dto.blockedWawuId },
      select: { wawuUserId: true },
    });
    if (!target) {
      throw new NotFoundException('Account not found');
    }

    const [row] = await this.prisma.$transaction([
      this.prisma.blockedAccount.upsert({
        where: {
          userWawuId_blockedWawuId: {
            userWawuId,
            blockedWawuId: dto.blockedWawuId,
          },
        },
        update: {},
        create: { userWawuId, blockedWawuId: dto.blockedWawuId },
      }),
      this.prisma.followRelationship.deleteMany({
        where: {
          OR: [
            { followerWawuId: userWawuId, followingWawuId: dto.blockedWawuId },
            { followerWawuId: dto.blockedWawuId, followingWawuId: userWawuId },
          ],
        },
      }),
    ]);

    return row;
  }

  /** GET /settings/privacy/blocked — scoped to the caller, newest-blocked first. */
  async list(
    userWawuId: string,
    page: number,
    perPage: number,
  ): Promise<Paginated<BlockedAccount>> {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.blockedAccount.findMany({
        where: { userWawuId },
        orderBy: { blockedAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.blockedAccount.count({ where: { userWawuId } }),
    ]);

    const blockedUsers = await this.lookupBlockedUsers(
      items.map((i) => i.blockedWawuId),
    );
    const enriched: BlockedAccount[] = items.map((i) => ({
      ...i,
      blockedUser: blockedUsers.get(i.blockedWawuId),
    }));

    return { items: enriched, currentPage: page, perPage, total };
  }

  /**
   * DELETE /settings/privacy/blocked/:id — unblock. `:id` is the
   * BlockedAccount row's own id (registry field, not the blocked user's
   * wawuId). Scoped by userWawuId in the same query so a caller can never
   * unblock (or discover the existence of) another user's block row —
   * a non-owned or non-existent id both 404 identically.
   *
   * Unblocking restores every interaction `assertNotBlocked()` gates; it
   * does NOT restore the follow edges `create()` severed, because a follow
   * is the other party's choice to re-make.
   */
  async remove(userWawuId: string, id: string): Promise<void> {
    const { count } = await this.prisma.blockedAccount.deleteMany({
      where: { id, userWawuId },
    });
    if (count === 0) {
      throw new NotFoundException('No blocked account found for that id');
    }
  }

  /**
   * True if either account has blocked the other. One indexed query, not
   * two — both directions are covered by a single OR over the
   * `[userWawuId]` / `[blockedWawuId]` indexes.
   */
  async isBlockedEitherWay(a: string, b: string): Promise<boolean> {
    if (a === b) return false;
    const hit = await this.prisma.blockedAccount.findFirst({
      where: {
        OR: [
          { userWawuId: a, blockedWawuId: b },
          { userWawuId: b, blockedWawuId: a },
        ],
      },
      select: { id: true },
    });
    return hit !== null;
  }

  /**
   * Every account that must not be shown to `viewer`: the ones they blocked
   * and the ones who blocked them (SETTINGS-04). A block hides people from
   * each other on every read surface, never just from the one who pressed
   * the button, for the same reason `isBlockedEitherWay` is symmetric.
   *
   * Read surfaces call this once per request and filter with the result
   * (`notIn`), so a page costs one indexed query, not one per row. Returns an
   * empty list for a caller with no account (a signed-out reader): a block is
   * between two accounts, so there is nobody to hide anything from.
   *
   * Exported on purpose: the wallet recipient search (WALLET-08) filters its
   * results with this same method.
   */
  async hiddenFrom(viewer: string | null | undefined): Promise<string[]> {
    if (!viewer) return [];
    const rows = await this.prisma.blockedAccount.findMany({
      where: { OR: [{ userWawuId: viewer }, { blockedWawuId: viewer }] },
      select: { userWawuId: true, blockedWawuId: true },
    });
    const ids = new Set<string>();
    for (const r of rows) {
      ids.add(r.userWawuId === viewer ? r.blockedWawuId : r.userWawuId);
    }
    return [...ids];
  }

  /**
   * A profile, piece or room that belongs to a hidden account answers exactly
   * like one that does not exist: a 404 with the caller's own wording, never
   * a 403, so the response cannot be used to learn who blocked whom.
   */
  async assertVisible(
    viewer: string | null | undefined,
    owner: string,
    notFound: string,
  ): Promise<void> {
    if (!viewer || viewer === owner) return;
    if (await this.isBlockedEitherWay(viewer, owner)) {
      throw new NotFoundException(notFound);
    }
  }

  /**
   * The one line every gated interaction calls.
   *
   * 403, not 404: the caller already knows the account exists (they are on
   * its profile, or in a thread with it). Hiding the block behind a 404
   * would be a lie about a resource they can plainly see, and would make
   * every gated endpoint's "does this exist" semantics inconsistent.
   *
   * The message is deliberately neutral in both directions — it never tells
   * the caller WHO blocked WHOM, so a blocked user cannot use the response
   * to confirm they were blocked rather than having blocked.
   */
  async assertNotBlocked(a: string, b: string, message: string): Promise<void> {
    if (await this.isBlockedEitherWay(a, b)) {
      throw new ForbiddenException(message);
    }
  }
}
