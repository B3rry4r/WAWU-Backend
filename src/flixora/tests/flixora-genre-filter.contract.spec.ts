// Run against a migrated test database (set DATABASE_URL), like every contract spec.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';
process.env.MOVIE_PARTNER = 'standin';

import { ChildProcess, spawn } from 'node:child_process';
import type { Server } from 'node:http';
import * as path from 'node:path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AccountPurgeHooks } from '../../account-purge/purge-hooks';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { MoviePartnerModule } from '../../movie-partner/movie-partner.module';
import { MOVIE_PARTNER } from '../../movie-partner/movie-partner.interface';
import { MovieSyncService } from '../../movies/movie-sync.service';
import { MoviesController } from '../../movies/movies.controller';
import { MoviesService } from '../../movies/movies.service';
import { MoviesPurgeService } from '../../movies/movies-purge.service';
import { FlixoraMoviePartner } from '../flixora-movie-partner';
import type { FetchLike } from '../flixora-client';
import type { FlixoraSettings } from '../flixora-settings';

/**
 * FIX-99 (FLIX-02 L1): a title Flixora serves as "Drama | Music | Thriller"
 * is found by the Hub's genre filter under "Music". The Flixora adapter reads
 * the title (a made-up one, with a genre value Flixora's TEST catalog really
 * served), the sync stores it, and GET /movies/browse?genre=Music lists it.
 * On main the stored genre was the one string with pipes, and the filter,
 * which matches one whole entry, missed it.
 */
jest.setTimeout(120_000);

const MOCK_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_BASE = `http://localhost:${MOCK_PORT}`;
const TITLE_ID = 'fix99-genre-title';

const settings: FlixoraSettings = {
  apiBaseUrl: 'https://api.flixora.invalid/api/partners',
  apiKey: 'flx_test_0123456789abcdefSPECONLY',
  ssoSecret: 'spec-only-sign-in-secret-0123456789',
  partnerSlug: 'spec-partner',
  siteUrl: 'https://www.flixora.com',
  region: 'NG',
};

const title = {
  id: TITLE_ID,
  title: 'A Made Up Film About Music',
  originalTitle: null,
  synopsis: 'Nothing real.',
  tagline: null,
  genre: ['Drama | Music | Thriller'],
  language: 'English',
  countryOfOrigin: 'Nigeria',
  year: 2026,
  runtimeMinutes: 95,
  ageRating: 'PG-13',
  posterImage: 'https://img.flixora.invalid/p.png',
  backdropImage: null,
  trailerUrl: null,
  cast: [],
  rating: 4.5,
  ratingCount: 2,
  views: 10,
  premiering: false,
  premierDate: null,
  addedAt: '2026-10-19T12:18:34.524Z',
  flixoraPath: `/stream-movies/${TITLE_ID}`,
  flixoraUrl: `https://www.flixora.com/stream-movies/${TITLE_ID}`,
};

/** Answers every catalog call with the one title, as one last page. */
const fetchOne: FetchLike = () =>
  Promise.resolve({
    status: 200,
    headers: { get: () => null },
    text: () =>
      Promise.resolve(
        JSON.stringify({
          data: [title],
          pagination: {
            total: 1,
            page: 1,
            limit: 50,
            totalPages: 1,
            hasNextPage: false,
          },
        }),
      ),
  });

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

describe('FIX-99: the genre filter finds a title served with pipes in its genre', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mock: ChildProcess | undefined;
  let token: string;
  const get = (url: string) =>
    request(app.getHttpServer() as Server)
      .get(url)
      .set('Authorization', `Bearer ${token}`);

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
    const login = await fetch(`${MOCK_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: 'user@test.wawu.dev' }),
    });
    token = ((await login.json()) as { accessToken: string }).accessToken;

    const partner = new FlixoraMoviePartner(settings, { fetch: fetchOne });
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
    })
      .overrideProvider(MOVIE_PARTNER)
      .useValue(partner)
      .compile();
    app = moduleRef.createNestApplication();
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
    prisma = moduleRef.get(PrismaService);
    await prisma.moviePartnerMovie.deleteMany({});
    await prisma.moviePartnerSync.deleteMany({});
    await moduleRef.get(MovieSyncService).runPass({ full: true });
  });

  afterAll(async () => {
    await prisma?.moviePartnerMovie.deleteMany({});
    await prisma?.moviePartnerSync.deleteMany({});
    await app?.close();
    mock?.kill();
  });

  it('stores the title with single-word genres', async () => {
    const row = await prisma.moviePartnerMovie.findFirst({
      where: { provider: 'flixora', partnerMovieId: TITLE_ID },
    });
    expect(row?.genre).toEqual(['Drama', 'Music', 'Thriller']);
  });

  it.each(['Music', 'Drama', 'Thriller'])(
    'GET /movies/browse?genre=%s lists the title',
    async (genre) => {
      const res = await get(`/movies/browse?genre=${genre}`).expect(200);
      const rows = (res.body as { data: Array<{ title: string }> }).data;
      expect(rows.map((r) => r.title)).toContain('A Made Up Film About Music');
    },
  );

  it('GET /movies/filters lists single genres, none with a pipe', async () => {
    const res = await get('/movies/filters').expect(200);
    const genres = (res.body as { data: { genres: string[] } }).data.genres;
    expect(genres).toEqual(['Drama', 'Music', 'Thriller']);
  });
});
