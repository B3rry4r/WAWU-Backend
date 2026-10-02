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
import type { FintavaClient as FintavaClientType } from '../../../fintava/fintava-client';

/**
 * The live server keeps starting before Fintava is set up on it (MONEY-11,
 * rule 6). Backend main deploys on merge and OPS-10 adds the live Fintava
 * settings later, so the whole AppModule must boot with NODE_ENV=production
 * and no FINTAVA_* value at all: health answers, the balance route answers
 * 503 (W6, never a 0), one warning names the missing setting, and nothing is
 * sent to Fintava.
 *
 * The other settings production insists on (WAWU ID's service key, a real
 * Flutterwave key) get stand-in values here, as the droplet has real ones:
 * this spec is about Fintava's being absent, nothing else. Each FINTAVA_*
 * is set to '' rather than deleted so a local .env cannot fill it in
 * (dotenv never overwrites a variable that exists); '' and unset are read
 * the same.
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
  WAWU_ID_INTERNAL_SERVICE_KEY: 'm11-boot-check-service-key',
  FLUTTERWAVE_SECRET_KEY: 'FLWSECK_TEST-m11-boot-check-X',
  FLUTTERWAVE_PUBLIC_KEY: 'FLWPUBK_TEST-m11-boot-check-X',
  FLUTTERWAVE_WEBHOOK_HASH: 'm11-boot-check-hash',
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
      phone: '+2348000009997',
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

describe('production boot without Fintava settings (MONEY-11)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaServiceType;
  let fintava: FintavaClientType;
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
    // Record every outbound URL; the WAWU ID JWKS is the only one expected.
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

    // Loaded after the environment is in place: some modules read it when
    // their file is first evaluated. Nothing above imports them.
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { AppModule } =
      require('../../../app.module') as typeof import('../../../app.module');
    const classes = {
      PrismaService: (
        require('../../../common/prisma/prisma.service') as typeof import('../../../common/prisma/prisma.service')
      ).PrismaService,
      FintavaClient: (
        require('../../../fintava/fintava-client') as typeof import('../../../fintava/fintava-client')
      ).FintavaClient,
    };
    /* eslint-enable @typescript-eslint/no-require-imports */
    const { AllExceptionsFilter } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../../../common/filters/all-exceptions.filter') as typeof import('../../../common/filters/all-exceptions.filter');
    const { ResponseInterceptor } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../../../common/interceptors/response.interceptor') as typeof import('../../../common/interceptors/response.interceptor');

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
    prisma = moduleRef.get(classes.PrismaService);
    fintava = moduleRef.get(classes.FintavaClient);
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.fintavaWallet.deleteMany({
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

  it('the app boots and health answers 200', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/hub/health')
      .expect(200);
    expect(res.body).toMatchObject({
      data: { ok: true, service: 'wawu-hub-api' },
    });
  });

  it('the Fintava client is unconfigured and said so once, with no secret', () => {
    expect(fintava.environment).toBe('unconfigured');
    const warnings = logger.lines.filter((l) =>
      l.includes('Fintava is not configured on this server'),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('FINTAVA_BASE_URL is not set');
  });

  it('a user with a wallet gets 503 provider_unreachable, never a 0, and nothing goes to Fintava', async () => {
    const id = randomUUID();
    users.push(id);
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId: id,
        customerId: randomUUID(),
        walletId: randomUUID(),
        accountNumber: `19${String(Date.now()).slice(-8)}`,
      },
    });
    const res = await request(app.getHttpServer())
      .get('/api/hub/money/wallet/balance')
      .set('Authorization', `Bearer ${mintToken(id)}`)
      .expect(503);
    expect(res.body).toEqual({
      statusCode: 503,
      message:
        'We could not reach your account. Your money is safe. Try again in a moment.',
      data: null,
      reason: {
        code: 'provider_unreachable',
        message:
          'We could not reach your account. Your money is safe. Try again in a moment.',
        retryAfterSeconds: 30,
      },
    });
    expect(fetched.filter((u) => /fintava/i.test(u))).toEqual([]);
  });

  it('a key set without a base URL is dropped, not sent anywhere', async () => {
    process.env.FINTAVA_API_KEY = 'live_m11_boot_check_key_never_sent';
    try {
      const { FintavaClient } =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('../../../fintava/fintava-client') as typeof import('../../../fintava/fintava-client');
      const { ConfigService } =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('@nestjs/config') as typeof import('@nestjs/config');
      const client = new FintavaClient(new ConfigService());
      expect(client.environment).toBe('unconfigured');
      const before = fetched.length;
      await expect(client.getWalletBalance(randomUUID())).rejects.toMatchObject(
        { kind: 'not_configured' },
      );
      expect(fetched.length).toBe(before);
    } finally {
      process.env.FINTAVA_API_KEY = '';
    }
  });

  it('a set but wrong FINTAVA_BASE_URL still stops the client at boot (MONEY-06 host lock)', () => {
    const { FintavaClient } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../../../fintava/fintava-client') as typeof import('../../../fintava/fintava-client');
    const { FintavaConfigError } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../../../fintava/fintava-config') as typeof import('../../../fintava/fintava-config');
    for (const url of [
      'https://evil.example.com/api/dev',
      'https://dev.fintavapay.com.evil.com/api/dev',
      'http://127.0.0.1:9/api/dev',
    ]) {
      const config = {
        get: (k: string) => (k === 'FINTAVA_BASE_URL' ? url : undefined),
      } as never;
      expect(() => new FintavaClient(config)).toThrow(FintavaConfigError);
    }
  });
});
