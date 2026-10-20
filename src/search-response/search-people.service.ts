import { Injectable } from '@nestjs/common';
import { AccountType } from '../../generated/prisma/enums';
import { WawuIdClient } from '../common/auth/wawu-id.client';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  deriveVerificationState,
  type VerificationState,
} from '../common/verification/verification-state';
import { BlockedAccountService } from '../blocked-account/blocked-account.service';
import { StorageService } from '../storage/storage.service';

/**
 * EXPLORE-02. One person on Search: the card a result row or "Creators to
 * know" draws. `GET /search` and `GET /search/suggestions` name creators by id
 * and handle only (their answers are the web's and do not change), so the app
 * asks for the names of the people it is about to draw in one call.
 */
export interface SearchPerson {
  wawuId: string;
  /** The real name from WAWU ID, else the handle. Never empty. */
  name: string;
  handle: string | null;
  avatarUrl: string | null;
  /** What they do: the first of their interests. */
  field: string | null;
  /** Both ticks, decided on the server from the expiry. */
  verification: VerificationState;
  /** Whether the caller follows them; false when signed out. */
  following: boolean;
}

export interface SearchPeople {
  items: SearchPerson[];
}

/**
 * Who a search row may name: a creator account that is not blocked either way
 * with the caller and has not switched "show me in member lists" off (the
 * same two rules Explore's creator lists use). A person who does not qualify,
 * or does not exist, is simply not in the answer; nothing tells the two apart.
 * Nothing here holds a database connection while WAWU ID or storage answers:
 * each read is one query that has ended before the next call begins.
 */
@Injectable()
export class SearchPeopleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly blockedAccounts: BlockedAccountService,
    private readonly wawuId: WawuIdClient,
    private readonly storage: StorageService,
  ) {}

  async people(
    ids: string[],
    viewer: string | undefined,
  ): Promise<SearchPeople> {
    const asked = [...new Set(ids)];
    if (asked.length === 0) return { items: [] };

    const hidden = await this.blockedAccounts.hiddenFrom(viewer);
    const [profiles, off, followed] = await Promise.all([
      this.prisma.userProfile.findMany({
        where: {
          wawuUserId: { in: asked, notIn: hidden },
          accountType: AccountType.creator,
        },
        select: {
          wawuUserId: true,
          handle: true,
          avatarUrl: true,
          interests: true,
          creatorVerifiedAt: true,
          creatorVerifiedUntil: true,
          professionalVerifiedAt: true,
          professionalVerifiedUntil: true,
        },
      }),
      this.prisma.privacySettings.findMany({
        where: { userWawuId: { in: asked }, showInMemberLists: false },
        select: { userWawuId: true },
      }),
      viewer
        ? this.prisma.followRelationship.findMany({
            where: { followerWawuId: viewer, followingWawuId: { in: asked } },
            select: { followingWawuId: true },
          })
        : Promise.resolve([] as Array<{ followingWawuId: string }>),
    ]);
    const offLists = new Set(off.map((o) => o.userWawuId));
    const byId = new Map(
      profiles
        .filter((p) => !offLists.has(p.wawuUserId))
        .map((p) => [p.wawuUserId, p]),
    );
    if (byId.size === 0) return { items: [] };
    const identities = await this.wawuId.lookupPublicIdentities([
      ...byId.keys(),
    ]);
    const followingSet = new Set(followed.map((f) => f.followingWawuId));

    const items: SearchPerson[] = [];
    for (const id of asked) {
      const p = byId.get(id);
      if (!p) continue;
      const identity = identities.get(id);
      const name =
        [identity?.firstName, identity?.lastName]
          .filter(Boolean)
          .join(' ')
          .trim() ||
        (p.handle ?? '');
      if (name === '') continue;
      items.push({
        wawuId: id,
        name,
        handle: p.handle,
        avatarUrl: await this.storage.freshUrlFor(p.avatarUrl),
        field: p.interests[0] ?? null,
        verification: deriveVerificationState(p),
        following: followingSet.has(id),
      });
    }
    return { items };
  }
}
