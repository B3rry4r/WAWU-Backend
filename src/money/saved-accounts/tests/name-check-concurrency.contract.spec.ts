import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import * as jwt from 'jsonwebtoken';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  BANKS,
  FintavaDouble,
  NAME_ENQUIRY,
} from '../../../../test/fintava/fintava-double';
import { WawuIdClient } from '../../../common/auth/wawu-id.client';
import { WawuJwtStrategy } from '../../../common/auth/wawu-jwt.strategy';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { MoneyModule } from '../../money.module';

/**
 * The hourly limit on bank name checks under load (WALLET-37, R-51, G-764),
 * measured the way the lead asked: 20 parallel name checks by one person
 * while the provider takes 3 seconds to answer each. Across the rounds
 * exactly 30 are allowed, the rest are refused at once without being made,
 * and another person's request is not held up by the 3 second calls (no
 * transaction, connection or lock is held across the provider call).
 */

const PROVIDER_MS = 3000;
const GTB = '000013';
const NUMBER = '0123456789';

function mintToken(sub: string): string {
  const privateKey = readFileSync(
    join(__dirname, '../../../../mock-wawu-id/private.pem'),
    'utf8',
  );
  return jwt.sign(
    {
      sub,
      email: `w37-${sub}@test.wawu.dev`,
      phone: '+2349012345678',
      firstName: 'Name',
      lastName: 'Checker',
      country: 'Nigeria',
      verificationTier: 'basic',
      trustScore: 0,
      status: 'active',
    },
    privateKey,
    { algorithm: 'RS256', keyid: 'mock-wawu-id-key-1', expiresIn: '15m' },
  );
}

describe('name checks under load (WALLET-37)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const double = new FintavaDouble();
  const users: string[] = [];
  const previous: Record<string, string | undefined> = {};
  const env: Record<string, string> = {
    FINTAVA_BASE_URL: '',
    FINTAVA_API_KEY: 'live_test_w37_0123456789FAKEKEY',
    FINTAVA_TIMEOUT_MS: '15000',
    FINTAVA_CHECK_TIMEOUT_MS: '15000',
    IDENTITY_HASH_KEY: 'w37-test-identity-hash-key-0123456789abcdef',
  };

  const auth = (id: string) => `Bearer ${mintToken(id)}`;
  const check = (id: string) =>
    request(app.getHttpServer())
      .post('/api/hub/money/banks/name-check')
      .set('Authorization', auth(id))
      .send({ bankCode: GTB, accountNumber: NUMBER });

  beforeAll(async () => {
    await double.start();
    env.FINTAVA_BASE_URL = double.baseUrl;
    for (const [k, v] of Object.entries(env)) {
      previous[k] = process.env[k];
      process.env[k] = v;
    }
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PassportModule.register({ defaultStrategy: 'wawu-jwt' }),
        PrismaModule,
        MoneyModule,
      ],
      providers: [WawuJwtStrategy, WawuIdClient],
    })
      .overrideProvider(WawuIdClient)
      .useValue({ lookupPublicIdentities: () => Promise.resolve(new Map()) })
      .setLogger({ log: () => {}, error: () => {}, warn: () => {} })
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
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
    await app.listen(0, '127.0.0.1');
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

  it('20 parallel checks by one person with a 3 s provider: exactly 30 are allowed across the rounds, and another person is answered under 1 s meanwhile', async () => {
    double.on('GET', '/banks', {
      status: 200,
      body: {
        ...BANKS,
        data: [
          ...BANKS.data,
          { id: 'g', createdAt: 'x', updatedAt: 'x', code: GTB, name: 'GTB' },
        ],
      },
    });
    double.on('GET', '/name/enquiry', {
      status: 200,
      delayMs: PROVIDER_MS,
      body: {
        ...NAME_ENQUIRY,
        data: {
          ...NAME_ENQUIRY.data,
          account: {
            ...NAME_ENQUIRY.data.account,
            accountName: 'ADA SANDBOX',
          },
        },
      },
    });
    const ada = randomUUID();
    const other = randomUUID();
    users.push(ada, other);
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId: other,
        customerId: randomUUID(),
        walletId: randomUUID(),
        accountNumber: `17${String(Date.now()).slice(-8)}`,
      },
    });
    // Warm the bank list and the other person's route before timing.
    await request(app.getHttpServer())
      .get('/api/hub/money/banks')
      .set('Authorization', auth(other))
      .expect(200);

    const statuses: number[] = [];
    const slowest: number[] = [];
    for (let round = 0; round < 3; round += 1) {
      const calls = Promise.all(
        Array.from({ length: 20 }, async () => {
          const res = await check(ada);
          statuses.push(res.status);
          return res.status;
        }),
      );
      // While the round is in the provider's hands, another person's request.
      await new Promise((r) => setTimeout(r, 300));
      const t0 = Date.now();
      await request(app.getHttpServer())
        .get('/api/hub/money/beneficiaries')
        .set('Authorization', auth(other))
        .expect(200);
      slowest.push(Date.now() - t0);
      await calls;
    }
    expect(statuses).toHaveLength(60);
    expect(statuses.filter((s) => s === 200)).toHaveLength(30);
    expect(statuses.filter((s) => s === 429)).toHaveLength(30);
    expect(double.seen.filter((r) => r.path === '/name/enquiry')).toHaveLength(
      30,
    );
    expect(Math.max(...slowest)).toBeLessThan(1000);
    // Another person's own checks are untouched by Ada's 429s.
    expect((await check(other)).status).toBe(200);
  }, 60_000);
});
