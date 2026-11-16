import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  deriveVerificationState,
  holdsAnyTick,
} from '../../common/verification/verification-state';
import { GeoService } from '../../geo/geo.service';
import type { CountrySource } from '../../geo/geo.types';
import {
  WawuIdUsersClient,
  type WawuIdUser,
} from '../../identity-users/wawu-id-users.client';
import { rowsOf } from '../../wallet-provider/provider-rows';
import {
  readWalletProviderName,
  WALLET_PROVIDER_CONFIG_KEY,
} from '../../wallet-provider/wallet-provider-config';
import type {
  AdminUserCountsView,
  AdminUserListItemView,
  AdminUserListPage,
} from './admin-users-view.type';
import type { AdminUsersQueryDto } from './dto/admin-users-query.dto';

/** Lagos is UTC+1 all year (no daylight saving), so the day starts at 23:00 UTC the evening before. */
const LAGOS_OFFSET_MS = 60 * 60_000;
const DAY_MS = 86_400_000;

/** A search walks WAWU ID's matches at most this many pages (of 100). A name search rarely needs one. */
const SEARCH_PAGES = 5;

/** Start of the Lagos day that `now` falls in. */
export function lagosDayStart(now: Date): Date {
  const local = now.getTime() + LAGOS_OFFSET_MS;
  return new Date(
    local - (((local % DAY_MS) + DAY_MS) % DAY_MS) - LAGOS_OFFSET_MS,
  );
}

/**
 * USERS-DASH (R-142): the dashboard's list of everyone who signed up, and four
 * counts. Read only.
 *
 * WHO. Every `UserProfile`, newest first by `UserProfile.createdAt` (the Hub
 * profile has its own creation date; it is the date the Hub account was
 * made, which can be a little after the WAWU ID sign-up for someone who
 * finished onboarding later), then by id so a page never shifts.
 *
 * WHERE EACH FIELD IS FROM.
 *  - name, email, phone: WAWU ID, by the ids of the page being shown (one
 *    call per page). Stored nowhere, never logged.
 *  - country, source: ProfileDetails (`countrySource` null with a country is
 *    `profile`, as `me()` reads it).
 *  - tickHeld: the two tick columns on UserProfile through
 *    `deriveVerificationState` (a lapsed tick is not held).
 *  - walletOpened: a FintavaWallet row of the provider this server runs
 *    (`WALLET_PROVIDER`, `rowsOf`), the same rule the admin wallets list uses.
 *  - suspended: a UserSuspension row with `liftedAt` null, what
 *    `GET /admin/users/:id/suspension` reads.
 *
 * SEARCH (`q`, 2 characters or more). Two sources: a part of a handle (a
 * Hub query) OR what WAWU ID's own `q` matches (a part of a name, a whole
 * email, a whole phone in any usual form), kept only for people who have a
 * Hub account. WAWU ID's matches are read newest first, 100 a page, up to
 * 500; the Hub then pages the union (`handle contains q OR id in matches`)
 * with `page`/`perPage` as without `q`, and `total` is the union's count.
 * A search that matches over 500 people in WAWU ID is cut at the 500 newest
 * (handle matches are never cut). If WAWU ID cannot answer the search, the
 * handle matches are listed and `contactUnavailable` is true.
 */
@Injectable()
export class AdminUsersService {
  private readonly walletProvider;

  constructor(
    private readonly prisma: PrismaService,
    private readonly geo: GeoService,
    private readonly identity: WawuIdUsersClient,
    config: ConfigService,
  ) {
    this.walletProvider = readWalletProviderName(
      config.get<string>(WALLET_PROVIDER_CONFIG_KEY),
    );
  }

  async list(query: AdminUsersQueryDto): Promise<AdminUserListPage> {
    const q = query.q?.trim();
    let contactUnavailable = false;
    let where: object = {};

    if (q) {
      const matchedIds: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < SEARCH_PAGES; i += 1) {
        const found = await this.identity.search(q, cursor);
        if (found === null) {
          contactUnavailable = true;
          break;
        }
        for (const u of found.items) matchedIds.push(u.id);
        cursor = found.nextCursor;
        if (cursor === null) break;
      }
      where = {
        OR: [
          { handle: { contains: q, mode: 'insensitive' as const } },
          ...(matchedIds.length > 0
            ? [{ wawuUserId: { in: matchedIds } }]
            : []),
        ],
      };
    }

    const [profiles, total] = await this.prisma.$transaction([
      this.prisma.userProfile.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { wawuUserId: 'desc' }],
        skip: (query.page - 1) * query.perPage,
        take: query.perPage,
      }),
      this.prisma.userProfile.count({ where }),
    ]);

    const ids = profiles.map((p) => p.wawuUserId);
    const [people, details, suspensions, wallets] = await Promise.all([
      ids.length > 0
        ? this.identity.byIds(ids)
        : Promise.resolve(new Map<string, WawuIdUser>()),
      this.prisma.profileDetails.findMany({
        where: { wawuUserId: { in: ids } },
        select: { wawuUserId: true, countryCode: true, countrySource: true },
      }),
      this.prisma.userSuspension.findMany({
        where: { wawuUserId: { in: ids }, liftedAt: null },
        select: { wawuUserId: true },
      }),
      this.prisma.fintavaWallet.findMany({
        where: {
          AND: [{ wawuUserId: { in: ids } }, rowsOf(this.walletProvider)],
        },
        select: { wawuUserId: true },
      }),
    ]);
    if (people === null) contactUnavailable = true;

    const place = new Map(details.map((d) => [d.wawuUserId, d]));
    const suspended = new Set(suspensions.map((s) => s.wawuUserId));
    const walletOpen = new Set(wallets.map((w) => w.wawuUserId));
    const now = new Date();

    const items: AdminUserListItemView[] = profiles.map((p) => {
      const person = people?.get(p.wawuUserId) ?? null;
      const d = place.get(p.wawuUserId);
      const country = this.geo.country(d?.countryCode ?? null);
      return {
        wawuId: p.wawuUserId,
        firstName: person?.firstName ?? null,
        lastName: person?.lastName ?? null,
        handle: p.handle,
        email: person?.email ?? null,
        phone: person?.phone ?? null,
        countryCode: country?.code ?? null,
        countryName: country?.name ?? null,
        countrySource: country
          ? ((d?.countrySource ?? 'profile') as CountrySource)
          : null,
        accountType: p.accountType,
        joinedAt: p.createdAt,
        tickHeld: holdsAnyTick(deriveVerificationState(p, now)),
        walletOpened: walletOpen.has(p.wawuUserId),
        suspended: suspended.has(p.wawuUserId),
      };
    });

    return {
      items,
      currentPage: query.page,
      perPage: query.perPage,
      total,
      contactUnavailable,
    };
  }

  async counts(now: Date = new Date()): Promise<AdminUserCountsView> {
    const start = lagosDayStart(now);
    const [total, creators, joinedToday, noCountry] = await Promise.all([
      this.prisma.userProfile.count(),
      this.prisma.userProfile.count({ where: { accountType: 'creator' } }),
      this.prisma.userProfile.count({ where: { createdAt: { gte: start } } }),
      this.prisma.$queryRaw<Array<{ n: bigint | number }>>`
        SELECT COUNT(*) AS "n"
        FROM "UserProfile" p
        LEFT JOIN "ProfileDetails" d ON d."wawuUserId" = p."wawuUserId"
        WHERE d."countryCode" IS NULL`,
    ]);
    return {
      total,
      creators,
      joinedToday,
      noCountry: Number(noCountry[0]?.n ?? 0),
    };
  }
}
