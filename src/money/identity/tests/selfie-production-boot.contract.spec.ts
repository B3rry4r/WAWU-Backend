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
import { jpegImage } from '../../../../test/fixtures/selfie/selfie-images';

/**
 * The live server keeps starting with the selfie match in it before Fintava
 * and the identity key are set up there (task KYC-02, rule 6): the whole
 * AppModule boots with NODE_ENV=production, no FINTAVA_* value and no
 * IDENTITY_HASH_KEY. The selfie match answers a typed 503 (never a 500,
 * never a call out, nothing counted), as the BVN check does, and the selfie
 * read still answers from our own table. The other settings production
 * insists on get stand-in values, as in
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
  WAWU_ID_INTERNAL_SERVICE_KEY: 'k02-boot-check-service-key',
  FLUTTERWAVE_SECRET_KEY: 'FLWSECK_TEST-k02-boot-check-X',
  FLUTTERWAVE_PUBLIC_KEY: 'FLWPUBK_TEST-k02-boot-check-X',
  FLUTTERWAVE_WEBHOOK_HASH: 'k02-boot-check-hash',
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
      email: `selfie-boot-${sub}@test.wawu.dev`,
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

describe('production boot without Fintava settings or the identity key: the selfie match (KYC-02)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaServiceType;
  const logger = new CapturingLogger();
  const previous: Record<string, string | undefined> = {};
  const users: string[] = [];
  const fetched: string[] = [];
  const realFetch = globalThis.fetch;
  // A real JPEG (Pillow-made, test/fixtures/selfie): the route walks it.
  const IMAGE = jpegImage().toString('base64');

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
      await prisma.selfieMatchAttempt.deleteMany({
        where: { wawuUserId: { in: users } },
      });
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

  function who(): string {
    const id = randomUUID();
    users.push(id);
    return id;
  }

  it('boots, and health answers 200', async () => {
    await request(app.getHttpServer()).get('/api/hub/health').expect(200);
  });

  it('the selfie match answers 503 provider_unreachable, counts nothing, and sends nothing to Fintava', async () => {
    const id = who();
    const res = await request(app.getHttpServer())
      .post('/api/hub/money/identity/selfie')
      .set('Authorization', `Bearer ${mintToken(id)}`)
      .send({ bvn: '22290000999', image: IMAGE })
      .expect(503);
    expect(res.body).toEqual({
      statusCode: 503,
      message:
        'We could not check your selfie right now. Try again in a moment.',
      data: null,
      reason: {
        code: 'provider_unreachable',
        message:
          'We could not check your selfie right now. Try again in a moment.',
        retryAfterSeconds: 30,
      },
    });
    expect(fetched.filter((u) => /fintava/i.test(u))).toEqual([]);
    expect(
      await prisma.selfieMatchAttempt.count({ where: { wawuUserId: id } }),
    ).toBe(0);
    const lines = logger.lines.join('\n');
    expect(lines).not.toContain('22290000999');
    expect(lines).not.toContain(IMAGE.slice(0, 40));
  });

  it('the BVN check before it answers 503 too, with nothing sent', async () => {
    const id = who();
    await request(app.getHttpServer())
      .post('/api/hub/money/identity/bvn')
      .set('Authorization', `Bearer ${mintToken(id)}`)
      .send({ bvn: '22290000999', nin: '70290000999' })
      .expect(503);
    expect(fetched.filter((u) => /fintava/i.test(u))).toEqual([]);
  });

  it('the selfie read still answers, from our own table', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/hub/money/identity/selfie')
      .set('Authorization', `Bearer ${mintToken(who())}`)
      .expect(200);
    expect((res.body as { data: unknown }).data).toEqual({
      matchedAt: null,
      checksLeft: 3,
    });
  });

  it('one warning each for Fintava and the identity key, and neither prints a secret', () => {
    expect(
      logger.lines.filter((l) => l.includes('Fintava is not configured')),
    ).toHaveLength(1);
    expect(
      logger.lines.filter((l) =>
        l.includes(
          'IDENTITY_HASH_KEY is not set: the BVN check and the selfie match answer 503',
        ),
      ),
    ).toHaveLength(1);
  });
});
