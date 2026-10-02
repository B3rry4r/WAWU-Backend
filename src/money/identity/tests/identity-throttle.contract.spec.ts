import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication, LoggerService } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as jwt from 'jsonwebtoken';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  FintavaDouble,
  fintavaError,
} from '../../../../test/fintava/fintava-double';
import type { PrismaService as PrismaServiceType } from '../../../common/prisma/prisma.service';

/**
 * POST /money/identity/bvn is limited per address by the app's OWN global
 * ThrottlerGuard (task KYC-01): the whole AppModule, so the guard, its
 * storage and its named throttlers (`short`, `medium`, app.module.ts) are the
 * real ones. A route-level `@Throttle()` only takes effect for a throttler
 * the module registered; a bare or `default` one would be silently ignored
 * (the defect a verifier caught on MONEY-07), which the first test would
 * then catch: the fourth check would reach Fintava.
 */

const HASH_KEY = 'k01-throttle-identity-hash-key-0123456789abcdef';
const ENV: Record<string, string> = {
  FINTAVA_BASE_URL: '',
  FINTAVA_API_KEY: 'live_test_throttle_0123456789FAKEKEY',
  IDENTITY_HASH_KEY: HASH_KEY,
  BVN_CHECKS_PER_DAY: '',
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
      email: `throttle-${sub}@test.wawu.dev`,
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

describe('BVN check throttle through the global ThrottlerGuard (KYC-01)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaServiceType;
  const double = new FintavaDouble();
  const previous: Record<string, string | undefined> = {};
  const users: string[] = [];

  function person(): string {
    const id = randomUUID();
    users.push(id);
    return `Bearer ${mintToken(id)}`;
  }

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
    app = moduleRef.createNestApplication<INestApplication<App>>({ logger });
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
      await prisma.bvnCheckAttempt.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.walletIdentity.deleteMany({
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

  const bvnCalls = () =>
    double.seen.filter((s) => s.path === '/compliance/verify/bvn').length;

  it('the fourth check from one address within a minute is 429 from the guard and never reaches Fintava', async () => {
    double.on('GET', '/compliance/verify/bvn', {
      status: 400,
      body: fintavaError(400, 'Invalid BVN or BVN does not exist'),
    });
    // A different person each time, so the per-person daily limit (3) is
    // not what stops the fourth: only the per-address throttle can.
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const res = await request(app.getHttpServer())
        .post('/api/hub/money/identity/bvn')
        .set('Authorization', person())
        .send({ bvn: '22190000777', nin: '70190000777' });
      statuses.push(res.status);
      if (i === 3) {
        expect(res.body).toMatchObject({ statusCode: 429, data: null });
        expect((res.body as { reason?: unknown }).reason).toBeUndefined();
      }
    }
    expect(statuses).toEqual([422, 422, 422, 429]);
    expect(bvnCalls()).toBe(3);
    expect(
      await prisma.bvnCheckAttempt.count({
        where: { wawuUserId: { in: users } },
      }),
    ).toBe(3);
  });

  it('behind nginx each caller has their own bucket: the address nginx appends, never one the caller wrote', async () => {
    // Every request here reaches the app from 127.0.0.1, as nginx's do on
    // the droplet. Without reading X-Forwarded-For they would all share the
    // bucket the first test used up.
    const send = (xff: string) =>
      request(app.getHttpServer())
        .post('/api/hub/money/identity/bvn')
        .set('Authorization', person())
        .set('X-Forwarded-For', xff)
        .send({ bvn: '22190000777', nin: '70190000777' });
    const before = bvnCalls();
    // Caller A, three times, each time writing a different address of its
    // own in front of the one nginx appended: still one bucket, A's.
    const a = [];
    for (const forged of ['9.9.9.1', '9.9.9.2', '9.9.9.3', '9.9.9.4']) {
      a.push((await send(`${forged}, 198.51.100.7`)).status);
    }
    expect(a).toEqual([422, 422, 422, 429]);
    // Caller B, at the same moment, is not held up by A or by the first test.
    expect((await send('198.51.100.8')).status).toBe(422);
    expect(bvnCalls() - before).toBe(4);
  });

  it('a caller that reaches the app directly cannot choose its bucket with the header', () => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { bvnCheckTracker } =
      require('../identity-config') as typeof import('../identity-config');
    /* eslint-enable @typescript-eslint/no-require-imports */
    const xff = { 'x-forwarded-for': '198.51.100.9' };
    expect(bvnCheckTracker({ ip: '203.0.113.5', headers: xff })).toBe(
      '203.0.113.5',
    );
    expect(bvnCheckTracker({ ip: '127.0.0.1', headers: xff })).toBe(
      '198.51.100.9',
    );
    expect(bvnCheckTracker({ ip: '::1', headers: {} })).toBe('::1');
    expect(
      bvnCheckTracker({
        ip: '::ffff:127.0.0.1',
        headers: { 'x-forwarded-for': ' 1.2.3.4 ,  198.51.100.10 ' },
      }),
    ).toBe('198.51.100.10');
  });

  it('reading the identity step is not held to the BVN check’s limit', async () => {
    const auth = person();
    for (let i = 0; i < 6; i += 1) {
      await request(app.getHttpServer())
        .get('/api/hub/money/identity')
        .set('Authorization', auth)
        .expect(200);
    }
  });

  it('the route names only the app’s registered throttlers, never `default`', () => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { MoneyIdentityController } =
      require('../money-identity.controller') as typeof import('../money-identity.controller');
    /* eslint-enable @typescript-eslint/no-require-imports */
    const handler = Object.getOwnPropertyDescriptor(
      MoneyIdentityController.prototype,
      'checkBvn',
    )!.value as object;
    const keys = Reflect.getMetadataKeys(handler).filter(
      (k): k is string => typeof k === 'string' && k.startsWith('THROTTLER:'),
    );
    expect(keys.some((k) => k.endsWith('default'))).toBe(false);
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { HUB_THROTTLERS } =
      require('../../../hub-throttlers') as typeof import('../../../hub-throttlers');
    const { BVN_CHECK_THROTTLE } =
      require('../identity-config') as typeof import('../identity-config');
    /* eslint-enable @typescript-eslint/no-require-imports */
    const registered = HUB_THROTTLERS.map((t) => t.name as string);
    for (const name of Object.keys(BVN_CHECK_THROTTLE)) {
      expect(registered).toContain(name);
    }
    expect(Reflect.getMetadata('THROTTLER:LIMITshort', handler)).toBe(3);
    expect(Reflect.getMetadata('THROTTLER:TTLshort', handler)).toBe(60_000);
    expect(Reflect.getMetadata('THROTTLER:LIMITmedium', handler)).toBe(20);
    expect(Reflect.getMetadata('THROTTLER:TTLmedium', handler)).toBe(3_600_000);
  });
});
