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
 * The live server keeps starting with the BVN check in it before Fintava is
 * set up there (task KYC-01, rule 6, as MONEY-11 holds for the balance): the
 * whole AppModule boots with NODE_ENV=production and no FINTAVA_* value, the
 * BVN check answers a typed 503 (never a 500, never a call out), and the
 * identity read still answers from our own table.
 *
 * IDENTITY_HASH_KEY is set here so the Fintava branch is the one exercised;
 * the server without that key is covered in money-identity.contract.spec.ts.
 * The other settings production insists on get stand-in values, as in
 * src/money/balance/tests/production-boot.contract.spec.ts.
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
  WAWU_ID_INTERNAL_SERVICE_KEY: 'k01-boot-check-service-key',
  FLUTTERWAVE_SECRET_KEY: 'FLWSECK_TEST-k01-boot-check-X',
  FLUTTERWAVE_PUBLIC_KEY: 'FLWPUBK_TEST-k01-boot-check-X',
  FLUTTERWAVE_WEBHOOK_HASH: 'k01-boot-check-hash',
  IDENTITY_HASH_KEY: 'k01-boot-identity-hash-key-0123456789abcdef',
  BVN_CHECKS_PER_DAY: '',
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
      email: `boot-${sub}@test.wawu.dev`,
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

describe('production boot without Fintava settings: the BVN check (KYC-01)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaServiceType;
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
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.bvnCheckAttempt.deleteMany({
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

  it('boots, and health answers 200', async () => {
    await request(app.getHttpServer()).get('/api/hub/health').expect(200);
  });

  it('the BVN check answers 503 provider_unreachable, counts nothing, and sends nothing to Fintava', async () => {
    const id = randomUUID();
    users.push(id);
    const res = await request(app.getHttpServer())
      .post('/api/hub/money/identity/bvn')
      .set('Authorization', `Bearer ${mintToken(id)}`)
      .send({ bvn: '22190000999', nin: '70190000999' })
      .expect(503);
    expect(res.body).toEqual({
      statusCode: 503,
      message: 'We could not check your BVN right now. Try again in a moment.',
      data: null,
      reason: {
        code: 'provider_unreachable',
        message:
          'We could not check your BVN right now. Try again in a moment.',
        retryAfterSeconds: 30,
      },
    });
    expect(fetched.filter((u) => /fintava/i.test(u))).toEqual([]);
    expect(
      await prisma.bvnCheckAttempt.count({ where: { wawuUserId: id } }),
    ).toBe(0);
    // The BVN reached no log line either.
    expect(logger.lines.join('\n')).not.toContain('22190000999');
  });

  it('the identity read still answers, from our own table', async () => {
    const id = randomUUID();
    users.push(id);
    const res = await request(app.getHttpServer())
      .get('/api/hub/money/identity')
      .set('Authorization', `Bearer ${mintToken(id)}`)
      .expect(200);
    expect((res.body as { data: unknown }).data).toEqual({
      bvn: null,
      ninLast4: null,
      occupation: null,
      checksLeft: 3,
    });
  });

  it('only Fintava’s own warning is logged; the identity key is set, so it is silent', () => {
    expect(
      logger.lines.filter((l) => l.includes('Fintava is not configured')),
    ).toHaveLength(1);
    expect(
      logger.lines.filter((l) => l.includes('IDENTITY_HASH_KEY')),
    ).toHaveLength(0);
  });
});
