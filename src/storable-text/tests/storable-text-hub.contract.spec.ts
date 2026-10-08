import {
  INestApplication,
  RequestMethod,
  Type,
  ValidationPipe,
} from '@nestjs/common';
import {
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { MetadataScanner, ModulesContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { getMetadataStorage } from 'class-validator';
import type { Server } from 'node:http';
import request from 'supertest';
import { AppModule } from '../../app.module';
import { applyHubHttpSettings } from '../../hub-app-options';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  adminFixtures,
  adminJwtSecrets,
  deleteAdminFixtures,
  loginAdmin,
  seedAdminFixtures,
} from '../../common/tests/admin-session.helper';
import {
  startTestJwksServer,
  type TestJwksServer,
} from '../../evg-score/tests/test-jwks-server';
import {
  checkStorableTextOnEveryRoute,
  STORABLE_TEXT_PIPE,
} from '../storable-text.pipe';

/**
 * FIX-17, on the Hub itself: the FULL AppModule, composed as src/main.ts
 * composes it (prefix, ValidationPipe, the storable-text check, filter,
 * interceptor). Only the rate limit is lifted and WAWU ID's key set is a
 * local stand-in, so a signed-in caller is a real RS256 token.
 *
 * Every request here either carries a value this task refuses, so it never
 * reaches a handler, or reaches one that only reads the database (the shop
 * order queue, the subcategories, closest): nothing here calls WAWU ID,
 * Fintava or any other provider. What every clean value answers is proved
 * against main by the recorded sweep in the task file, not here.
 */

const ADMINS = adminFixtures('f17a0d1e', 'f17-storable-text');
const SUPERADMIN = ADMINS.find((a) => a.role === 'superadmin')!;
const BUYER = '00000000-0000-4000-8000-000000000001'; // prisma/seed.ts
const CREATOR = '00000000-0000-4000-8000-000000000003'; // prisma/seed.ts

const refusal = (field: string) => ({
  statusCode: 400,
  message: `${field} must have text in it, with no null characters or broken characters`,
  data: null,
});

const METHODS: Record<number, string> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.DELETE]: 'DELETE',
  [RequestMethod.PATCH]: 'PATCH',
};

interface MountedRoute {
  method: string;
  path: string;
  queryKeys: string[];
  args: { type: number; pipes: unknown[] }[];
}

/** Every route the composed app mounts, read from the metadata the router reads. */
function mountedRoutes(app: INestApplication): MountedRoute[] {
  const scanner = new MetadataScanner();
  const seen = new Set<Type<unknown>>();
  const storage = getMetadataStorage();
  const out: MountedRoute[] = [];
  for (const mod of app.get(ModulesContainer).values()) {
    for (const wrapper of mod.controllers.values()) {
      const cls = wrapper.metatype as Type<unknown> | null;
      if (!cls || seen.has(cls)) continue;
      seen.add(cls);
      const bases = [
        Reflect.getMetadata(PATH_METADATA, cls) as string | string[],
      ].flat();
      for (const name of scanner.getAllMethodNames(cls.prototype as object)) {
        const fn = (cls.prototype as Record<string, unknown>)[name] as object;
        const sub = Reflect.getMetadata(PATH_METADATA, fn) as
          string | string[] | undefined;
        if (sub === undefined) continue;
        const method =
          METHODS[Reflect.getMetadata(METHOD_METADATA, fn) as number];
        const raw = (Reflect.getMetadata(ROUTE_ARGS_METADATA, cls, name) ??
          {}) as Record<
          string,
          { index: number; data?: string; pipes: unknown[] }
        >;
        const types = (Reflect.getMetadata(
          'design:paramtypes',
          cls.prototype as object,
          name,
        ) ?? []) as (Type<unknown> | undefined)[];
        const args = Object.entries(raw).map(([key, a]) => ({
          type: Number(key.split(':')[0]),
          data: a.data,
          pipes: a.pipes,
          metatype: types[a.index],
        }));
        const queryKeys = args.flatMap((a) => {
          if (a.type !== 4) return [];
          if (a.data) return [a.data];
          if (
            !a.metatype ||
            [String, Number, Boolean, Object].includes(a.metatype as never)
          )
            return [];
          return storage
            .getTargetValidationMetadatas(a.metatype, '', true, false)
            .map((m) => m.propertyName);
        });
        for (const b of bases)
          for (const s of [sub].flat()) {
            const joined =
              `/${[b, s].filter((p) => p && p !== '/').join('/')}`.replace(
                /\/+/g,
                '/',
              );
            out.push({
              method,
              path: joined.length > 1 ? joined.replace(/\/$/, '') : joined,
              queryKeys: [...new Set(queryKeys)],
              args,
            });
          }
      }
    }
  }
  return out;
}

describe('Text Postgres cannot take, on every Hub route (FIX-17)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwks: TestJwksServer;
  let buyer: string;
  let creator: string;
  let admin: string;
  let routes: MountedRoute[];
  const previousEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    jwks = await startTestJwksServer();
    const secrets = adminJwtSecrets('fix-17-storable-text');
    const env: Record<string, string> = {
      WAWU_ID_JWKS_URL: jwks.jwksUrl,
      ADMIN_JWT_SECRET: secrets.access,
      ADMIN_JWT_REFRESH_SECRET: secrets.refresh,
    };
    for (const [k, v] of Object.entries(env)) {
      previousEnv[k] = process.env[k];
      process.env[k] = v;
    }
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication();
    // trust proxy as on the Hub, so each request below is its own caller
    // (X-Forwarded-For) and no limit is reached.
    applyHubHttpSettings(app);
    app.setGlobalPrefix('api/hub');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    checkStorableTextOnEveryRoute(app);
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();
    routes = mountedRoutes(app);

    prisma = app.get(PrismaService);
    await seedAdminFixtures(prisma, ADMINS);
    admin = await loginAdmin(app, SUPERADMIN.email);
    const claims = (sub: string, email: string) => ({
      sub,
      email,
      phone: '+2348000000001',
      firstName: 'Fix',
      lastName: 'Seventeen',
      country: 'Nigeria',
      verificationTier: 'verified_user',
      trustScore: 40,
      status: 'active',
    });
    buyer = jwks.signToken(claims(BUYER, 'user@test.wawu.dev'));
    creator = jwks.signToken(claims(CREATOR, 'creator-pro@test.wawu.dev'));
  }, 120_000);

  afterAll(async () => {
    await deleteAdminFixtures(prisma, ADMINS);
    await app.close();
    await jwks.close();
    for (const [k, v] of Object.entries(previousEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  let n = 0;
  const get = (path: string, token?: string) => {
    n++;
    const r = request(app.getHttpServer() as Server)
      .get(`/api/hub${path}`)
      .set('X-Forwarded-For', `10.17.${(n >> 8) & 255}.${n & 255}`);
    return token ? r.set('Authorization', `Bearer ${token}`) : r;
  };

  it('puts the check last, once, on every argument of every route the Hub mounts', () => {
    expect(routes.filter((r) => r.method === 'GET').length).toBeGreaterThan(
      200,
    );
    let queryAndPath = 0;
    for (const r of routes) {
      for (const a of r.args) {
        const mine = a.pipes.filter((p) => p === STORABLE_TEXT_PIPE).length;
        expect([`${r.method} ${r.path}`, mine]).toEqual([
          `${r.method} ${r.path}`,
          1,
        ]);
        expect(a.pipes[a.pipes.length - 1]).toBe(STORABLE_TEXT_PIPE);
        if (a.type === 4 || a.type === 5) queryAndPath++;
      }
    }
    expect(queryAndPath).toBeGreaterThan(300);
  });

  // The routes FIX-07's verifier saw answer 500 for a NUL (Postgres 22021).
  const NAMED: [string, 'anon' | 'buyer' | 'admin', string][] = [
    ['/shop/products?search=%00', 'anon', 'search'],
    ['/shop/products?subcategory=a%00b', 'anon', 'subcategory'],
    ['/shop/%00', 'anon', 'slug'],
    ['/creators?category=%00', 'anon', 'category'],
    ['/learn/guides?country=a%00b', 'anon', 'country'],
    ['/users/public/%00', 'anon', 'wawuId'],
    ['/content/public/creator/a%00b/content', 'anon', 'wawuId'],
    ['/search?q=%00', 'anon', 'q'],
    ['/search/closest?q=a%00b', 'anon', 'q'],
    ['/events?host=%00', 'buyer', 'host'],
    ['/me/purchases?q=a%00b', 'buyer', 'q'],
    ['/content?category=%00', 'buyer', 'category'],
    ['/feed?category=%00', 'buyer', 'category'],
    ['/feed/entries?category=a%00b', 'buyer', 'category'],
    ['/services?category=%00', 'buyer', 'category'],
    ['/services/mentors?category=%00', 'buyer', 'category'],
    ['/users/%00/public-profile', 'buyer', 'wawuId'],
    ['/users/%00/profile-fields', 'buyer', 'wawuId'],
    ['/users/a%00b/content', 'buyer', 'wawuId'],
    ['/legal/requests/%00', 'buyer', 'id'],
    ['/legal/requests/%00/contract', 'buyer', 'id'],
    ['/admin/creators?q=%00', 'admin', 'q'],
    ['/admin/finance/wallets?q=%00', 'admin', 'q'],
    ['/admin/finance/wallets/%00', 'admin', 'wawuId'],
    ['/admin/shop/products?search=a%00b', 'admin', 'search'],
    ['/admin/payments/receipts?txRef=%00', 'admin', 'txRef'],
    ['/admin/payments/receipts?flow=%00', 'admin', 'flow'],
    ['/admin/shop/orders?page=%00', 'admin', 'page'],
  ];

  it.each(NAMED)(
    'GET %s as %s answers 400 naming %s',
    async (path, who, field) => {
      const token = { anon: undefined, buyer, admin }[who];
      const res = await get(path, token).expect(400);
      expect(res.body).toEqual(refusal(field));
    },
  );

  /**
   * Declared values the ValidationPipe turns into something that is not text
   * before any query (a NUL there never reaches Postgres): they answer as the
   * same request did before this task.
   */
  const NOT_TEXT = new Set(['GET /shop/products wawuPick']);

  it('a NUL in any declared query or path value of any GET route is never a 2xx or a 5xx', async () => {
    const seen: string[] = [];
    for (const r of routes.filter((x) => x.method === 'GET')) {
      const params = [...r.path.matchAll(/:(\w+)/g)].map((m) => m[1]);
      const fill = (nul: string | null) =>
        r.path.replace(/:(\w+)/g, (_, p: string) =>
          p === nul
            ? 'a%00b'
            : p.toLowerCase().includes('id')
              ? '00000000-0000-4000-8000-0000000000ff'
              : 'abc',
        );
      const probes = [
        ...params.map((p) => ({ path: fill(p), text: true })),
        ...r.queryKeys.map((k) => ({
          path: `${fill(null)}?${k}=%00`,
          text: !NOT_TEXT.has(`GET ${r.path} ${k}`),
        })),
      ];
      const callers = r.path.startsWith('/admin/')
        ? [undefined, admin]
        : [undefined, creator];
      for (const { path, text } of probes) {
        for (const token of callers) {
          const res = await get(path, token);
          seen.push(`${res.status} GET ${path}`);
          // 400 is a value check (this task's or an earlier one); 401, 403,
          // 409 and 423 are a guard or the wallet gate, before any value is read.
          const allowed = text
            ? [400, 401, 403, 409, 423].includes(res.status)
            : res.status < 500;
          expect([`GET ${path}`, res.status, allowed]).toEqual([
            `GET ${path}`,
            res.status,
            true,
          ]);
        }
      }
    }
    expect(seen.length).toBeGreaterThan(400);
    expect(seen.filter((s) => s.startsWith('400 ')).length).toBeGreaterThan(
      200,
    );
  }, 120_000);

  describe('the two enum and paging 500s', () => {
    const orders = (q: string) => get(`/admin/shop/orders?${q}`, admin);
    const msg = (m: string) => ({ statusCode: 400, message: m, data: null });
    const FULFILMENT = msg(
      'fulfilment must be one of the following values: awaiting_dispatch, dispatched, delivered',
    );

    it('GET /admin/shop/orders refuses what Prisma could not take, naming the field', async () => {
      for (const q of [
        'fulfilment=bogus',
        'fulfilment=pending',
        'fulfilment=PENDING',
        'fulfilment=dispatched&fulfilment=delivered',
      ])
        expect((await orders(q).expect(400)).body).toEqual(FULFILMENT);
      for (const q of [
        'page=abc',
        'page=1&page=2',
        'page=NaN',
        'page=abc&perPage=abc',
      ])
        expect((await orders(q).expect(400)).body).toEqual(
          msg('page must be a number'),
        );
      for (const q of ['perPage=abc', 'perPage=NaN', 'perPage=1&perPage=2'])
        expect((await orders(q).expect(400)).body).toEqual(
          msg('perPage must be a number'),
        );
      for (const q of [
        'page=Infinity',
        'page=1e18',
        'page=1e300',
        'perPage=100&page=1e17',
        'perPage=1&page=9223372036854775296',
      ])
        expect((await orders(q).expect(400)).body).toEqual(
          msg('page must be a smaller number'),
        );
    });

    it('GET /admin/shop/orders keeps every answer that was a 200', async () => {
      const cases: [string, number, number][] = [
        ['', 1, 25],
        ['fulfilment=', 1, 25],
        ['fulfilment=dispatched', 1, 25],
        ['page=', 1, 25],
        ['page=0', 1, 25],
        ['page=-1', 1, 25],
        ['page=-Infinity', 1, 25],
        ['page=1.5', 1.5, 25],
        ['page=0x10', 16, 25],
        ['page=1e17', 1e17, 25],
        ['perPage=1&page=9223372036854775295', 9223372036854774784, 1],
        ['perPage=0', 1, 1],
        ['perPage=1000', 1, 100],
        ['perPage=Infinity', 1, 100],
        ['perPage=1.5', 1, 1.5],
      ];
      for (const [q, currentPage, perPage] of cases) {
        const res = await orders(q).expect(200);
        const { pagination } = res.body as {
          pagination: { currentPage: number; perPage: number };
        };
        expect([q, pagination.currentPage, pagination.perPage]).toEqual([
          q,
          currentPage,
          perPage,
        ]);
      }
    });

    it('GET /shop/categories/<not a category>/subcategories is a 400 naming category', async () => {
      const body = {
        statusCode: 400,
        message:
          'category must be one of the following values: audio_music, video_film, lighting_studio, photography, computing, art_design, gaming_streaming, content_creation, live_events, professional, power_accessories',
        data: null,
      };
      for (const c of [
        'business',
        'AUDIO_MUSIC',
        '%00',
        'audio_music%00',
        'constructor',
        '__proto__',
      ])
        expect(
          (await get(`/shop/categories/${c}/subcategories`).expect(400)).body,
        ).toEqual(body);
      await get('/shop/categories/audio_music/subcategories').expect(200);
    });
  });

  describe('GET /search/closest takes the same 100 characters as GET /search', () => {
    const TOO_LONG = {
      statusCode: 400,
      message: 'q must be shorter than or equal to 100 characters',
      data: null,
    };

    it('refuses a q over 100 characters, with or without a NUL, before any query', async () => {
      for (const q of [
        'a'.repeat(101),
        `${'a+'.repeat(4000)}a`,
        `${'a'.repeat(100)}%00`,
      ])
        expect((await get(`/search/closest?q=${q}`).expect(400)).body).toEqual(
          TOO_LONG,
        );
    });

    it('keeps the 400 a missing, empty or repeated q answered before', async () => {
      const msg = (m: string) => ({ statusCode: 400, message: m, data: null });
      for (const path of ['/search/closest', '/search/closest?q=']) {
        expect((await get(path).expect(400)).body).toEqual(
          msg('q should not be empty'),
        );
      }
      for (const path of [
        '/search/closest?q=a&q=b',
        `/search/closest?q=%00&q=${'a'.repeat(200)}`,
      ]) {
        expect((await get(path).expect(400)).body).toEqual(
          msg('q must be a string'),
        );
      }
    });

    it('still searches a q of 100 characters', async () => {
      const res = await get(`/search/closest?q=${'b'.repeat(100)}`).expect(200);
      expect((res.body as { data: unknown }).data).toEqual({ items: [] });
    });
  });
});
