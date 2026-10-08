import { ChildProcess, spawn } from 'child_process';
import type { Server } from 'http';
import * as path from 'path';
import {
  BadRequestException,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ConfigModule } from '@nestjs/config';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { SearchResponseModule } from '../search-response.module';
import { SearchResponseController } from '../search-response.controller';
import { SearchResponseService } from '../search-response.service';
import type { SearchTab } from '../dto/search-query.dto';
import { isSearchableQuery } from '../searchable-query';

/**
 * FIX-07. `GET /search?q=%00` answered 500 on the tabs that run a query
 * (Postgres refuses a NUL in text). A term Postgres cannot take is now a 400
 * naming `q` on every tab and on `/search/closest`, before any query runs,
 * and every other answer is what it was.
 */

// Word for word what the `schools` tab answers (SCHOOLS-04), so all tabs agree.
const REFUSAL_TEXT =
  'q must have text in it, with no null characters or broken characters';
const REFUSAL_BODY = JSON.stringify({
  statusCode: 400,
  message: REFUSAL_TEXT,
  data: null,
});

const TABS: (SearchTab | undefined)[] = [
  undefined,
  'all',
  'content',
  'creators',
  'communities',
];

const MOCK_WAWU_ID_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_WAWU_ID_BASE = `http://localhost:${MOCK_WAWU_ID_PORT}`;

async function waitForHealth(url: string, timeoutMs = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function login(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_WAWU_ID_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok)
    throw new Error(
      `mock-wawu-id login failed for ${identifier}: ${res.status}`,
    );
  const body = (await res.json()) as { accessToken: string };
  return body.accessToken;
}

describe('Search: a q Postgres cannot take is a 400 naming q (FIX-07)', () => {
  let app: INestApplication;
  let mockWawuId: ChildProcess | undefined;
  let buyerToken: string;

  beforeAll(async () => {
    if (!(await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`, 1000))) {
      mockWawuId = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '../../../mock-wawu-id'),
        env: { ...process.env, MOCK_WAWU_ID_PORT },
        stdio: 'ignore',
      });
      if (!(await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`)))
        throw new Error('mock-wawu-id did not become healthy in time');
    }
    buyerToken = await login('user@test.wawu.dev');

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        SearchResponseModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    // The same global pipe, filter and interceptor as src/main.ts, so a
    // body here is byte for byte what the Hub sends.
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
  }, 30000);

  afterAll(async () => {
    await app?.close();
    mockWawuId?.kill();
  });

  afterEach(() => jest.restoreAllMocks());

  /** A raw path, so the percent escapes reach the server exactly as written. */
  const get = (p: string, token: string | null = null) => {
    const req = request(app.getHttpServer() as Server).get(p);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };
  const withTab = (base: string, tab: SearchTab | undefined) =>
    tab ? `${base}&tab=${tab}` : base;
  const messageOf = (res: { body: unknown }): unknown =>
    (res.body as { message?: unknown }).message;

  describe('a NUL in q, over HTTP', () => {
    const NUL_TERMS = ['%00', 'a%00b', '%00%20', 'makeup%00', '%20%00%20'];

    it.each(TABS.map((t) => [t ?? '(none)', t] as const))(
      'GET /search tab=%s answers 400 naming q, anonymous and signed in',
      async (_label, tab) => {
        for (const term of NUL_TERMS) {
          for (const token of [null, buyerToken]) {
            const p = withTab(`/search?q=${term}`, tab);
            const res = await get(p, token);
            expect([p, res.status, res.text]).toEqual([p, 400, REFUSAL_BODY]);
          }
        }
      },
    );

    it('GET /search/closest answers the same 400', async () => {
      for (const term of ['%00', 'a%00b', 'a%20%00', '%00%20makeup']) {
        for (const token of [null, buyerToken]) {
          const p = `/search/closest?q=${term}`;
          const res = await get(p, token);
          expect([p, res.status, res.text]).toEqual([p, 400, REFUSAL_BODY]);
        }
      }
    });

    it('is refused before the search runs (the service is never called)', async () => {
      const service = app.get(SearchResponseService);
      const search = jest.spyOn(service, 'search');
      const closest = jest.spyOn(service, 'closest');
      for (const tab of TABS)
        await get(withTab('/search?q=a%00b', tab)).expect(400);
      await get('/search/closest?q=a%00b').expect(400);
      expect(search).not.toHaveBeenCalled();
      expect(closest).not.toHaveBeenCalled();
      // And a clean term still reaches it, so the spy is really listening.
      await get('/search?q=makeup').expect(200);
      expect(search).toHaveBeenCalledTimes(1);
    });
  });

  describe('a lone surrogate in q', () => {
    // A query string cannot carry one: the parser turns %ED%A0%80 into
    // U+FFFD (below). So the handlers are called as Nest calls them, with
    // the value the ValidationPipe passed.
    const LONE = ['\uD800', 'a\uD800b', '\uDC00', 'x\uDBFF', '\uDC00\uD800'];

    it('GET /search refuses it with the same 400 on every tab, before the service runs', () => {
      const controller = app.get(SearchResponseController);
      const search = jest.spyOn(app.get(SearchResponseService), 'search');
      for (const q of LONE) {
        for (const tab of TABS) {
          let thrown: unknown;
          try {
            void controller.search({ q, tab }, undefined);
          } catch (e) {
            thrown = e;
          }
          expect(thrown).toBeInstanceOf(BadRequestException);
          expect((thrown as BadRequestException).getStatus()).toBe(400);
          expect((thrown as BadRequestException).message).toBe(REFUSAL_TEXT);
        }
      }
      expect(search).not.toHaveBeenCalled();
    });

    it('GET /search/closest refuses it too', () => {
      const controller = app.get(SearchResponseController);
      const closest = jest.spyOn(app.get(SearchResponseService), 'closest');
      for (const q of LONE) {
        expect(() => controller.closest({ q }, undefined)).toThrow(
          new BadRequestException(REFUSAL_TEXT),
        );
      }
      expect(closest).not.toHaveBeenCalled();
    });

    it('a whole surrogate pair is not refused', async () => {
      const controller = app.get(SearchResponseController);
      const search = jest.spyOn(app.get(SearchResponseService), 'search');
      await controller.search({ q: 'Emoji \uD83D\uDE00' }, undefined);
      expect(search).toHaveBeenCalledWith(
        'Emoji \uD83D\uDE00',
        'all',
        undefined,
      );
    });

    it('a percent-encoded surrogate arrives as U+FFFD and is searched for, as before', async () => {
      const search = jest.spyOn(app.get(SearchResponseService), 'search');
      await get('/search?q=a%ED%A0%80').expect(200);
      expect(search).toHaveBeenCalledWith(
        'a\uFFFD\uFFFD\uFFFD',
        'all',
        undefined,
      );
    });
  });

  describe('every other answer is unchanged', () => {
    it('terms with no NUL are searched, 200, on every tab and on closest', async () => {
      const terms = [
        '%20', // blank: a search on main, not a refusal
        '%20%20%20',
        '%09',
        '%C2%A0',
        '%EF%BB%BF',
        '%01',
        '%1F',
        '%7F',
        '%5C',
        '%25',
        '_',
        '%EF%BF%BD',
        '%EF%BF%BE',
        '%EF%BF%BF',
        '%F0%9F%98%80',
        '%ED%A0%80',
        '%FF%FE',
        'makeup',
      ];
      for (const term of terms) {
        for (const tab of TABS) {
          const p = withTab(`/search?q=${term}`, tab);
          const res = await get(p);
          expect([p, res.status]).toEqual([p, 200]);
        }
        const c = `/search/closest?q=${term}`;
        const res = await get(c);
        expect([c, res.status]).toEqual([c, 200]);
      }
    });

    it('a NUL with another fault keeps the 400 it already had', async () => {
      const tooLong = await get(`/search?q=${'%00'.repeat(101)}`).expect(400);
      expect(messageOf(tooLong)).toBe(
        'q must be shorter than or equal to 100 characters',
      );
      const badTab = await get('/search?q=%00&tab=events').expect(400);
      expect(messageOf(badTab)).toMatch(/^tab must be one of/);
      for (const p of [
        '/search?q=%00&q=a',
        '/search?q=a&q=%00',
        '/search?q=%00&unknown=1',
        '/search/closest?q=%00&tab=all',
      ]) {
        const res = await get(p);
        expect([p, res.status]).toEqual([p, 400]);
        expect([p, messageOf(res)]).not.toEqual([p, REFUSAL_TEXT]);
      }
      const missing = await get('/search').expect(400);
      expect(messageOf(missing)).not.toBe(REFUSAL_TEXT);
    });

    it('GET /search/suggestions takes no q, so a NUL sent there is still ignored (200)', async () => {
      const res = await get('/search/suggestions?q=%00').expect(200);
      const data = (res.body as { data: Record<string, unknown> }).data;
      expect(Object.keys(data).sort()).toEqual([
        'popularSearches',
        'recentSearches',
        'suggestedCreators',
      ]);
    });
  });

  describe('isSearchableQuery', () => {
    it.each([
      ['\u0000'],
      ['a\u0000'],
      [' \u0000 '],
      ['\u0000\u0000'],
      ['\uD800'],
      ['\uDBFF'],
      ['\uDC00'],
      ['\uDFFF'],
      ['a\uDC00b'],
      ['\uDC00\uD800'],
      ['\uD83D\uD83D'],
    ])('refuses %j', (q) => {
      expect(isSearchableQuery(q)).toBe(false);
    });

    it.each([
      [''],
      [' '],
      ['\t\n\r'],
      ['\u00A0\uFEFF\u2028'],
      ['makeup'],
      ['\uD83D\uDE00'],
      ['\uFFFD'],
      ['\uFFFE'],
      ['\uFFFF'],
      ['\u0001'],
      ['\u001F'],
      ['\u007F'],
      ['\\'],
      ['%_'],
      ['\u0130stanbul stra\u00DFe'],
      ['x'.repeat(100)],
    ])('accepts %j', (q) => {
      expect(isSearchableQuery(q)).toBe(true);
    });
  });
});
