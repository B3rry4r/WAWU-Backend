import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type INestApplication,
  type LoggerService,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { Test, type TestingModule } from '@nestjs/testing';
import * as jwt from 'jsonwebtoken';
import { WawuIdClient } from '../../src/common/auth/wawu-id.client';
import { WawuJwtStrategy } from '../../src/common/auth/wawu-jwt.strategy';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../src/common/interceptors/response.interceptor';
import { PrismaModule } from '../../src/common/prisma/prisma.module';
import { HUB_APP_OPTIONS } from '../../src/hub-app-options';
import { MoneyError } from '../../src/money/money-error';
import { MoneyModule } from '../../src/money/money.module';
import { PayableRegistry } from '../../src/money/payments/payable-registry';
import { WALLET_PROVIDER } from '../../src/wallet-provider/wallet-provider.interface';

/**
 * What PAY-FX's two runs share: the Hub's real MoneyModule over a real
 * database with `WALLET_PROVIDER` given whichever provider the run uses (the
 * contract spec's stand-in, or the real Nuvion adapter in the dev check),
 * real RS256 tokens checked against the stand-in WAWU ID's keys, and the
 * item kinds a payment is made for. No Fintava or wawuafrica.com host is
 * called.
 */

export function mintToken(sub: string): string {
  const privateKey = readFileSync(
    join(__dirname, '../../mock-wawu-id/private.pem'),
    'utf8',
  );
  return jwt.sign(
    {
      sub,
      email: `pfx-${sub}@test.wawu.dev`,
      phone: '+2348000009918',
      firstName: 'Pay',
      lastName: 'Fx',
      country: 'Nigeria',
      verificationTier: 'basic',
      trustScore: 0,
      status: 'active',
    },
    privateKey,
    { algorithm: 'RS256', keyid: 'mock-wawu-id-key-1', expiresIn: '30m' },
  );
}

export class QuietLogger implements LoggerService {
  lines: string[] = [];
  log(...a: unknown[]) {
    this.lines.push(a.map(String).join(' '));
  }
  error(...a: unknown[]) {
    this.lines.push(a.map(String).join(' '));
  }
  warn(...a: unknown[]) {
    this.lines.push(a.map(String).join(' '));
  }
  debug() {}
  verbose() {}
  fatal(...a: unknown[]) {
    this.lines.push(a.map(String).join(' '));
  }
}

/** Fee settings the owner fills in (NUV-10); spec values, kobo by band. */
export const PFX_ENV: Record<string, string> = {
  FINTAVA_BASE_URL: 'http://127.0.0.1:9',
  FINTAVA_API_KEY: 'live_test_pfx_0123456789FAKEKEY',
  FEE_QUOTE_KEY: 'pfx-fee-quote-key-0123456789abcdef0123456789',
  MERCHANT_MAX_PER_TXN_KOBO: '1000000000',
  NUVION_FEE_BOOK_TRANSFER: '0:0',
  NUVION_FEE_BANK_PAYOUT: '0:0',
  NUVION_FEE_INFLOW: '0:0',
  PIN_LOCK_MINUTES: '',
  IDEMPOTENCY_KEY_HOURS: '',
  PAYMENT_REVIEW_AFTER_HOURS: '',
};

export interface PfxApp {
  app: INestApplication;
  moduleRef: TestingModule;
  logger: QuietLogger;
  restoreEnv: () => void;
}

/** Boots the Hub's money module on `provider`. */
export async function bootPfxApp(
  provider: unknown,
  extraEnv: Record<string, string> = {},
): Promise<PfxApp> {
  const previous: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries({ ...PFX_ENV, ...extraEnv })) {
    previous[k] = process.env[k];
    process.env[k] = v;
  }
  const logger = new QuietLogger();
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      PassportModule.register({ defaultStrategy: 'wawu-jwt' }),
      PrismaModule,
      MoneyModule,
    ],
    providers: [WawuJwtStrategy, WawuIdClient],
  })
    .overrideProvider(WALLET_PROVIDER)
    .useValue(provider)
    .setLogger(logger)
    .compile();
  const app = moduleRef.createNestApplication({ ...HUB_APP_OPTIONS, logger });
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
  await app.listen(0, '127.0.0.1');
  return {
    app,
    moduleRef,
    logger,
    restoreEnv: () => {
      for (const [k, v] of Object.entries(previous)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

export const PFX_CREATOR = {
  wawuUserId: randomUUID(),
  displayName: 'Chimamanda Adichie',
  handle: 'chimamanda',
  avatarUrl: null,
  tick: 'creator' as const,
};

/**
 * The item kinds a payment is made for: a piece (`content_unlock`) priced
 * `priceKobo`, and a ticket (`event_ticket`, a held kind: its price waits in
 * WAWU's account until released or refunded). Ids start with `n-`.
 */
export function registerPfxItems(
  registry: PayableRegistry,
  priceKobo: number,
  delivered: Array<{ paymentId: string; kind: string; targetId: string }>,
  owned: Set<string>,
): void {
  for (const kind of ['content_unlock', 'event_ticket'] as const) {
    registry.register({
      kind,
      resolve: async ({ targetId, payerWawuUserId }) => {
        await Promise.resolve();
        if (owned.has(`${payerWawuUserId}:${targetId}`)) {
          throw new MoneyError('target_not_payable', 'You already own this.');
        }
        if (!targetId.startsWith('n-')) {
          throw new MoneyError('target_not_found', 'That piece is gone.');
        }
        return {
          title: `Item ${targetId}`,
          priceKobo,
          payee: PFX_CREATOR,
        };
      },
      onCompleted: async (p) => {
        await Promise.resolve();
        owned.add(`${p.payerWawuUserId}:${p.targetId}`);
        delivered.push(p);
      },
    });
  }
}
