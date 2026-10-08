import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from '../../../app.module';
import {
  applyHubHttpSettings,
  HUB_APP_OPTIONS,
} from '../../../hub-app-options';
import {
  startTestJwksServer,
  type TestJwksServer,
} from '../../../evg-score/tests/test-jwks-server';
import { PrismaService } from '../../prisma/prisma.service';
import {
  adminFixtures,
  adminJwtSecrets,
  deleteAdminFixtures,
  loginAdmin,
  seedAdminFixtures,
} from '../../tests/admin-session.helper';
import { ResponseInterceptor } from '../../interceptors/response.interceptor';
import { AllExceptionsFilter } from '../all-exceptions.filter';

/**
 * FIX-08: a request body the parser refuses answers its 4xx (413 too large,
 * 415 unreadable charset or encoding, 400 unreadable), never a 500, on every
 * kind of route. Recorded before the fix: every one of these was a 500.
 *
 * The app is the FULL AppModule, composed as src/main.ts composes it: the same
 * create options (HUB_APP_OPTIONS, which keeps the raw body), the same Express
 * settings, helmet, compression, cookie-parser, prefix, pipe, filter and
 * interceptor, listening on a real port. Only the rate limit is lifted
 * (throttling is not what this checks) and WAWU ID's key set is a local
 * stand-in, so a signed-in caller is a real RS256 token checked by the real
 * strategy. Requests go out through node:http so every header and byte is
 * exactly what the case says.
 *
 * The parser runs before any guard or route, so the same refusal comes back
 * whoever calls and wherever: a public route, a signed-in one, an admin one,
 * a webhook and a path that does not exist.
 */

const LIMIT = 100 * 1024; // Express's default, which this task leaves alone.
const SEEDED_USER = '00000000-0000-4000-8000-000000000001'; // prisma/seed.ts
const ADMINS = adminFixtures('f08b0d1e', 'f08-body-parser');
const SUPERADMIN = ADMINS.find((a) => a.role === 'superadmin')!;

type Hit = { status: number; body: unknown };

/** Valid JSON of exactly `bytes` bytes. */
function jsonOfSize(bytes: number): string {
  const empty = JSON.stringify({ pad: '' });
  return JSON.stringify({ pad: 'x'.repeat(bytes - empty.length) });
}

const TOO_LARGE = { message: 'That request is too large.', data: null };
const UNREADABLE = { message: 'That request could not be read.', data: null };
const CHARSET = {
  message:
    'That request uses a character set this server does not read. Send it as UTF-8.',
  data: null,
};
const ENCODING = {
  message: 'That request uses a content encoding this server does not read.',
  data: null,
};
const TOO_MANY_FIELDS = {
  message: 'That request has too many fields.',
  data: null,
};

describe('Request bodies the parser refuses (FIX-08)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwks: TestJwksServer;
  let port: number;
  let userToken: string;
  let adminToken: string;
  const previousEnv: Record<string, string | undefined> = {};

  function send(
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: string | Buffer,
  ): Promise<Hit> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method,
          path: `/api/hub${path}`,
          agent: false,
          headers: {
            ...headers,
            ...(body === undefined
              ? {}
              : { 'content-length': String(Buffer.byteLength(body)) }),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed: unknown = text;
            try {
              parsed = JSON.parse(text);
            } catch {
              // not JSON: kept as text so a failing case shows it
            }
            resolve({ status: res.statusCode ?? 0, body: parsed });
          });
        },
      );
      req.on('error', reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  /** The five kinds of caller, each with what it sends besides the body. */
  const routes = () =>
    [
      {
        kind: 'a public route',
        method: 'POST',
        path: '/admin/auth/login',
        headers: {} as Record<string, string>,
        reachesRoute: true,
      },
      {
        kind: 'a signed-in route',
        method: 'POST',
        path: '/users/me/experience',
        headers: { authorization: `Bearer ${userToken}` },
        reachesRoute: true,
      },
      {
        kind: 'an admin route',
        method: 'POST',
        path: `/admin/content/${randomUUID()}/reject`,
        headers: { authorization: `Bearer ${adminToken}` },
        reachesRoute: true,
      },
      {
        kind: 'a webhook route that reads the raw body',
        method: 'POST',
        path: '/webhooks/fintava',
        headers: {} as Record<string, string>,
        reachesRoute: false,
      },
      {
        kind: 'a path no route serves',
        method: 'POST',
        path: '/no-such-route-fix-08',
        headers: {} as Record<string, string>,
        reachesRoute: false,
      },
    ] as const;

  const KINDS = [
    'a public route',
    'a signed-in route',
    'an admin route',
    'a webhook route that reads the raw body',
    'a path no route serves',
  ];
  const route = (kind: string) => routes().find((r) => r.kind === kind)!;
  const json = { 'content-type': 'application/json' };
  const form = { 'content-type': 'application/x-www-form-urlencoded' };

  beforeAll(async () => {
    jwks = await startTestJwksServer();
    const secrets = adminJwtSecrets('fix-08-body-parser');
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
    app = moduleRef.createNestApplication(HUB_APP_OPTIONS);
    applyHubHttpSettings(app);
    app.use(helmet());
    app.use(compression());
    app.use(cookieParser());
    app.setGlobalPrefix('api/hub');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    // Port 0: the OS picks a free one, so nothing here can collide.
    await app.listen(0, '127.0.0.1');
    port = ((app.getHttpServer() as Server).address() as AddressInfo).port;

    prisma = app.get(PrismaService);
    await seedAdminFixtures(prisma, ADMINS);
    adminToken = await loginAdmin(app, SUPERADMIN.email);
    userToken = jwks.signToken({
      sub: SEEDED_USER,
      email: 'user@test.wawu.dev',
      phone: '+2348000000001',
      firstName: 'Adaeze',
      lastName: 'Okonkwo',
      country: 'Nigeria',
      verificationTier: 'verified_user',
      trustScore: 40,
      status: 'active',
    });
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

  it('the callers are who they say: the signed-in and admin tokens are accepted', async () => {
    // A body the routes refuse for its fields, so nothing is written: what
    // matters is that the guard let the caller through to validation.
    const user = await send(
      'POST',
      '/users/me/experience',
      route('a signed-in route').headers,
      '{}',
    );
    expect(user.status).toBe(400);
    const admin = await send(
      'POST',
      route('an admin route').path,
      route('an admin route').headers,
      '{}',
    );
    expect(admin.status).toBe(400);
  });

  describe.each(KINDS)('on %s', (kind) => {
    const hit = (headers: Record<string, string>, body?: string | Buffer) => {
      const r = route(kind);
      return send(r.method, r.path, { ...r.headers, ...headers }, body);
    };

    it('a 101 kB JSON body answers 413 in the usual error envelope', async () => {
      const res = await hit(json, jsonOfSize(101 * 1024));
      expect(res.status).toBe(413);
      expect(res.body).toEqual({ statusCode: 413, ...TOO_LARGE });
    });

    it('the limit has not moved: 100 kB exactly still reaches the route, one byte more is 413', async () => {
      const at = await hit(json, jsonOfSize(LIMIT));
      expect(at.status).not.toBe(413);
      expect(at.status).toBeLessThan(500);
      if (route(kind).reachesRoute) {
        // The route's own validation answered, so the parser let it through.
        expect(at.body).toEqual({
          statusCode: 400,
          message: 'property pad should not exist',
          data: null,
        });
      }
      const over = await hit(json, jsonOfSize(LIMIT + 1));
      expect(over.status).toBe(413);
      expect(over.body).toEqual({ statusCode: 413, ...TOO_LARGE });
    });

    it('malformed JSON answers 400 with the parser message, as it did before', async () => {
      const text = '{"a":';
      let parserMessage = '';
      try {
        JSON.parse(text);
      } catch (e) {
        parserMessage = (e as Error).message;
      }
      const res = await hit(json, text);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        statusCode: 400,
        message: parserMessage,
        data: null,
      });
    });

    it('a JSON body in a charset other than UTF-8 answers 415', async () => {
      for (const charset of ['latin1', 'klingon']) {
        const res = await hit(
          { 'content-type': `application/json; charset=${charset}` },
          '{}',
        );
        expect(res.status).toBe(415);
        expect(res.body).toEqual({ statusCode: 415, ...CHARSET });
      }
    });

    it('a content encoding the parser cannot undo answers 415', async () => {
      const res = await hit({ ...json, 'content-encoding': 'bogus' }, '{}');
      expect(res.status).toBe(415);
      expect(res.body).toEqual({ statusCode: 415, ...ENCODING });
    });

    it('a gzip body that is not gzip answers 400', async () => {
      const res = await hit(
        { ...json, 'content-encoding': 'gzip' },
        Buffer.from('this is not gzip'),
      );
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ statusCode: 400, ...UNREADABLE });
    });

    it('a small gzip body that inflates past the limit answers 413', async () => {
      const body = gzipSync(jsonOfSize(101 * 1024));
      expect(body.length).toBeLessThan(LIMIT);
      const res = await hit({ ...json, 'content-encoding': 'gzip' }, body);
      expect(res.status).toBe(413);
      expect(res.body).toEqual({ statusCode: 413, ...TOO_LARGE });
    });

    it('a form body: 101 kB answers 413, 1001 fields 413, nested too deep 400', async () => {
      const big = await hit(form, `pad=${'x'.repeat(101 * 1024)}`);
      expect(big.status).toBe(413);
      expect(big.body).toEqual({ statusCode: 413, ...TOO_LARGE });

      const many = Array.from({ length: 1001 }, (_, i) => `k${i}=v`).join('&');
      const fields = await hit(form, many);
      expect(fields.status).toBe(413);
      expect(fields.body).toEqual({ statusCode: 413, ...TOO_MANY_FIELDS });

      const deep = await hit(form, `a${'[b]'.repeat(40)}=1`);
      expect(deep.status).toBe(400);
      expect(deep.body).toEqual({ statusCode: 400, ...UNREADABLE });
    });

    it('an empty body with a JSON content type is left to the route, as before', async () => {
      const res = await hit(json, '');
      expect(res.status).toBeLessThan(500);
      expect(res.status).not.toBe(413);
      const message = (res.body as { message?: string }).message;
      for (const parser of [TOO_LARGE, UNREADABLE, CHARSET, ENCODING])
        expect(message).not.toBe(parser.message);
      // The three routes that take this body all refuse it for its fields.
      if (route(kind).reachesRoute) expect(res.status).toBe(400);
    });
  });

  it('no refusal is logged as a server error', async () => {
    const errors = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    try {
      const r = route('a public route');
      await send(r.method, r.path, json, jsonOfSize(101 * 1024));
      await send(
        r.method,
        r.path,
        { 'content-type': 'application/json; charset=latin1' },
        '{}',
      );
      await send(
        r.method,
        r.path,
        { ...json, 'content-encoding': 'gzip' },
        Buffer.from('nope'),
      );
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it('src/main.ts composes the app this spec builds: HUB_APP_OPTIONS, this filter, and no parser of its own', () => {
    const main = readFileSync(join(__dirname, '../../../main.ts'), 'utf8');
    expect(main).toMatch(
      /NestFactory\.create\(\s*AppModule,\s*HUB_APP_OPTIONS\s*\)/,
    );
    expect(main).toMatch(
      /useGlobalFilters\(\s*new AllExceptionsFilter\(\)\s*\)/,
    );
    // A parser or limit set here would mean the default above is not live.
    expect(main).not.toMatch(
      /useBodyParser|bodyParser|express\.json|express\.urlencoded|limit\s*:/,
    );
  });
});
