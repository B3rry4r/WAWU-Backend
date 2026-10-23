import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MoviePartnerMovie, Prisma } from '../../generated/prisma/client';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import type { Paginated } from '../common/interceptors/response.interceptor';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  MOVIE_PARTNER,
  MoviePartnerError,
  type MoviePartner,
  type PartnerPerson,
} from '../movie-partner/movie-partner.interface';
import { BrowseMoviesQueryDto, SearchMoviesQueryDto } from './movies.dto';
import {
  ACCOUNT_CLOSING_MESSAGE,
  EMAIL_REQUIRED_MESSAGE,
  MOVIE_NOT_FOUND_MESSAGE,
  MOVIE_NOT_PREMIERED_MESSAGE,
  MOVIES_OFF_MESSAGE,
  MOVIES_UNAVAILABLE_MESSAGE,
  MoviesError,
  TERMS_NOT_AGREED_MESSAGE,
} from './movies-error';
import { cardOf, detailOf, isPremiering } from './movies-mapping';
import { readTermsFrom } from './movies-settings';
import type {
  MovieCardView,
  MovieDetailView,
  MovieFiltersView,
  MoviesHomeView,
  MovieRailView,
  MovieWatchView,
} from './movies-view.type';

/** Titles in one rail. */
export const RAIL_SIZE = 12;

const OFF_HOME: MoviesHomeView = { enabled: false, hero: null, rails: [] };

/** AccountDeletion statuses that mean the person is leaving (cancelled is the only one that does not). */
const DELETING = new Set(['freezing', 'scheduled', 'purging', 'purged']);

/**
 * Flix movies (FLIX-01, R-74, R-75). Every read is from the Hub's own copy of
 * the catalog; the partner is reached only by `watch`, through the
 * `MOVIE_PARTNER` seam, and only with a person's id, email, first and last
 * name and whether the email is verified.
 */
@Injectable()
export class MoviesService {
  private readonly logger = new Logger(MoviesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(MOVIE_PARTNER) private readonly partner: MoviePartner,
  ) {}

  private requireOn(): string {
    if (!this.partner.enabled) {
      throw new MoviesError('movies_off', MOVIES_OFF_MESSAGE);
    }
    return this.partner.name;
  }

  async home(): Promise<MoviesHomeView> {
    if (!this.partner.enabled) return OFF_HOME;
    const provider = this.partner.name;
    const now = new Date();
    const ahead: Prisma.MoviePartnerMovieWhereInput = {
      provider,
      premiering: true,
      OR: [{ premierDate: null }, { premierDate: { gt: now } }],
    };
    const [newest, watched, rated, premiering] = await Promise.all([
      this.prisma.moviePartnerMovie.findMany({
        where: { provider },
        orderBy: [{ partnerAddedAt: 'desc' }, { id: 'asc' }],
        take: RAIL_SIZE,
      }),
      this.prisma.moviePartnerMovie.findMany({
        where: { provider, views: { gt: 0 } },
        orderBy: [{ views: 'desc' }, { id: 'asc' }],
        take: RAIL_SIZE,
      }),
      this.prisma.moviePartnerMovie.findMany({
        where: { provider, ratingCount: { gt: 0 } },
        orderBy: [{ rating: 'desc' }, { ratingCount: 'desc' }, { id: 'asc' }],
        take: RAIL_SIZE,
      }),
      this.prisma.moviePartnerMovie.findMany({
        where: ahead,
        orderBy: [
          { premierDate: { sort: 'asc', nulls: 'last' } },
          { id: 'asc' },
        ],
        take: RAIL_SIZE,
      }),
    ]);
    const hero =
      (await this.prisma.moviePartnerMovie.findFirst({
        where: { provider, backdropImage: { not: null } },
        orderBy: [{ partnerAddedAt: 'desc' }, { id: 'asc' }],
      })) ??
      newest[0] ??
      null;
    const rail = (
      key: MovieRailView['key'],
      title: string,
      rows: MoviePartnerMovie[],
    ): MovieRailView[] =>
      rows.length === 0
        ? []
        : [{ key, title, movies: rows.map((r) => cardOf(r, now)) }];
    return {
      enabled: true,
      hero: hero ? cardOf(hero, now) : null,
      rails: [
        ...rail('new', 'New on Flixora', newest),
        ...rail('most_watched', 'Most watched', watched),
        ...rail('top_rated', 'Top rated', rated),
        ...rail('premiering_soon', 'Premiering soon', premiering),
      ],
    };
  }

  async browse(query: BrowseMoviesQueryDto): Promise<Paginated<MovieCardView>> {
    const provider = this.requireOn();
    const now = new Date();
    const and: Prisma.MoviePartnerMovieWhereInput[] = [];
    if (query.genre !== undefined) and.push({ genre: { has: query.genre } });
    if (query.language !== undefined) and.push({ language: query.language });
    if (query.premiering === true) {
      and.push({
        premiering: true,
        OR: [{ premierDate: null }, { premierDate: { gt: now } }],
      });
    } else if (query.premiering === false) {
      and.push({
        OR: [{ premiering: false }, { premierDate: { lte: now } }],
      });
    }
    return this.page(
      { provider, AND: and },
      orderFor(query.sort ?? 'newest'),
      query.page,
      query.perPage,
      now,
    );
  }

  async search(query: SearchMoviesQueryDto): Promise<Paginated<MovieCardView>> {
    const provider = this.requireOn();
    const text = query.q.trim().replace(/[\\%_]/g, '\\$&');
    return this.page(
      {
        provider,
        OR: [
          { title: { contains: text, mode: 'insensitive' } },
          { originalTitle: { contains: text, mode: 'insensitive' } },
          { tagline: { contains: text, mode: 'insensitive' } },
        ],
      },
      orderFor('newest'),
      query.page,
      query.perPage,
      new Date(),
    );
  }

  async filters(): Promise<MovieFiltersView> {
    const provider = this.requireOn();
    const rows = await this.prisma.moviePartnerMovie.findMany({
      where: { provider },
      select: { genre: true, language: true },
    });
    const genres = new Set<string>();
    const languages = new Set<string>();
    for (const r of rows) {
      for (const g of r.genre) genres.add(g);
      if (r.language !== null) languages.add(r.language);
    }
    const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    return {
      genres: [...genres].sort(order),
      languages: [...languages].sort(order),
    };
  }

  async detail(user: WawuJwtClaims, movieId: string): Promise<MovieDetailView> {
    const provider = this.requireOn();
    const row = await this.find(provider, movieId);
    const agreed = await this.hasAgreed(provider, user.sub);
    return detailOf(row, new Date(), !agreed);
  }

  async watch(
    user: WawuJwtClaims,
    movieId: string,
    agreeToTerms: boolean,
  ): Promise<MovieWatchView> {
    const provider = this.requireOn();
    const row = await this.find(provider, movieId);

    // Until the premiere only the trailer is available (PARTNER-API.md, "premierDate"):
    // no link, and no agreement stored, for a title that cannot be watched yet.
    if (isPremiering(row, new Date())) {
      throw new MoviesError('movie_not_premiered', MOVIE_NOT_PREMIERED_MESSAGE);
    }

    // A person who is leaving gets no more links (R-75).
    const [deletion, link] = await Promise.all([
      this.prisma.accountDeletion.findUnique({
        where: { wawuUserId: user.sub },
        select: { status: true },
      }),
      this.prisma.moviePartnerLink.findUnique({
        where: { provider_wawuUserId: { provider, wawuUserId: user.sub } },
        select: { accountDeletedAt: true },
      }),
    ]);
    if (
      (deletion !== null && DELETING.has(deletion.status)) ||
      link?.accountDeletedAt
    ) {
      throw new MoviesError('account_closing', ACCOUNT_CLOSING_MESSAGE);
    }

    // The agreement comes first and is stored before any link is made.
    const how = await this.agreementFor(provider, user.sub);
    if (how === null) {
      if (!agreeToTerms) {
        throw new MoviesError('terms_not_agreed', TERMS_NOT_AGREED_MESSAGE);
      }
      await this.storeConsent(provider, user.sub, 'mv4');
    } else if (how === 'signup') {
      await this.storeConsent(provider, user.sub, 'signup');
    }

    const person = personOf(user);
    if (person === null) {
      throw new MoviesError('email_required', EMAIL_REQUIRED_MESSAGE);
    }

    // The partner call holds no transaction, connection or lock. The link is
    // used for this answer only: never stored, never logged.
    let made;
    try {
      made = await this.partner.signedInLink(person, {
        id: row.partnerMovieId,
        path: row.partnerPath,
      });
    } catch (err) {
      this.logger.warn(
        `A watch link was not made: ${err instanceof MoviePartnerError ? err.kind : 'error'}.`,
      );
      throw new MoviesError('movies_unavailable', MOVIES_UNAVAILABLE_MESSAGE);
    }

    const at = new Date();
    await this.prisma.moviePartnerLink.upsert({
      where: { provider_wawuUserId: { provider, wawuUserId: user.sub } },
      create: {
        provider,
        wawuUserId: user.sub,
        firstLinkAt: at,
        lastLinkAt: at,
        linkCount: 1,
      },
      update: { lastLinkAt: at, linkCount: { increment: 1 } },
    });
    return { url: made.url, expiresAt: made.expiresAt.toISOString() };
  }

  private async find(
    provider: string,
    movieId: string,
  ): Promise<MoviePartnerMovie> {
    const row = await this.prisma.moviePartnerMovie.findUnique({
      where: { provider_partnerMovieId: { provider, partnerMovieId: movieId } },
    });
    if (!row) throw new MoviesError('movie_not_found', MOVIE_NOT_FOUND_MESSAGE);
    return row;
  }

  private async page(
    where: Prisma.MoviePartnerMovieWhereInput,
    orderBy: Prisma.MoviePartnerMovieOrderByWithRelationInput[],
    page: number,
    perPage: number,
    now: Date,
  ): Promise<Paginated<MovieCardView>> {
    const [total, rows] = await Promise.all([
      this.prisma.moviePartnerMovie.count({ where }),
      this.prisma.moviePartnerMovie.findMany({
        where,
        orderBy,
        skip: (page - 1) * perPage,
        take: perPage,
      }),
    ]);
    return {
      items: rows.map((r) => cardOf(r, now)),
      currentPage: page,
      perPage,
      total,
    };
  }

  /**
   * How this person agreed: `mv4` or `signup` if a consent row exists; `signup`
   * if they signed up on or after FLIXORA_TERMS_FROM; null if they have not.
   * The sign-up time is the Hub's `UserProfile.createdAt` (the first time the
   * person finished onboarding on the Hub), the earliest sign-up time the Hub
   * holds: the access token carries none. No profile row means no time, so no
   * agreement.
   */
  private async agreementFor(
    provider: string,
    wawuUserId: string,
  ): Promise<'signup' | 'mv4' | null> {
    const stored = await this.prisma.moviePartnerConsent.findUnique({
      where: { provider_wawuUserId: { provider, wawuUserId } },
      select: { how: true },
    });
    if (stored) return stored.how === 'mv4' ? 'mv4' : 'signup';
    const from = readTermsFrom(this.config);
    if (from === null) return null;
    const profile = await this.prisma.userProfile.findUnique({
      where: { wawuUserId },
      select: { createdAt: true },
    });
    return profile !== null && profile.createdAt.getTime() >= from.getTime()
      ? 'signup'
      : null;
  }

  private async hasAgreed(
    provider: string,
    wawuUserId: string,
  ): Promise<boolean> {
    return (await this.agreementFor(provider, wawuUserId)) !== null;
  }

  /** One row per person and provider: a repeat stores nothing more. */
  private async storeConsent(
    provider: string,
    wawuUserId: string,
    how: 'signup' | 'mv4',
  ): Promise<void> {
    await this.prisma.moviePartnerConsent.createMany({
      data: [{ provider, wawuUserId, how }],
      skipDuplicates: true,
    });
  }
}

function orderFor(
  sort: 'newest' | 'rating' | 'views' | 'title',
): Prisma.MoviePartnerMovieOrderByWithRelationInput[] {
  switch (sort) {
    case 'rating':
      return [{ rating: 'desc' }, { ratingCount: 'desc' }, { id: 'asc' }];
    case 'views':
      return [{ views: 'desc' }, { id: 'asc' }];
    case 'title':
      return [{ titleSort: 'asc' }, { id: 'asc' }];
    default:
      return [{ partnerAddedAt: 'desc' }, { id: 'asc' }];
  }
}

/**
 * The only facts about a person the partner is given. Built field by field
 * from the verified token, so nothing else (phone, country, wallet) can ride
 * along. Null when the person has no email, which the partner requires.
 */
export function personOf(user: WawuJwtClaims): PartnerPerson | null {
  const email = (user.email ?? '').trim();
  if (email === '') return null;
  const flags = user as unknown as { emailVerified?: unknown };
  return {
    sub: user.sub,
    email,
    firstName: (user.firstName ?? '').trim(),
    lastName: (user.lastName ?? '').trim(),
    emailVerified: flags.emailVerified === true,
  };
}
