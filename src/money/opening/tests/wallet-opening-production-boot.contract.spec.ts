import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication, LoggerService } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as jwt from 'jsonwebtoken';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { PrismaService as PrismaServiceType } from '../../../common/prisma/prisma.service';

/**
 * Opening the account (MONEY-12) on a production server that has no
 * FINTAVA_* settings and no IDENTITY_HASH_KEY yet (before OPS-10): the
 * whole AppModule boots, the open answers 503 and sends nothing anywhere,
 * GET /money/wallet still answers from our own tables, and the sweep the
 * ScheduleModule runs does nothing.
 */

const FINTAVA_KEYS = [
  'FINTAVA_BASE_URL',
  'FINTAVA_API_KEY',
  'FINTAVA_WEBHOOK_SECRET',
  'FINTAVA_TIMEOUT_MS',
  'FINTAVA_MONEY_TIMEOUT_MS',
  'FINTAVA_CHECK_TIMEOUT_MS',
  'FINTAVA_RESEND_SAFETY_MS',
];
const PRODUCTION_ENV: Record<string, string> = {
  NODE_ENV: 'production',
  WAWU_ID_INTERNAL_SERVICE_KEY: 'm12-boot-check-service-key',
  FLUTTERWAVE_SECRET_KEY: 'FLWSECK_TEST-m12-boot-check-X',
  FLUTTERWAVE_PUBLIC_KEY: 'FLWPUBK_TEST-m12-boot-check-X',
  FLUTTERWAVE_WEBHOOK_HASH: 'm12-boot-check-hash',
  IDENTITY_HASH_KEY: '',
  BVN_CHECKS_PER_DAY: '',
  SELFIE_CHECKS_PER_DAY: '',
  ...Object.fromEntries(FINTAVA_KEYS.map((k) => [k, ''])),
};

class CapturingLogger implements LoggerService {
  lines: string[] = [];
  private push(args: unknown[]) {
    this.lines.push(args.map(String).join(' '));
  }
  log(...a: unknown[]) {
    this.push(a);
  }
  error(...a: unknown[]) {
    this.push(a);
  }
  warn(...a: unknown[]) {
    this.push(a);
  }
  debug(...a: unknown[]) {
    this.push(a);
  }
  verbose(...a: unknown[]) {
    this.push(a);
  }
  fatal(...a: unknown[]) {
    this.push(a);
  }
}

function mintToken(sub: string): string {
  const privateKey = readFileSync(
    join(__dirname, '../../../../mock-wawu-id/private.pem'),
    'utf8',
  );
  return jwt.sign(
    {
      sub,
      email: `open-boot-${sub}@test.wawu.dev`,
      phone: '+2348031234412',
      firstName: 'Boot',
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

describe('production boot without Fintava settings or the identity key: account opening (MONEY-12)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaServiceType;
  let sweep: () => Promise<Record<string, number>>;
  const logger = new CapturingLogger();
  const previous: Record<string, string | undefined> = {};
  const users: string[] = [];
  const fetched: string[] = [];
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    for (const [k, v] of Object.entries(PRODUCTION_ENV)) {
      previous[k] = process.env[k];
      process.env[k] = v;
    }
    globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
      fetched.push(
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      return realFetch(input, init);
    };
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { AppModule } =
      require('../../../app.module') as typeof import('../../../app.module');
    const { PrismaService } =
      require('../../../common/prisma/prisma.service') as typeof import('../../../common/prisma/prisma.service');
    const { AllExceptionsFilter } =
      require('../../../common/filters/all-exceptions.filter') as typeof import('../../../common/filters/all-exceptions.filter');
    const { ResponseInterceptor } =
      require('../../../common/interceptors/response.interceptor') as typeof import('../../../common/interceptors/response.interceptor');
    const { WalletOpeningService } =
      require('../wallet-opening.service') as typeof import('../wallet-opening.service');
    /* eslint-enable @typescript-eslint/no-require-imports */
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .setLogger(logger)
      .compile();
    app = moduleRef.createNestApplication<INestApplication<App>>({ logger });
    app.useLogger(logger);
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
    const opening = moduleRef.get(WalletOpeningService);
    sweep = () => opening.sweep();
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.fintavaWalletOpening.deleteMany({
        where: { wawuUserId: { in: users } },
      });
    }
    if (app) await app.close();
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const who = () => {
    const id = randomUUID();
    users.push(id);
    return id;
  };

  it('the open answers 503 provider_unreachable, sends nothing and writes nothing', async () => {
    const id = who();
    const res = await request(app.getHttpServer())
      .post('/api/hub/money/wallet/open')
      .set('Authorization', `Bearer ${mintToken(id)}`)
      .send({
        bvn: '22290000999',
        nin: '70290000999',
        firstName: 'Boot',
        lastName: 'Check',
        dateOfBirth: '1990-01-15',
        address: '2 Boot Street, Yaba, Lagos',
      })
      .expect(503);
    expect((res.body as { reason: { code: string } }).reason.code).toBe(
      'provider_unreachable',
    );
    expect(fetched.filter((u) => /fintava/i.test(u))).toEqual([]);
    expect(
      await prisma.fintavaWalletOpening.findUnique({
        where: { wawuUserId: id },
      }),
    ).toBeNull();
  });

  it('GET /money/wallet still answers, from our own tables', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/hub/money/wallet')
      .set('Authorization', `Bearer ${mintToken(who())}`)
      .expect(200);
    expect((res.body as { data: { state: string } }).data.state).toBe(
      'not_open',
    );
  });

  it('the sweep does nothing and sends nothing, even with a lost answer waiting', async () => {
    const id = who();
    await prisma.fintavaWalletOpening.create({
      data: {
        wawuUserId: id,
        state: 'unknown',
        bvnHash: `m12-boot-${id}`,
        bvnVerifiedAt: new Date(),
        phone: `+23480${String(Date.now()).slice(-8)}`,
        attemptStartedAt: new Date(Date.now() - 3_600_000),
      },
    });
    const counts = await sweep();
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
    expect(fetched.filter((u) => /fintava/i.test(u))).toEqual([]);
    expect(
      (await prisma.fintavaWalletOpening.findUnique({
        where: { wawuUserId: id },
      }))!.state,
    ).toBe('unknown');
  });
});
