// Contract tests for task FLIX-01: Flix movies on the Hub (R-74, R-75).
//
// Real HTTP against the caller's DATABASE_URL with real RS256 tokens from
// mock-wawu-id, the real controller, services, sync job and seam wiring
// (MoviePartnerModule), on the in-process stand-in partner. No network call is
// made to any partner. NOT RUN against the real partner: that is FLIX-02.
// No payment provider and no Fintava double is started.

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { ChildProcess, spawn } from 'node:child_process';
import type { Server } from 'node:http';
import * as path from 'node:path';
import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AccountPurgeHooks } from '../../account-purge/purge-hooks';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { EXPORT_SECTIONS } from '../../data-export-request/data-export-sections';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { MoviePartnerModule } from '../../movie-partner/movie-partner.module';
import {
  MOVIE_PARTNER,
  type MoviePartner,
} from '../../movie-partner/movie-partner.interface';
import { OffMoviePartner } from '../../movie-partner/off-movie-partner';
import { StandinMoviePartner } from '../../movie-partner/standin/standin-movie-partner';
import { standinMovies } from '../../movie-partner/standin/standin-titles';
import { MovieSyncService } from '../movie-sync.service';
import { MoviesController } from '../movies.controller';
import { MoviesService } from '../movies.service';
import { MoviesPurgeService } from '../movies-purge.service';

jest.setTimeout(120_000);

const PLAIN = '00000000-0000-4000-8000-000000000001';
const BASIC = '00000000-0000-4000-8000-000000000002';
const MOCK_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_BASE = `http://localhost:${MOCK_PORT}`;
const ROUTES = [
  '/movies/browse',
  '/movies/filters',
  '/movies/search?q=a',
  '/movies/standin-001',
];

async function waitForHealth(url: string, timeoutMs = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function login(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) throw new Error(`mock-wawu-id login failed for ${identifier}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

interface Harness {
  app: INestApplication;
  prisma: PrismaService;
  partner: MoviePartner;
  sync: MovieSyncService;
  hooks: AccountPurgeHooks;
  as: (
    who: string,
    method: 'get' | 'post',
    url: string,
    body?: object,
  ) => request.Test;
  anon: () => ReturnType<typeof request>;
  close: () => Promise<void>;
}

/** Boots the movie routes with MOVIE_PARTNER set to `name` (undefined: unset). */
async function boot(
  name: string | undefined,
  tokens: Record<string, string>,
  mock: ChildProcess | undefined,
): Promise<Harness> {
  if (name === undefined) delete process.env.MOVIE_PARTNER;
  else process.env.MOVIE_PARTNER = name;
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true }),
      PrismaModule,
      WawuAuthModule,
      MoviePartnerModule,
    ],
    controllers: [MoviesController],
    providers: [
      MoviesService,
      MovieSyncService,
      MoviesPurgeService,
      AccountPurgeHooks,
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new ResponseInterceptor());
  await app.init();
  const http = () => request(app.getHttpServer() as Server);
  return {
    app,
    prisma: moduleRef.get(PrismaService),
    partner: moduleRef.get<MoviePartner>(MOVIE_PARTNER),
    sync: moduleRef.get(MovieSyncService),
    hooks: moduleRef.get(AccountPurgeHooks),
    as: (who, method, url, body) => {
      const req = http()
        [method](url)
        .set('Authorization', `Bearer ${tokens[who]}`);
      return body ? req.send(body) : req;
    },
    anon: http,
    close: async () => {
      await app.close();
      void mock;
    },
  };
}

const data = <T>(res: { body: unknown }): T => (res.body as { data: T }).data;
const codeOf = (res: { body: unknown }): string =>
  (res.body as { reason: { code: string } }).reason.code;
const standin = (h: Harness) => h.partner as StandinMoviePartner;

describe('FLIX-01: Flix movies (contract)', () => {
  let mock: ChildProcess | undefined;
  let tokens: Record<string, string>;
  const users = [PLAIN, BASIC, 'flix01-test-new-user'];

  beforeAll(async () => {
    if (!(await waitForHealth(`${MOCK_BASE}/health`, 1000))) {
      mock = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '../../../mock-wawu-id'),
        env: { ...process.env, MOCK_WAWU_ID_PORT: MOCK_PORT },
        stdio: 'ignore',
      });
      if (!(await waitForHealth(`${MOCK_BASE}/health`)))
        throw new Error('mock-wawu-id did not become healthy in time');
    }
    tokens = {
      [PLAIN]: await login('user@test.wawu.dev'),
      [BASIC]: await login('creator-basic@test.wawu.dev'),
    };
  });
  afterAll(() => {
    mock?.kill();
  });

  const clean = async (h: Harness) => {
    await h.prisma.moviePartnerLink.deleteMany({
      where: { wawuUserId: { in: users } },
    });
    await h.prisma.moviePartnerConsent.deleteMany({
      where: { wawuUserId: { in: users } },
    });
    await h.prisma.accountDeletion.deleteMany({
      where: { wawuUserId: { in: users } },
    });
    await h.prisma.moviePartnerMovie.deleteMany({});
    await h.prisma.moviePartnerSync.deleteMany({});
  };

  // ---------------------------------------------------------------------------
  describe('MOVIE_PARTNER off (unset, empty or "off")', () => {
    it.each([undefined, '', '  ', 'off', ' OFF '])(
      'hides everything for %j: enabled false on GET /movies, 404 movies_off on every other route, no call and no link',
      async (value) => {
        const offCalls = [
          jest.spyOn(OffMoviePartner.prototype, 'listMovies'),
          jest.spyOn(OffMoviePartner.prototype, 'getMovie'),
          jest.spyOn(OffMoviePartner.prototype, 'signedInLink'),
        ];
        const h = await boot(value, tokens, mock);
        try {
          expect(h.partner.name).toBe('off');
          expect(h.partner.enabled).toBe(false);
          const home = await h.as(PLAIN, 'get', '/movies').expect(200);
          expect(data(home)).toEqual({ enabled: false, hero: null, rails: [] });
          for (const url of ROUTES) {
            const res = await h.as(PLAIN, 'get', url).expect(404);
            expect(codeOf(res)).toBe('movies_off');
          }
          const watch = await h
            .as(PLAIN, 'post', '/movies/standin-001/watch', {
              agreeToTerms: true,
            })
            .expect(404);
          expect(codeOf(watch)).toBe('movies_off');
          // The sync job does nothing either.
          expect(await h.sync.runPass()).toMatchObject({
            mode: 'skipped',
            note: 'off',
          });
          for (const spy of offCalls) expect(spy).not.toHaveBeenCalled();
          expect(
            await h.prisma.moviePartnerLink.count({
              where: { wawuUserId: PLAIN },
            }),
          ).toBe(0);
          expect(
            await h.prisma.moviePartnerConsent.count({
              where: { wawuUserId: PLAIN },
            }),
          ).toBe(0);
        } finally {
          await h.close();
          offCalls.forEach((s) => s.mockRestore());
        }
      },
    );

    it('leaves the stored copy and rows alone, and needs a signed-in caller on every route', async () => {
      const h = await boot('standin', tokens, mock);
      await h.sync.runPass({ full: true });
      const held = await h.prisma.moviePartnerMovie.count();
      expect(held).toBeGreaterThan(0);
      await h.close();
      const off = await boot('off', tokens, mock);
      try {
        expect(await off.prisma.moviePartnerMovie.count()).toBe(held);
        expect((await off.anon().get('/movies')).status).toBe(401);
        for (const url of ROUTES)
          expect((await off.anon().get(url)).status).toBe(401);
        expect(
          (await off.anon().post('/movies/standin-001/watch')).status,
        ).toBe(401);
      } finally {
        await clean(off);
        await off.close();
      }
    });

    it('stops the server at boot for a MOVIE_PARTNER it cannot run (flixora is FLIX-02)', async () => {
      await expect(boot('flixora', tokens, mock)).rejects.toThrow(
        /not built yet/,
      );
      await expect(boot('banana', tokens, mock)).rejects.toThrow(
        /must be one of/,
      );
    });
  });

  // ---------------------------------------------------------------------------
  describe('standin serves every route from the copy', () => {
    let h: Harness;
    beforeAll(async () => {
      h = await boot('standin', tokens, mock);
    });
    afterAll(async () => {
      await clean(h);
      await h.close();
    });
    beforeEach(async () => {
      await clean(h);
      await h.sync.runPass({ full: true });
    });

    it('GET /movies: a hero and the four rails, built from the copy only', async () => {
      const callsBefore = standin(h).calls.length;
      const res = await h.as(PLAIN, 'get', '/movies').expect(200);
      const home = data<{
        enabled: boolean;
        hero: { id: string } | null;
        rails: {
          key: string;
          title: string;
          movies: { id: string; premiering: boolean }[];
        }[];
      }>(res);
      expect(home.enabled).toBe(true);
      expect(home.hero).not.toBeNull();
      expect(home.rails.map((r) => r.key)).toEqual([
        'new',
        'most_watched',
        'top_rated',
        'premiering_soon',
      ]);
      expect(home.rails.map((r) => r.title)).toEqual([
        'New on Flixora',
        'Most watched',
        'Top rated',
        'Premiering soon',
      ]);
      const by = (k: string) => home.rails.find((r) => r.key === k)!.movies;
      // newest first
      expect(by('new')[0].id).toBe('standin-010');
      // most views first
      expect(by('most_watched')[0].id).toBe('standin-003');
      // best rating first; titles with no ratings are left out
      expect(by('top_rated')[0].id).toBe('standin-003');
      expect(by('top_rated').every((m) => m.id !== 'standin-009')).toBe(true);
      // soonest premiere first
      expect(by('premiering_soon').map((m) => m.id)).toEqual([
        'standin-010',
        'standin-009',
        'standin-011',
      ]);
      expect(by('premiering_soon').every((m) => m.premiering)).toBe(true);
      // screens never call the partner
      expect(standin(h).calls.length).toBe(callsBefore);
    });

    it('GET /movies/browse: sorts, filters and a total', async () => {
      const get = async (qs: string) =>
        (await h.as(PLAIN, 'get', `/movies/browse${qs}`).expect(200)).body as {
          data: { id: string; title: string; rating: number; views: number }[];
          pagination: {
            total: number;
            perPage: number;
            currentPage: number;
            nextPage: number | null;
          };
        };
      const all = await get('?perPage=100');
      expect(all.pagination.total).toBe(14);
      expect(all.data).toHaveLength(14);
      // newest is the default
      expect(all.data[0].id).toBe('standin-010');
      const byRating = await get('?sort=rating&perPage=3');
      expect(byRating.data.map((m) => m.id)).toEqual([
        'standin-003',
        'standin-001',
        'standin-013',
      ]);
      expect(byRating.pagination).toMatchObject({
        total: 14,
        perPage: 3,
        currentPage: 1,
        nextPage: 2,
      });
      const byViews = await get('?sort=views&perPage=2');
      expect(byViews.data.map((m) => m.id)).toEqual([
        'standin-003',
        'standin-005',
      ]);
      const byTitle = await get('?sort=title&perPage=100');
      expect(byTitle.data[0].title).toBe('Ash and Ankara');
      // Ordered by lower-case title; where a title with accents falls depends on the database's collation, so only the plain ones are compared.
      const plain = byTitle.data
        .map((m) => m.title)
        .filter((t) => /^[A-Za-z ]+$/.test(t));
      expect(plain).toEqual(
        [...plain].sort((a, b) =>
          a.toLowerCase().localeCompare(b.toLowerCase(), 'en'),
        ),
      );
      const page2 = await get('?sort=title&perPage=5&page=2');
      expect(page2.data.map((m) => m.title)).toEqual(
        byTitle.data.slice(5, 10).map((m) => m.title),
      );
      const drama = await get('?genre=Drama&perPage=100');
      expect(drama.pagination.total).toBe(5);
      const yoruba = await get('?language=Yoruba');
      expect(yoruba.data.map((m) => m.id)).toEqual(['standin-005']);
      const premiering = await get('?premiering=true&perPage=100');
      expect(premiering.data.map((m) => m.id).sort()).toEqual([
        'standin-009',
        'standin-010',
        'standin-011',
      ]);
      const notPremiering = await get('?premiering=false&perPage=100');
      expect(notPremiering.pagination.total).toBe(11);
      const both = await get('?genre=Comedy&premiering=true');
      expect(both.data.map((m) => m.id)).toEqual(['standin-010']);
      expect(
        (await h.as(PLAIN, 'get', '/movies/browse?sort=nope')).status,
      ).toBe(400);
      expect(
        (await h.as(PLAIN, 'get', '/movies/browse?perPage=0')).status,
      ).toBe(400);
    });

    it('GET /movies/filters: the genres and languages the copy holds', async () => {
      const f = data<{ genres: string[]; languages: string[] }>(
        await h.as(PLAIN, 'get', '/movies/filters').expect(200),
      );
      expect(f.genres).toEqual([
        'Action',
        'Adventure',
        'Comedy',
        'Documentary',
        'Drama',
        'Family',
        'Fantasy',
        'Historical',
        'Romance',
        'Thriller',
      ]);
      expect(f.languages).toEqual([
        'English',
        'Igbo',
        'Pidgin',
        'Swahili',
        'Twi',
        'Yoruba',
      ]);
    });

    it('GET /movies/search: finds by title, original title and tagline, ignoring case; a wildcard is just text', async () => {
      const find = async (q: string) =>
        (
          data<{ id: string }[]>(
            await h
              .as(PLAIN, 'get', `/movies/search?q=${encodeURIComponent(q)}`)
              .expect(200),
          ) ?? []
        ).map((m) => m.id);
      expect(await find('salt')).toEqual(['standin-001']);
      expect(await find('ÌYÁ')).toEqual(['standin-005']);
      expect(await find('very loud')).toEqual(['standin-003']);
      expect(await find('zzzz')).toEqual([]);
      expect(await find('%')).toEqual([]);
      expect((await h.as(PLAIN, 'get', '/movies/search')).status).toBe(400);
    });

    it('GET /movies/{movieId}: every field, the trailer with its kind, and 404 for an unknown title', async () => {
      const file = data<Record<string, unknown>>(
        await h.as(PLAIN, 'get', '/movies/standin-001').expect(200),
      );
      expect(file).toMatchObject({
        id: 'standin-001',
        title: 'The Salt Road',
        genre: ['Drama'],
        mustAgreeTerms: true,
      });
      const fileTrailer = file.trailer as { kind: string; url: string };
      expect(fileTrailer.kind).toBe('file');
      expect(fileTrailer.url).toMatch(/\.mp4$/);
      for (const k of [
        'originalTitle',
        'synopsis',
        'tagline',
        'language',
        'countryOfOrigin',
        'year',
        'runtimeMinutes',
        'ageRating',
        'posterImage',
        'backdropImage',
        'cast',
        'rating',
        'ratingCount',
        'views',
        'premiering',
        'premierDate',
        'addedAt',
      ])
        expect(file).toHaveProperty(k);
      expect(file.cast).toEqual([
        { name: 'Ada Example', character: 'Lead' },
        { name: 'Tunde Sample', character: null },
      ]);
      const yt = data<{ trailer: { kind: string; url: string } | null }>(
        await h.as(PLAIN, 'get', '/movies/standin-002').expect(200),
      );
      expect(yt.trailer?.kind).toBe('youtube');
      expect(yt.trailer?.url).toMatch(/youtube\.com/);
      const none = data<{ trailer: unknown }>(
        await h.as(PLAIN, 'get', '/movies/standin-006').expect(200),
      );
      expect(none.trailer).toBeNull();
      const premiere = data<{
        premiering: boolean;
        premierDate: string | null;
      }>(await h.as(PLAIN, 'get', '/movies/standin-009').expect(200));
      expect(premiere.premiering).toBe(true);
      expect(premiere.premierDate).not.toBeNull();
      const missing = await h
        .as(PLAIN, 'get', '/movies/not-a-title')
        .expect(404);
      expect(codeOf(missing)).toBe('movie_not_found');
    });
  });

  // ---------------------------------------------------------------------------
  describe('the sync job', () => {
    let h: Harness;
    beforeAll(async () => {
      h = await boot('standin', tokens, mock);
    });
    afterAll(async () => {
      await clean(h);
      await h.close();
    });
    beforeEach(async () => {
      await clean(h);
      standin(h).down = false;
      for (const m of standinMovies(new Date()))
        standin(h).setMovie(m, new Date(0));
      for (const id of ['standin-099', 'standin-098'])
        standin(h).removeMovie(id);
    });

    it('copies new titles, updates changed ones with updatedSince and removes titles the partner dropped', async () => {
      const spy = jest.spyOn(h.partner, 'listMovies');
      const first = await h.sync.runPass();
      expect(first).toMatchObject({
        mode: 'full',
        note: null,
        seen: 14,
        created: 14,
        updated: 0,
        removed: 0,
      });
      expect(await h.prisma.moviePartnerMovie.count()).toBe(14);
      expect(spy.mock.calls[0][0].updatedSince).toBeUndefined();

      // A new title and a changed one: only those two come back.
      const base = standinMovies(new Date())[0];
      standin(h).setMovie(
        {
          ...base,
          id: 'standin-099',
          title: 'Brand New',
          addedAt: new Date().toISOString(),
          flixoraPath: '/stream-movies/standin-099',
          flixoraUrl:
            'https://flixora-standin.invalid/stream-movies/standin-099',
        },
        new Date(),
      );
      standin(h).setMovie(
        { ...standinMovies(new Date())[2], views: 777777 },
        new Date(),
      );
      spy.mockClear();
      const second = await h.sync.runPass({ full: false });
      expect(second).toMatchObject({
        mode: 'incremental',
        note: null,
        seen: 2,
        created: 1,
        updated: 1,
        removed: 0,
      });
      expect(spy.mock.calls[0][0].updatedSince).toBeInstanceOf(Date);
      expect(await h.prisma.moviePartnerMovie.count()).toBe(15);
      expect(
        (
          await h.prisma.moviePartnerMovie.findFirstOrThrow({
            where: { partnerMovieId: 'standin-003' },
          })
        ).views,
      ).toBe(777777);
      expect(
        (
          await h.prisma.moviePartnerMovie.findFirstOrThrow({
            where: { partnerMovieId: 'standin-099' },
          })
        ).title,
      ).toBe('Brand New');

      // Nothing new: one request. The pass asks from a few minutes before the
      // last one began, so the two just-changed titles come round once more
      // (written again, unchanged); the other twelve are not asked for.
      spy.mockClear();
      const third = await h.sync.runPass({ full: false });
      expect(third).toMatchObject({
        mode: 'incremental',
        seen: 2,
        created: 0,
        updated: 2,
        removed: 0,
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(await h.prisma.moviePartnerMovie.count()).toBe(15);

      // A title the partner dropped stays until a full pass, then goes.
      standin(h).removeMovie('standin-099');
      standin(h).removeMovie('standin-004');
      expect((await h.sync.runPass({ full: false })).removed).toBe(0);
      expect(await h.prisma.moviePartnerMovie.count()).toBe(15);
      const full = await h.sync.runPass({ full: true });
      expect(full).toMatchObject({ mode: 'full', removed: 2 });
      expect(await h.prisma.moviePartnerMovie.count()).toBe(13);
      expect(
        await h.prisma.moviePartnerMovie.count({
          where: { partnerMovieId: 'standin-004' },
        }),
      ).toBe(0);
      // and the screens no longer show it
      const gone = await h.as(PLAIN, 'get', '/movies/standin-004').expect(404);
      expect(codeOf(gone)).toBe('movie_not_found');
      spy.mockRestore();
    });

    it('pages through a big catalog and keeps the copy when the partner is down or answers nothing', async () => {
      process.env.MOVIE_SYNC_PAGE_SIZE = '5';
      try {
        const spy = jest.spyOn(h.partner, 'listMovies');
        const r = await h.sync.runPass();
        expect(r).toMatchObject({ pages: 3, seen: 14, created: 14 });
        expect(spy).toHaveBeenCalledTimes(3);
        spy.mockRestore();
      } finally {
        delete process.env.MOVIE_SYNC_PAGE_SIZE;
      }
      standin(h).down = true;
      const failed = await h.sync.runPass({ full: true });
      expect(failed.note).toBe('partner_unavailable');
      expect(await h.prisma.moviePartnerMovie.count()).toBe(14);
      expect(
        (
          await h.prisma.moviePartnerSync.findUniqueOrThrow({
            where: { provider: 'standin' },
          })
        ).lastError,
      ).toBe('partner_unavailable');
      standin(h).down = false;
      // An empty answer on a full pass is not taken as "every title is gone".
      for (const m of standinMovies(new Date())) standin(h).removeMovie(m.id);
      const empty = await h.sync.runPass({ full: true });
      expect(empty.note).toBe('empty_catalog_kept');
      expect(await h.prisma.moviePartnerMovie.count()).toBe(14);
    });

    it('does not start a second pass while one holds the lease, and runs again when it is due', async () => {
      await h.prisma.moviePartnerSync.create({
        data: {
          provider: 'standin',
          claimedUntil: new Date(Date.now() + 60_000),
        },
      });
      expect(await h.sync.runPass()).toMatchObject({
        mode: 'skipped',
        note: 'busy',
      });
      await h.prisma.moviePartnerSync.update({
        where: { provider: 'standin' },
        data: { claimedUntil: null },
      });
      expect((await h.sync.runIfDue()).mode).toBe('full');
      expect(await h.sync.runIfDue()).toMatchObject({
        mode: 'skipped',
        note: 'not_due',
      });
    });
  });

  // ---------------------------------------------------------------------------
  describe('Watch on Flixora (R-75)', () => {
    let h: Harness;
    const FROM = '2026-10-20T00:00:00.000Z';
    const watch = (who: string, body: object = {}) =>
      h.as(who, 'post', '/movies/standin-001/watch', body);
    const profile = async (who: string, createdAt: Date) => {
      await h.prisma.userProfile.upsert({
        where: { wawuUserId: who },
        create: { wawuUserId: who, accountType: 'user', createdAt },
        update: { createdAt },
      });
    };
    const madeProfiles: string[] = [];

    beforeAll(async () => {
      h = await boot('standin', tokens, mock);
    });
    afterAll(async () => {
      await clean(h);
      await h.prisma.userProfile.deleteMany({
        where: { wawuUserId: { in: madeProfiles } },
      });
      await h.close();
    });
    beforeEach(async () => {
      await clean(h);
      await h.sync.runPass({ full: true });
      process.env.FLIXORA_TERMS_FROM = FROM;
      standin(h).down = false;
      if (madeProfiles.length === 0) {
        for (const who of [PLAIN, BASIC])
          if (
            !(await h.prisma.userProfile.findUnique({
              where: { wawuUserId: who },
            }))
          )
            madeProfiles.push(who);
      }
    });
    afterEach(() => {
      delete process.env.FLIXORA_TERMS_FROM;
    });

    it('gives a link straight away to someone who signed up on or after FLIXORA_TERMS_FROM, and stores that they agreed at sign-up', async () => {
      await profile(PLAIN, new Date('2026-10-21T10:00:00.000Z'));
      const detail = data<{ mustAgreeTerms: boolean }>(
        await h.as(PLAIN, 'get', '/movies/standin-001').expect(200),
      );
      expect(detail.mustAgreeTerms).toBe(false);
      const res = await watch(PLAIN).expect(200);
      const out = data<{ url: string; expiresAt: string }>(res);
      expect(out.url).toMatch(
        /^https:\/\/flixora-standin\.invalid\/partner\/wawu\/login#token=.+&redirect=%2Fstream-movies%2Fstandin-001$/,
      );
      expect(new Date(out.expiresAt).getTime()).toBeGreaterThan(Date.now());
      const consent = await h.prisma.moviePartnerConsent.findMany({
        where: { wawuUserId: PLAIN },
      });
      expect(consent).toHaveLength(1);
      expect(consent[0]).toMatchObject({ how: 'signup', provider: 'standin' });
      const link = await h.prisma.moviePartnerLink.findFirstOrThrow({
        where: { wawuUserId: PLAIN },
      });
      expect(link.linkCount).toBe(1);
    });

    it('answers 409 terms_not_agreed before the date, and while the setting is empty, until agreeToTerms: true, which stores the consent first', async () => {
      await profile(BASIC, new Date('2026-09-01T10:00:00.000Z'));
      const detail = data<{ mustAgreeTerms: boolean }>(
        await h.as(BASIC, 'get', '/movies/standin-001').expect(200),
      );
      expect(detail.mustAgreeTerms).toBe(true);
      const spy = jest.spyOn(h.partner, 'signedInLink');
      const refused = await watch(BASIC).expect(409);
      expect(codeOf(refused)).toBe('terms_not_agreed');
      expect((await watch(BASIC, { agreeToTerms: false })).status).toBe(409);
      expect(spy).not.toHaveBeenCalled();
      expect(
        await h.prisma.moviePartnerConsent.count({
          where: { wawuUserId: BASIC },
        }),
      ).toBe(0);
      expect(
        await h.prisma.moviePartnerLink.count({ where: { wawuUserId: BASIC } }),
      ).toBe(0);

      const ok = await watch(BASIC, { agreeToTerms: true }).expect(200);
      expect(data<{ url: string }>(ok).url).toContain('login#token=');
      const rows = await h.prisma.moviePartnerConsent.findMany({
        where: { wawuUserId: BASIC },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].how).toBe('mv4');
      // A repeated consent stores one row, and later taps need no tick.
      await watch(BASIC, { agreeToTerms: true }).expect(200);
      await watch(BASIC).expect(200);
      expect(
        await h.prisma.moviePartnerConsent.count({
          where: { wawuUserId: BASIC },
        }),
      ).toBe(1);
      expect(
        (
          await h.prisma.moviePartnerConsent.findFirstOrThrow({
            where: { wawuUserId: BASIC },
          })
        ).agreedAt,
      ).toEqual(rows[0].agreedAt);
      const after = data<{ mustAgreeTerms: boolean }>(
        await h.as(BASIC, 'get', '/movies/standin-001').expect(200),
      );
      expect(after.mustAgreeTerms).toBe(false);
      spy.mockRestore();

      // With the setting empty nobody counts as agreed by sign-up.
      await profile(PLAIN, new Date('2026-12-01T00:00:00.000Z'));
      process.env.FLIXORA_TERMS_FROM = '';
      expect(codeOf(await watch(PLAIN).expect(409))).toBe('terms_not_agreed');
      process.env.FLIXORA_TERMS_FROM = 'not a date';
      expect(codeOf(await watch(PLAIN).expect(409))).toBe('terms_not_agreed');
    });

    it('gives a person with no profile row no sign-up time, so they must agree', async () => {
      await h.prisma.userProfile.deleteMany({ where: { wawuUserId: PLAIN } });
      expect(codeOf(await watch(PLAIN).expect(409))).toBe('terms_not_agreed');
      await watch(PLAIN, { agreeToTerms: true }).expect(200);
    });

    it('makes a fresh link for each tap, counts them, and never stores or logs a link', async () => {
      await profile(PLAIN, new Date('2026-10-21T10:00:00.000Z'));
      const seen: string[] = [];
      const logs: string[] = [];
      const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map(
        (m) =>
          jest
            .spyOn(Logger.prototype, m)
            .mockImplementation((...args: unknown[]) => {
              logs.push(args.map((a) => String(a)).join(' '));
            }),
      );
      for (let i = 0; i < 3; i++)
        seen.push(data<{ url: string }>(await watch(PLAIN).expect(200)).url);
      expect(new Set(seen).size).toBe(3);
      const tokensSeen = seen.map((u) => u.split('#token=')[1].split('&')[0]);
      expect(new Set(tokensSeen).size).toBe(3);
      const link = await h.prisma.moviePartnerLink.findFirstOrThrow({
        where: { wawuUserId: PLAIN },
      });
      expect(link.linkCount).toBe(3);
      expect(link.lastLinkAt.getTime()).toBeGreaterThanOrEqual(
        link.firstLinkAt.getTime(),
      );
      // Not in any stored row, not in anything logged.
      const stored = JSON.stringify([
        await h.prisma.moviePartnerLink.findMany(),
        await h.prisma.moviePartnerConsent.findMany(),
        await h.prisma.moviePartnerMovie.findMany(),
        await h.prisma.moviePartnerSync.findMany(),
      ]);
      for (const t of tokensSeen) {
        expect(stored).not.toContain(t);
        expect(logs.join('\n')).not.toContain(t);
      }
      spies.forEach((s) => s.mockRestore());
    });

    it('answers 503 movies_unavailable when the partner cannot make a link, and counts nothing', async () => {
      await profile(PLAIN, new Date('2026-10-21T10:00:00.000Z'));
      standin(h).down = true;
      const res = await watch(PLAIN).expect(503);
      expect(codeOf(res)).toBe('movies_unavailable');
      expect((res.body as { message: string }).message).not.toMatch(/—/);
      expect(
        await h.prisma.moviePartnerLink.count({ where: { wawuUserId: PLAIN } }),
      ).toBe(0);
    });

    it('answers 404 movie_not_found for a title the copy does not hold, before any call to the partner', async () => {
      const spy = jest.spyOn(h.partner, 'signedInLink');
      const res = await h
        .as(PLAIN, 'post', '/movies/nope/watch', { agreeToTerms: true })
        .expect(404);
      expect(codeOf(res)).toBe('movie_not_found');
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('gives the seam only the allowed fields: id, email, first and last name, and whether the email is verified', async () => {
      await profile(PLAIN, new Date('2026-10-21T10:00:00.000Z'));
      await profile(BASIC, new Date('2026-10-21T10:00:00.000Z'));
      const spy = jest.spyOn(h.partner, 'signedInLink');
      await watch(PLAIN).expect(200);
      await watch(BASIC).expect(200);
      const [plainArgs, basicArgs] = spy.mock.calls;
      expect(plainArgs[0]).toEqual({
        sub: PLAIN,
        email: 'user@test.wawu.dev',
        firstName: 'Adaeze',
        lastName: 'Okonkwo',
        emailVerified: true,
      });
      // This person's token carries no emailVerified flag, so it is not claimed.
      expect(basicArgs[0].emailVerified).toBe(false);
      for (const [person, target] of spy.mock.calls) {
        expect(Object.keys(person).sort()).toEqual([
          'email',
          'emailVerified',
          'firstName',
          'lastName',
          'sub',
        ]);
        expect(Object.keys(target).sort()).toEqual(['id', 'path']);
        const sent = JSON.stringify([person, target]);
        // no phone, country, tier, trust score or any wallet or identity number
        for (const secret of [
          '+2348000000001',
          '2348000000001',
          '+2348000000002',
          'Nigeria',
          'verified_user',
          'trustScore',
          'bvn',
          'nin',
          'wallet',
        ])
          expect(sent.toLowerCase()).not.toContain(secret.toLowerCase());
      }
      spy.mockRestore();
    });

    it('puts the person agreement and link times in their data export, and no link', async () => {
      await profile(PLAIN, new Date('2026-10-21T10:00:00.000Z'));
      await watch(PLAIN).expect(200);
      const section = EXPORT_SECTIONS.find((s) => s.key === 'moviePartner')!;
      const out = (await section.load(h.prisma, PLAIN)) as {
        consents: { how: string }[];
        links: { linkCount: number }[];
      };
      expect(out.consents.map((c) => c.how)).toEqual(['signup']);
      expect(out.links.map((l) => l.linkCount)).toEqual([1]);
      expect(JSON.stringify(out)).not.toContain('token=');
      const other = (await section.load(h.prisma, BASIC)) as {
        consents: unknown[];
        links: unknown[];
      };
      expect(other).toEqual({ consents: [], links: [] });
    });

    it('gives no link once the person is deleting their account, and the purge hook marks their link row', async () => {
      await profile(PLAIN, new Date('2026-10-21T10:00:00.000Z'));
      await watch(PLAIN).expect(200);
      // Deletion asked for: no more links, from that moment.
      await h.prisma.accountDeletion.create({
        data: {
          wawuUserId: PLAIN,
          status: 'scheduled',
          purgeAfter: new Date(Date.now() + 30 * 86_400_000),
        },
      });
      const spy = jest.spyOn(h.partner, 'signedInLink');
      const closing = await watch(PLAIN).expect(409);
      expect(codeOf(closing)).toBe('account_closing');
      expect(spy).not.toHaveBeenCalled();
      // Cancelled: links work again.
      await h.prisma.accountDeletion.update({
        where: { wawuUserId: PLAIN },
        data: { status: 'cancelled' },
      });
      await watch(PLAIN).expect(200);
      // The purge: the before-erase hook marks the row, and no link is given even with no deletion row left.
      await h.hooks.beforeErase(PLAIN);
      await h.hooks.beforeErase(PLAIN);
      const marked = await h.prisma.moviePartnerLink.findFirstOrThrow({
        where: { wawuUserId: PLAIN },
      });
      expect(marked.accountDeletedAt).not.toBeNull();
      expect(marked.linkCount).toBe(2);
      await h.prisma.accountDeletion.deleteMany({
        where: { wawuUserId: PLAIN },
      });
      spy.mockClear();
      expect(codeOf(await watch(PLAIN).expect(409))).toBe('account_closing');
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });
});
