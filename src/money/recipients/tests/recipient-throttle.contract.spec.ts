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
import { RECIPIENT_SEARCH_THROTTLE } from '../recipient-config';

/**
 * GET /money/recipients is limited per address, tighter than the global
 * limits, by the app's OWN global ThrottlerGuard (task WALLET-08): the whole
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
    // Another caller, the same moment, is not held up by it.
    expect((await searchFrom(auth, '198.51.100.84')).status).toBe(200);
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
