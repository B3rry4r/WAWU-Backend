/**
 * FLIX-04 (R-77): with `MOVIE_PARTNER=soon`, GET /movies answers
 * `{ enabled: false, soon: true, hero: null, rails: [] }`, every other movies
 * route answers 404 `movies_off`, and nothing is called, synced or linked.
 * `off` keeps hiding everything and carries no `soon`.
 */
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
import {
  MOVIE_PARTNER,
  type MoviePartner,
} from '../../movie-partner/movie-partner.interface';
import { OffMoviePartner } from '../../movie-partner/off-movie-partner';
import { SoonMoviePartner } from '../../movie-partner/soon-movie-partner';
import { StandinMoviePartner } from '../../movie-partner/standin/standin-movie-partner';
import { MovieSyncService } from '../movie-sync.service';
import { MoviesController } from '../movies.controller';
import { MoviesService } from '../movies.service';
import { MoviesPurgeService } from '../movies-purge.service';

jest.setTimeout(120_000);

const PLAIN = '00000000-0000-4000-8000-000000000001';
const MOCK_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_BASE = `http://localhost:${MOCK_PORT}`;
const OTHER_ROUTES = [
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

async function boot(name: string) {
  process.env.MOVIE_PARTNER = name;
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
  const app: INestApplication = moduleRef.createNestApplication();
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
  return {
    app,
    http: () => request(app.getHttpServer() as Server),
    prisma: moduleRef.get(PrismaService),
    partner: moduleRef.get<MoviePartner>(MOVIE_PARTNER),
    sync: moduleRef.get(MovieSyncService),
  };
}

const data = <T>(res: { body: unknown }): T => (res.body as { data: T }).data;
const codeOf = (res: { body: unknown }): string =>
  (res.body as { reason: { code: string } }).reason.code;

describe('FLIX-04: MOVIE_PARTNER=soon (contract)', () => {
  let mock: ChildProcess | undefined;
  let token: string;

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
    const res = await fetch(`${MOCK_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: 'user@test.wawu.dev' }),
    });
    token = ((await res.json()) as { accessToken: string }).accessToken;
  });
  afterAll(() => {
    mock?.kill();
  });

  it('answers soon on GET /movies, 404 movies_off everywhere else, and makes no adapter call', async () => {
    const spies = [
      ...(['listMovies', 'getMovie', 'signedInLink'] as const).flatMap((m) => [
        jest.spyOn(SoonMoviePartner.prototype, m),
        jest.spyOn(OffMoviePartner.prototype, m),
        jest.spyOn(StandinMoviePartner.prototype, m),
      ]),
    ];
    const h = await boot('soon');
    try {
      expect(h.partner.name).toBe('soon');
      expect(h.partner.enabled).toBe(false);
      const auth = { Authorization: `Bearer ${token}` };
      const home = await h.http().get('/movies').set(auth).expect(200);
      expect(data(home)).toEqual({
        enabled: false,
        soon: true,
        hero: null,
        rails: [],
      });
      for (const url of OTHER_ROUTES) {
        const res = await h.http().get(url).set(auth).expect(404);
        expect(codeOf(res)).toBe('movies_off');
      }
      const watch = await h
        .http()
        .post('/movies/standin-001/watch')
        .set(auth)
        .send({ agreeToTerms: true })
        .expect(404);
      expect(codeOf(watch)).toBe('movies_off');
      // Signed in is still needed on every route.
      expect((await h.http().get('/movies')).status).toBe(401);
      // The sync job does nothing, and no link or consent is stored.
      expect(await h.sync.runPass({ full: true })).toMatchObject({
        mode: 'skipped',
        note: 'off',
      });
      expect(
        await h.prisma.moviePartnerLink.count({ where: { wawuUserId: PLAIN } }),
      ).toBe(0);
      expect(
        await h.prisma.moviePartnerConsent.count({
          where: { wawuUserId: PLAIN },
        }),
      ).toBe(0);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      await h.app.close();
      spies.forEach((s) => s.mockRestore());
    }
  });

  it('leaves off hiding everything with no soon field, and a working partner with soon false or absent', async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const off = await boot('off');
    try {
      const home = data<Record<string, unknown>>(
        await off.http().get('/movies').set(auth).expect(200),
      );
      expect(home).toEqual({ enabled: false, hero: null, rails: [] });
      expect(home).not.toHaveProperty('soon');
    } finally {
      await off.app.close();
    }
    const on = await boot('standin');
    try {
      const home = data<{ enabled: boolean; soon?: boolean }>(
        await on.http().get('/movies').set(auth).expect(200),
      );
      expect(home.enabled).toBe(true);
      expect(home.soon).toBeFalsy();
    } finally {
      await on.app.close();
    }
  });
});
