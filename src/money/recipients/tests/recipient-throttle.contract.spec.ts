import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication, LoggerService } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as jwt from 'jsonwebtoken';
import request from 'supertest';
import type { App } from 'supertest/types';
import { FintavaDouble } from '../../../../test/fintava/fintava-double';
import type { PrismaService as PrismaServiceType } from '../../../common/prisma/prisma.service';
import {
  applyHubHttpSettings,
  HUB_APP_OPTIONS,
} from '../../../hub-app-options';
import {
  RECIPIENT_SEARCH_PERSON_LIMITS,
  RECIPIENT_SEARCH_THROTTLE,
  RecipientSearchLimiter,
} from '../recipient-config';

/**
 * GET /money/recipients is limited per address, tighter than the global
 * limits, by the app's OWN global ThrottlerGuard, and per person by
 * RecipientSearchLimiter in the handler (task WALLET-08): the whole
 * AppModule, so the guard, its storage and its named throttlers (`short`,
 * `medium`, app.module.ts) are the real ones. A route-level `@Throttle()`
 * only takes effect for a throttler the module registered, which the first
 * test would catch: the 21st search would not be a 429.
 *
 * Every request reaches the app from 127.0.0.1, as nginx's do on the droplet;
 * the caller's own address is the last entry of X-Forwarded-For
 * (hubTrustProxy), so each test uses addresses from the documentation range
 * that no other test uses.
 */

const ENV: Record<string, string> = {
  FINTAVA_BASE_URL: '',
  FINTAVA_API_KEY: 'live_test_w08_throttle_0123456789FAKEKEY',
  IDENTITY_HASH_KEY: 'w08-throttle-identity-hash-key-0123456789abcdef',
};

class QuietLogger implements LoggerService {
  log() {}
  error() {}
  warn() {}
  debug() {}
  verbose() {}
  fatal() {}
}

function mintToken(sub: string): string {
  const privateKey = readFileSync(
    join(__dirname, '../../../../mock-wawu-id/private.pem'),
    'utf8',
  );
  return jwt.sign(
    {
      sub,
      email: `w08-throttle-${sub}@test.wawu.dev`,
      phone: '+2348031234412',
      firstName: 'Throttle',
      lastName: 'Check',
      country: 'Nigeria',
      verificationTier: 'basic',
      trustScore: 0,
      status: 'active',
    },
    privateKey,
    { algorithm: 'RS256', keyid: 'mock-wawu-id-key-1', expiresIn: '15m' },
  );
}

describe('Recipient search throttle through the global ThrottlerGuard (WALLET-08)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaServiceType;
  const double = new FintavaDouble();
  const previous: Record<string, string | undefined> = {};
  const users: string[] = [];

  /** A person with an open wallet, so what answers is the search and not the gate. */
  async function holder(): Promise<string> {
    const id = randomUUID();
    users.push(id);
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId: id,
        customerId: randomUUID(),
        walletId: randomUUID(),
        accountNumber: `16${String(Date.now()).slice(-6)}${String(users.length).padStart(2, '0')}`,
      },
    });
    return `Bearer ${mintToken(id)}`;
  }

  /** One search from `client`, as nginx forwards it (the caller's own address last). */
  const searchFrom = (auth: string, client: string, sent?: string) =>
    request(app.getHttpServer())
      .get('/api/hub/money/recipients')
      .query({ q: 'zzqqxx' })
      .set('Authorization', auth)
      .set('X-Forwarded-For', sent ? `${sent}, ${client}` : client);

  const recentFrom = (auth: string, client: string) =>
    request(app.getHttpServer())
      .get('/api/hub/money/recipients/recent')
      .set('Authorization', auth)
      .set('X-Forwarded-For', client);

  beforeAll(async () => {
    await double.start();
    ENV.FINTAVA_BASE_URL = double.baseUrl;
    for (const [k, v] of Object.entries(ENV)) {
      previous[k] = process.env[k];
      process.env[k] = v;
    }
    // Loaded after the environment is in place, as the app loads them.
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { AppModule } =
      require('../../../app.module') as typeof import('../../../app.module');
    const { PrismaService } =
      require('../../../common/prisma/prisma.service') as typeof import('../../../common/prisma/prisma.service');
    const { AllExceptionsFilter } =
      require('../../../common/filters/all-exceptions.filter') as typeof import('../../../common/filters/all-exceptions.filter');
    const { ResponseInterceptor } =
      require('../../../common/interceptors/response.interceptor') as typeof import('../../../common/interceptors/response.interceptor');
    /* eslint-enable @typescript-eslint/no-require-imports */
    const logger = new QuietLogger();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .setLogger(logger)
      .compile();
    app = moduleRef.createNestApplication<INestApplication<App>>({
      ...HUB_APP_OPTIONS,
      logger,
    });
    applyHubHttpSettings(app);
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
    await app.init();
    prisma = moduleRef.get(PrismaService);
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.fintavaWallet.deleteMany({
        where: { wawuUserId: { in: users } },
      });
    }
    if (app) await app.close();
    await double.stop();
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('the limits are these exact ones: 20 a minute and 120 an hour from one address', () => {
    expect(RECIPIENT_SEARCH_THROTTLE).toEqual({
      short: { limit: 20, ttl: 60_000 },
      medium: { limit: 120, ttl: 3_600_000 },
    });
  });

  it('the 21st search in a minute from one address is a 429 in the one error shape, with the limit headers', async () => {
    const auth = await holder();
    const client = '198.51.100.81';
    const statuses: number[] = [];
    let last = await searchFrom(auth, client);
    statuses.push(last.status);
    expect(last.headers['x-ratelimit-limit-short']).toBe('20');
    expect(last.headers['x-ratelimit-limit-medium']).toBe('120');
    for (let i = 1; i < 21; i += 1) {
      last = await searchFrom(auth, client);
      statuses.push(last.status);
    }
    expect(statuses.slice(0, 20)).toEqual(Array(20).fill(200));
    expect(statuses[20]).toBe(429);
    const res = last.body as Record<string, unknown>;
    expect(res).toMatchObject({ statusCode: 429, data: null });
    expect(typeof res.message).toBe('string');
    expect(res.reason).toBeUndefined();
    expect(JSON.stringify(res)).not.toContain('—');
    expect(last.headers['retry-after-short']).toBeDefined();
  });

  it('a 429 is answered before the wallet gate or the search text is read, so it costs nothing', async () => {
    const client = '198.51.100.82';
    const nobody = `Bearer ${mintToken(randomUUID())}`;
    const statuses: number[] = [];
    for (let i = 0; i < 21; i += 1) {
      statuses.push((await searchFrom(nobody, client)).status);
    }
    // No wallet: the gate refuses (409) until the limit, then the guard (429).
    expect(statuses.slice(0, 20)).toEqual(Array(20).fill(409));
    expect(statuses[20]).toBe(429);
  });

  it('each address has its own bucket, and an address a caller writes in front of nginx counts for nothing', async () => {
    const auth = await holder();
    const a = [];
    for (let i = 0; i < 21; i += 1) {
      a.push((await searchFrom(auth, '198.51.100.83', `9.9.9.${i}`)).status);
    }
    expect(a.slice(0, 20)).toEqual(Array(20).fill(200));
    expect(a[20]).toBe(429);
    // Another caller on another address, the same moment, is not held up by it.
    expect((await searchFrom(await holder(), '198.51.100.84')).status).toBe(
      200,
    );
  });

  describe('per person, counted after the token is verified', () => {
    const body = (res: request.Response) =>
      res.body as {
        statusCode: number;
        message: string;
        data: null;
        reason?: { code: string; message: string; retryAfterSeconds?: number };
      };

    it('the figures are these exact ones: 20 a minute, 120 an hour, 500 a day', () => {
      expect(RECIPIENT_SEARCH_PERSON_LIMITS).toEqual([
        { name: 'minute', limit: 20, windowMs: 60_000 },
        { name: 'hour', limit: 120, windowMs: 3_600_000 },
        { name: 'day', limit: 500, windowMs: 86_400_000 },
      ]);
    });

    it('one account from 30 addresses in one /64 is refused after 20 in a minute, in the one error shape with Retry-After', async () => {
      const auth = await holder();
      const results: request.Response[] = [];
      for (let i = 1; i <= 30; i += 1) {
        results.push(
          await searchFrom(auth, `2001:db8:abcd:12::${i.toString(16)}`),
        );
      }
      expect(results.slice(0, 20).map((r) => r.status)).toEqual(
        Array(20).fill(200),
      );
      expect(results.slice(20).map((r) => r.status)).toEqual(
        Array(10).fill(429),
      );
      for (const r of results.slice(20)) {
        const b = body(r);
        expect(b).toMatchObject({ statusCode: 429, data: null });
        expect(b.reason?.code).toBe('recipient_search_rate_limited');
        expect(b.reason?.message).toBe(b.message);
        const wait = b.reason?.retryAfterSeconds ?? 0;
        expect(wait).toBeGreaterThanOrEqual(1);
        expect(wait).toBeLessThanOrEqual(60);
        expect(Number.isInteger(wait)).toBe(true);
        expect(r.headers['retry-after']).toBe(String(wait));
        expect(JSON.stringify(b)).not.toContain('\u2014');
      }
    });

    it('two accounts on one address each keep their own budget, and the address limit still applies to the address', async () => {
      const a = await holder();
      const b = await holder();
      const x = '198.51.100.91';
      const y = '198.51.100.92';
      for (let i = 0; i < 15; i += 1) {
        expect((await searchFrom(a, x)).status).toBe(200);
      }
      for (let i = 0; i < 5; i += 1) {
        expect((await searchFrom(b, x)).status).toBe(200);
      }
      // The address has had its 20: both accounts are refused from it, by
      // the address limit (a 429 with no `reason`).
      for (const who of [a, b]) {
        const res = await searchFrom(who, x);
        expect(res.status).toBe(429);
        expect(body(res).reason).toBeUndefined();
      }
      // From another address each has what is left of their own 20: A used
      // 15, B used 5 (the two refusals above were never counted).
      for (let i = 0; i < 5; i += 1) {
        expect((await searchFrom(a, y)).status).toBe(200);
      }
      const aOver = await searchFrom(a, y);
      expect(aOver.status).toBe(429);
      expect(body(aOver).reason?.code).toBe('recipient_search_rate_limited');
      const z = '198.51.100.93';
      for (let i = 0; i < 15; i += 1) {
        expect((await searchFrom(b, z)).status).toBe(200);
      }
      const bOver = await searchFrom(b, z);
      expect(bOver.status).toBe(429);
      expect(body(bOver).reason?.code).toBe('recipient_search_rate_limited');
    });

    it('a request that is refused before the handler (no token, a bad token, a 400, no wallet) is never counted', async () => {
      const auth = await holder();
      const one = (q: string, a: string | null, c: string) => {
        const req = request(app.getHttpServer())
          .get('/api/hub/money/recipients')
          .query({ q })
          .set('X-Forwarded-For', c);
        return a ? req.set('Authorization', a) : req;
      };
      let n = 0;
      const addr = () => `2001:db8:94::${(n++).toString(16)}`;
      for (let i = 0; i < 30; i += 1) {
        expect((await one('zzqqxx', null, addr())).status).toBe(401);
        expect((await one('a', auth, addr())).status).toBe(400);
        expect(
          (await one('zzqqxx', `Bearer ${mintToken(randomUUID())}`, addr()))
            .status,
        ).toBe(409);
      }
      // 90 refused requests, none counted: all 20 searches are still there.
      for (let i = 0; i < 20; i += 1) {
        expect((await one('zzqqxx', auth, addr())).status).toBe(200);
      }
      expect((await one('zzqqxx', auth, addr())).status).toBe(429);
    });

    /** A person with a clock the test moves; every request from its own address. */
    async function onMovedClock() {
      const limiter = app.get(RecipientSearchLimiter, { strict: false });
      const auth = await holder();
      const t0 = 1_900_000_000_000;
      let clock = t0;
      limiter.now = () => clock;
      let n = 0;
      const search = () =>
        searchFrom(auth, `2001:db8:7::${(n++).toString(16)}`);
      const burst = async (count: number) => {
        const out: number[] = [];
        for (let i = 0; i < count; i += 1) out.push((await search()).status);
        return out;
      };
      return {
        t0,
        at: (ms: number) => {
          clock = t0 + ms;
        },
        search,
        burst,
        restore: () => {
          limiter.now = () => Date.now();
        },
      };
    }

    it('the minute window starts again: 20 pass and the 21st is refused, then exactly 20 pass again 61 s later, and the 21st is refused again', async () => {
      const c = await onMovedClock();
      try {
        c.at(0);
        expect(await c.burst(20)).toEqual(Array(20).fill(200));
        expect((await c.search()).status).toBe(429);
        // 59.999 s after the first: still the same minute.
        c.at(59_999);
        expect((await c.search()).status).toBe(429);
        // The window began at 0 and holds 60 s: at 61 s it is a new one.
        c.at(61_000);
        expect(await c.burst(20)).toEqual(Array(20).fill(200));
        expect((await c.search()).status).toBe(429);
        // And again, a third time.
        c.at(122_000);
        expect(await c.burst(20)).toEqual(Array(20).fill(200));
        expect((await c.search()).status).toBe(429);
      } finally {
        c.restore();
      }
    }, 60_000);

    it('the hour window starts again: 120 pass and the 121st is refused, then exactly 120 pass again an hour later, and the 121st is refused again', async () => {
      const c = await onMovedClock();
      try {
        for (const base of [0, 3_600_000]) {
          for (let m = 0; m < 6; m += 1) {
            c.at(base + m * 61_000);
            expect(await c.burst(20)).toEqual(Array(20).fill(200));
          }
          c.at(base + 6 * 61_000);
          const over = await c.search();
          expect(over.status).toBe(429);
          // The hour began at `base`: the same wait each time, 3,234 s.
          expect(
            (over.body as { reason?: { retryAfterSeconds?: number } }).reason
              ?.retryAfterSeconds,
          ).toBe(3_234);
        }
      } finally {
        c.restore();
      }
    }, 60_000);

    it('a wait that is not a whole number of seconds is rounded UP, in the body and in Retry-After', async () => {
      const wait = async (elapsedMs: number) => {
        const c = await onMovedClock();
        try {
          c.at(0);
          expect(await c.burst(20)).toEqual(Array(20).fill(200));
          c.at(elapsedMs);
          const res = await c.search();
          expect(res.status).toBe(429);
          return {
            body: (res.body as { reason?: { retryAfterSeconds?: number } })
              .reason?.retryAfterSeconds,
            header: res.headers['retry-after'],
          };
        } finally {
          c.restore();
        }
      };
      // 60,000 - 10,500 = 49,500 ms: 49.5 s, so 50 (never 49).
      expect(await wait(10_500)).toEqual({ body: 50, header: '50' });
      // 60,000 - 10,999 = 49,001 ms: a thousandth over 49 s is still 50.
      expect(await wait(10_999)).toEqual({ body: 50, header: '50' });
      // 60,000 - 11,000 = 49,000 ms: a whole number stays as it is.
      expect(await wait(11_000)).toEqual({ body: 49, header: '49' });
      // 1 ms left is 1 s, never 0.
      expect(await wait(59_999)).toEqual({ body: 1, header: '1' });
    }, 60_000);

    it('the hour and the day count too: 120 an hour, 500 a day, with the wait rounded up, on a clock the test moves', async () => {
      const limiter = app.get(RecipientSearchLimiter, { strict: false });
      const auth = await holder();
      const t0 = 1_800_000_000_000;
      let clock = t0;
      limiter.now = () => clock;
      let n = 0;
      const addr = () => `2001:db8:5::${(n++).toString(16)}`;
      const search = () => searchFrom(auth, addr());
      const burst = async (count: number) => {
        const out: number[] = [];
        for (let i = 0; i < count; i += 1) out.push((await search()).status);
        return out;
      };
      try {
        // Hour 1: six minutes of 20 (a new minute window every 61 s) is 120.
        for (let m = 0; m < 6; m += 1) {
          clock = t0 + m * 61_000;
          expect(await burst(20)).toEqual(Array(20).fill(200));
        }
        // The 121st, in minute 7 of the same hour, is the hour's.
        clock = t0 + 6 * 61_000;
        const hourOver = await search();
        expect(hourOver.status).toBe(429);
        expect(body(hourOver).reason?.code).toBe(
          'recipient_search_rate_limited',
        );
        // The hour began at t0: 3,600,000 - 366,000 ms = 3,234 s, exactly.
        expect(body(hourOver).reason?.retryAfterSeconds).toBe(3_234);
        expect(hourOver.headers['retry-after']).toBe('3234');
        // A part second rounds up: 1 ms before the hour ends, 1 s to wait.
        clock = t0 + 3_599_999;
        const nearly = await search();
        expect(nearly.status).toBe(429);
        expect(body(nearly).reason?.retryAfterSeconds).toBe(1);
        // Hours 2 to 4: 120 each, so 480 in all by the end of hour 4.
        for (let h = 1; h < 4; h += 1) {
          for (let m = 0; m < 6; m += 1) {
            clock = t0 + h * 3_600_000 + m * 61_000;
            expect(await burst(20)).toEqual(Array(20).fill(200));
          }
        }
        // Hour 5: 20 more makes 500 for the day; the 501st is the day's,
        // although the minute and the hour have room.
        clock = t0 + 4 * 3_600_000;
        expect(await burst(20)).toEqual(Array(20).fill(200));
        clock = t0 + 4 * 3_600_000 + 61_000;
        const dayOver = await search();
        expect(dayOver.status).toBe(429);
        expect(body(dayOver).reason?.code).toBe(
          'recipient_search_rate_limited',
        );
        // The day began at t0: 86,400,000 - 14,461,000 ms = 71,939 s.
        expect(body(dayOver).reason?.retryAfterSeconds).toBe(71_939);
        // A day later the person has a clean sheet.
        clock = t0 + 86_400_000;
        expect((await search()).status).toBe(200);
      } finally {
        limiter.now = () => Date.now();
      }
    }, 60_000);
  });

  it('the recent list sets no limit of its own: its headers show the global ones, 20 a second and 200 a minute', async () => {
    const auth = await holder();
    const first = await recentFrom(auth, '198.51.100.85');
    expect(first.status).toBe(200);
    expect(first.headers['x-ratelimit-limit-short']).toBe('20');
    expect(first.headers['x-ratelimit-limit-medium']).toBe('200');
    // The search of the same address, a moment ago or not, is the tighter one.
    const searched = await searchFrom(auth, '198.51.100.86');
    expect(searched.headers['x-ratelimit-limit-short']).toBe('20');
    expect(searched.headers['x-ratelimit-limit-medium']).toBe('120');
  });
});
