import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  deriveVerificationState,
  type VerificationState,
} from '../common/verification/verification-state';
import { WawuIdClient } from '../common/auth/wawu-id.client';
import { BlockedAccountService } from '../blocked-account/blocked-account.service';
import { AccountType, ContentStatus } from '../../generated/prisma/enums';
import type { ListCreatorsQueryDto } from './dto/list-creators-query.dto';

/** One card in a creator list. Exactly what the grid renders, nothing more. */
export interface CreatorDiscoveryItem {
  wawuId: string;
  /** Real display name from WAWU ID, falling back to the handle. */
  name: string;
  handle: string | null;
  avatarUrl: string | null;
  /** What they do — their first interest. Null when they have listed none. */
  field: string | null;
  /** Live pieces only. A draft or rejected upload is not something to browse. */
  pieceCount: number;
  /**
   * Both ticks. NOT a tier and not a rank.
   *
   * This used to be the WAWU ID ladder value as a bare string, which every
   * card had to interpret for itself. It is now the two independent ticks,
   * each already decided server-side, and a creator who is also a verified
   * professional shows both. Still never their KYC state, which is private
   * and a different gate entirely.
   */
  verification: VerificationState;
  /** Whether the CALLER follows them. False for an anonymous reader. */
  following: boolean;
}

const DEFAULT_PER_PAGE = 24;

/**
 * Creator discovery — the list behind Explore.
 *
 * This endpoint did not exist, and its absence is why the consumer app's
 * creator lists were mock data with fabricated ids like "wawu-adaeze". There
 * was no way to ask this backend "who are the creators": `/users/:id/public-
 * profile` is a single read, and `/search` requires a non-empty `q`, so
 * browsing was structurally impossible and the frontend invented people.
 *
 * Identity is not this backend's to hold. Names and badge tiers live on WAWU
 * ID and are fetched per page through WawuIdClient. When that lookup fails the
 * list still renders, with handles standing in for names — a directory that
 * disappears because a sibling service is briefly unreachable is worse than a
 * directory showing handles.
 *
 * A row here is also a promise that there is something to browse. It used to
 * be every `accountType: creator` profile, which meant an account that had
 * only just picked "creator" at signup, with no paid subscription and no
 * upload, showed up next to people with real catalogues, and clicking
 * through led nowhere. Uploading itself requires
 * `CreatorState.subscriptionPaid` (see `ContentPieceService.create`), so a
 * creator who has not paid, or has paid but not published yet, can never have
 * a live `ContentPiece` — requiring at least one is therefore the single
 * filter that excludes both "never finished onboarding/paying" and "nothing
 * to show yet", with no second table to join. KYC is deliberately NOT part of
 * this filter: it gates earning, not visibility, and "paid + uploading + KYC
 * pending" is a normal state (CLAUDE.md), not a reason to hide someone.
 */
@Injectable()
export class CreatorDiscoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wawuId: WawuIdClient,
    private readonly blockedAccounts: BlockedAccountService,
  ) {}

  async list(query: ListCreatorsQueryDto, requesterWawuId: string | null) {
    const page = query.page ?? 1;
    const perPage = query.perPage ?? DEFAULT_PER_PAGE;

    // Every creator with at least one live piece, and how many. Computed
    // up front (rather than scoped to the page, as it used to be) because it
    // now also decides WHO is eligible to appear at all, not just what
    // number is printed on their card.
    const liveCounts = await this.prisma.contentPiece.groupBy({
      by: ['creatorWawuId'],
      where: { status: ContentStatus.live },
      _count: { _all: true },
    });
    const pieceCountBy = new Map(
      liveCounts.map((c) => [c.creatorWawuId, c._count._all]),
    );
    // SETTINGS-04: a creator the caller blocked, or who blocked the caller,
    // is not on Explore, and is not counted in `total` either.
    const hidden = new Set(
      await this.blockedAccounts.hiddenFrom(requesterWawuId),
    );
    const eligibleIds = [...pieceCountBy.keys()].filter(
      (id) => !hidden.has(id),
    );

    if (eligibleIds.length === 0) {
      return { items: [], currentPage: page, perPage, total: 0 };
    }

    const where = {
      accountType: AccountType.creator,
      wawuUserId: { in: eligibleIds },
      ...(query.category
        ? {
            interests: {
              // Postgres array containment is exact and case-sensitive, so a
              // profile tagged "Agriculture" would not match a filter of
              // "agriculture". Case is normalised by comparing against both
              // forms rather than lowercasing the column, which would need an
              // expression index to stay fast.
              hasSome: [
                query.category,
                query.category.toLowerCase(),
                query.category.toUpperCase(),
                query.category.charAt(0).toUpperCase() +
                  query.category.slice(1).toLowerCase(),
              ],
            },
          }
        : {}),
    };

    const [profiles, total] = await Promise.all([
      this.prisma.userProfile.findMany({
        where,
        select: {
          wawuUserId: true,
          handle: true,
          interests: true,
          avatarUrl: true,
          creatorVerifiedAt: true,
          creatorVerifiedUntil: true,
          professionalVerifiedAt: true,
          professionalVerifiedUntil: true,
        },
        // A stable order, so page 2 is not page 1 again. `handle` is unique
        // where set; wawuUserId breaks the tie for profiles without one.
        orderBy: [{ handle: 'asc' }, { wawuUserId: 'asc' }],
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.userProfile.count({ where }),
    ]);

    if (profiles.length === 0) {
      return { items: [], currentPage: page, perPage, total };
    }

    const ids = profiles.map((p) => p.wawuUserId);

    const [identities, following] = await Promise.all([
      this.wawuId.lookupPublicIdentities(ids),
      requesterWawuId
        ? this.prisma.followRelationship.findMany({
            where: {
              followerWawuId: requesterWawuId,
              followingWawuId: { in: ids },
            },
            select: { followingWawuId: true },
          })
        : Promise.resolve([]),
    ]);

    const followingSet = new Set(following.map((f) => f.followingWawuId));

    const items: CreatorDiscoveryItem[] = profiles.map((p) => {
      const identity = identities.get(p.wawuUserId);
      const fullName = [identity?.firstName, identity?.lastName]
        .filter(Boolean)
        .join(' ')
        .trim();

      return {
        wawuId: p.wawuUserId,
        // Handle, then nothing. The old fallback ended at `p.wawuUserId`, so a
        // profile with no name and no handle was advertised on Explore as a
        // followable creator called
        // "55d03d5d6-77c2-4761-9297-8c0aaf845426". It was reasoned as better
        // than a blank row; a raw uuid where a person's name goes is worse
        // than either, and such a row is dropped below instead.
        name: fullName || p.handle || '',
        handle: p.handle,
        avatarUrl: p.avatarUrl,
        field: p.interests[0] ?? null,
        pieceCount: pieceCountBy.get(p.wawuUserId) ?? 0,
        // Read off the row already loaded for this page. No extra query, and
        // no dependence on WAWU ID being reachable: lookupPublicIdentities
        // degrades to an empty map when it is not, which would have silently
        // stripped every tick on the page.
        verification: deriveVerificationState(p),
        following: followingSet.has(p.wawuUserId),
      };
    });

    /*
      A CREATOR NOBODY CAN NAME IS NOT DISCOVERABLE.

      Discovery is a list of people to follow. A row with neither a name from
      WAWU ID nor a handle cannot be told apart from any other by the person
      reading it, and it used to be shown as its own uuid. Dropping it is the
      honest answer: the account still exists, its profile still opens by URL,
      it is simply not offered as somebody to follow until it can be named.

      `total` is left as the query counted it rather than adjusted down. It is
      the number of creators matching the filter, which is what paging is built
      on; quietly shrinking it here would make the last page short and the
      cursor arithmetic wrong.
    */
    const named = items.filter((i) => i.name !== '');

    return { items: named, currentPage: page, perPage, total };
  }
}
