import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  INestApplication,
  LoggerService,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import * as jwt from 'jsonwebtoken';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { WawuIdClient } from '../../../common/auth/wawu-id.client';
import { WawuJwtStrategy } from '../../../common/auth/wawu-jwt.strategy';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../../wallet-provider/wallet-provider.interface';
import type { MoneyErrorReason } from '../../dto/money-error.dto';
import { MoneyModule } from '../../money.module';
import type { FeeQuoteView } from '../../money-view.type';
import { FEE_CONFIG_KEYS } from '../fee-config';
import { FEES_NOT_SET_MESSAGE } from '../fees-not-set';
import { NUVION_FEE_CONFIG_KEYS } from '../nuvion-fee-config';

/**
 * Fees as settings over HTTP (task NUV-07, R-42): the real MoneyModule, a
 * real database for the wallet gate, real RS256 tokens checked against the
 * stand-in WAWU ID's JWKS (WAWU_ID_JWKS_URL), and Nuvion stood in at the
 * seam: WALLET_PROVIDER is a Nuvion stand-in that records every call made
 * to it and answers only a balance read. Nothing here reaches a Nuvion,
 * Fintava or wawuafrica.com host.
 *
 * Two servers: one with no Nuvion fee setting (what production runs until
 * the owner fills them in), one with the spec's own figures.
 */

const BASE = '/api/hub/money';
const K = NUVION_FEE_CONFIG_KEYS;
const SET = {
  [K.bookTransfer]: '1234',
  [K.bankPayout]: '0:3100,500000:4200',
  [K.inflow]: '0',
};

function mintToken(sub: string): string {
  const privateKey = readFileSync(
    join(__dirname, '../../../../mock-wawu-id/private.pem'),
    'utf8',
  );
  return jwt.sign(
    {
      sub,
      email: `nuv07-${sub}@test.wawu.dev`,
      phone: '+2348000009997',
      firstName: 'Nuvion',
      lastName: 'Tester',
      country: 'Nigeria',
      verificationTier: 'basic',
      trustScore: 0,
      status: 'active',
    },
    privateKey,
    { algorithm: 'RS256', keyid: 'mock-wawu-id-key-1', expiresIn: '15m' },
  );
}

class QuietLogger implements LoggerService {
  log() {}
  error() {}
  warn() {}
  debug() {}
  verbose() {}
  fatal() {}
}

type Envelope<T> = {
  statusCode: number;
  message: string | string[];
  data: T | null;
  reason?: MoneyErrorReason;
};
const body = <T>(res: Response): Envelope<T> => res.body as Envelope<T>;

/**
 * Nuvion at the seam: `name` is all a quote reads. Every method records its
 * call; only the balance answers (a read the fees must never block), every
 * other one rejects, so reaching it fails the spec loudly.
 */
function nuvionStandIn(): { provider: WalletProvider; calls: string[] } {
  const calls: string[] = [];
  const refuse = (name: string) => (): Promise<never> => {
    calls.push(name);
    return Promise.reject(new Error(`the Nuvion stand-in was asked ${name}`));
  };
  const provider: WalletProvider = {
    name: 'nuvion',
    label: 'Nuvion',
    configured: true,
    walletBankCode: 'nuvion_ban',
    timings: {
      readTimeoutMs: 1,
      moneyTimeoutMs: 1,
      checkTimeoutMs: 1,
      resendSafetyMs: 1,
      retryAfterSeconds: 1,
    },
    capabilities: {
      selfieMatch: false,
      hostedLiveness: false,
      separateKyc: true,
      asyncAccountNumber: true,
      identityLookup: false,
    },
    deliveries: {
      ledgerEvents: [],
      read: () => ({ kind: 'unreadable', why: 'stand-in' }),
    },
    getBalance: () => {
      calls.push('getBalance');
      return Promise.resolve({
        availableKobo: 4_321_000n,
        bookedKobo: 4_321_000n,
      });
    },
    checkIdentity: refuse('checkIdentity'),
    matchSelfie: refuse('matchSelfie'),
    startLivenessSession: refuse('startLivenessSession'),
    getLivenessResult: refuse('getLivenessResult'),
    submitKyc: refuse('submitKyc'),
    openWallet: refuse('openWallet'),
    getWalletAccount: refuse('getWalletAccount'),
    findCustomerByPhone: refuse('findCustomerByPhone'),
    getCustomerMatch: refuse('getCustomerMatch'),
    listCustomerSightings: refuse('listCustomerSightings'),
    getPlatformAccount: refuse('getPlatformAccount'),
    listBanks: refuse('listBanks'),
    checkAccountName: refuse('checkAccountName'),
    bankTransfer: refuse('bankTransfer'),
    walletToWallet: refuse('walletToWallet'),
    findTransactionByReference: refuse('findTransactionByReference'),
    findTransactionById: refuse('findTransactionById'),
    listTransactions: refuse('listTransactions'),
    reconcileSend: refuse('reconcileSend'),
    decideRetry: () => {
      calls.push('decideRetry');
      throw new Error('the Nuvion stand-in was asked decideRetry');
    },
    confirmMovement: refuse('confirmMovement'),
    secondaryReferenceOf: refuse('secondaryReferenceOf'),
  };
  return { provider, calls };
}

let accountSeq = 0;
function nuban(): string {
  accountSeq += 1;
  return `7${String(Date.now()).slice(-6)}${String(accountSeq).padStart(3, '0')}`;
}

/**
 * Boots the money routes with these Nuvion settings. The server reads them
 * once, while it starts, from its environment (as production does from
 * /etc/wawu/hub-api.env), so they are in process.env only while it boots:
 * the next server in this file starts without them.
 */
async function boot(
  env: Record<string, string>,
  provider: WalletProvider,
): Promise<INestApplication<App>> {
  for (const key of Object.values(K)) delete process.env[key];
  Object.assign(process.env, env);
  try {
    return await bootApp(provider);
  } finally {
    for (const key of Object.values(K)) delete process.env[key];
  }
}

async function bootApp(
  provider: WalletProvider,
): Promise<INestApplication<App>> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [
          () => ({
            [FEE_CONFIG_KEYS.merchantMaxPerTxn]: '1000000000',
            [FEE_CONFIG_KEYS.quoteKey]: 'nuv07-contract-spec-key-'.padEnd(
              40,
              'x',
            ),
          }),
        ],
      }),
      PassportModule.register({ defaultStrategy: 'wawu-jwt' }),
      PrismaModule,
      MoneyModule,
    ],
    providers: [WawuJwtStrategy, WawuIdClient],
  })
    .overrideProvider(WALLET_PROVIDER)
    .useValue(provider)
    .compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>({
    logger: new QuietLogger(),
  });
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
  return app;
}

describe('NUV-07: fees as settings over HTTP, Nuvion stood in at WALLET_PROVIDER', () => {
  const unset = nuvionStandIn();
  const filled = nuvionStandIn();
  let appUnset: INestApplication<App>;
  let appSet: INestApplication<App>;
  let prisma: PrismaService;
  const users: string[] = [];

  type Person = { id: string; auth: string };

  async function withWallet(): Promise<Person> {
    const id = randomUUID();
    users.push(id);
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId: id,
        customerId: randomUUID(),
        walletId: randomUUID(),
        accountNumber: nuban(),
        accountName: null,
        // A wallet Nuvion holds: since NUV-01 a server acts only on rows of
        // the provider it runs, and a row without one is Fintava's.
        provider: 'nuvion',
      },
    });
    return { id, auth: `Bearer ${mintToken(id)}` };
  }

  function get(
    app: INestApplication<App>,
    auth: string | undefined,
    path: string,
  ) {
    const req = request(app.getHttpServer()).get(`${BASE}/${path}`);
    return auth ? req.set('Authorization', auth) : req;
  }

  beforeAll(async () => {
    appUnset = await boot({}, unset.provider);
    appSet = await boot(SET, filled.provider);
    prisma = appUnset.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.fintavaWallet.deleteMany({
      where: { wawuUserId: { in: users } },
    });
    await appUnset.close();
    await appSet.close();
  });

  describe('no Nuvion fee setting (production until the owner fills them in)', () => {
    it('every quote, of every kind, answers 503 fees_not_set, and Nuvion receives no call', async () => {
      const a = await withWallet();
      unset.calls.length = 0;
      for (const q of [
        'kind=wawu_transfer&amountKobo=1000000',
        'kind=bank_transfer&amountKobo=1000000',
        'kind=purchase&amountKobo=500000',
        'kind=bill&billCategory=electricity&amountKobo=1000000',
        // Before the query is read: a malformed one is refused the same way.
        'kind=nonsense&amountKobo=-4',
      ]) {
        const res = await get(appUnset, a.auth, `fees/quote?${q}`);
        expect([q, res.status]).toEqual([q, 503]);
        expect(body(res).reason).toEqual({
          code: 'fees_not_set',
          message: FEES_NOT_SET_MESSAGE,
        });
        expect(body(res).message).toBe(FEES_NOT_SET_MESSAGE);
        expect(body(res).data).toBeNull();
      }
      expect(unset.calls).toEqual([]);
    });

    it('also for a person with no wallet: nothing is quoted to anyone', async () => {
      const id = randomUUID();
      const res = await get(
        appUnset,
        `Bearer ${mintToken(id)}`,
        'fees/quote?kind=purchase&amountKobo=100',
      );
      expect(res.status).toBe(503);
      expect(body(res).reason?.code).toBe('fees_not_set');
    });

    it('without a token it is still 401 (the token is checked first)', async () => {
      await get(
        appUnset,
        undefined,
        'fees/quote?kind=purchase&amountKobo=100',
      ).expect(401);
    });

    it('read-only routes are unaffected: the balance (from Nuvion), the history and the account number answer 200', async () => {
      const a = await withWallet();
      unset.calls.length = 0;
      const balance = await get(appUnset, a.auth, 'wallet/balance').expect(200);
      expect(body<{ availableKobo: number }>(balance).data!.availableKobo).toBe(
        4_321_000,
      );
      expect(unset.calls).toEqual(['getBalance']);
      const history = await get(appUnset, a.auth, 'transactions').expect(200);
      expect(body<{ items: unknown[] }>(history).data!.items).toEqual([]);
      const wallet = await get(appUnset, a.auth, 'wallet').expect(200);
      const view = body<{
        state: string;
        account: { accountNumber: string } | null;
      }>(wallet).data!;
      expect(view.state).toBe('open');
      expect(view.account?.accountNumber).toMatch(/^\d{10}$/);
      // Only the balance read reached the stand-in.
      expect(unset.calls).toEqual(['getBalance']);
    });
  });

  describe('the Nuvion fee settings filled in (the spec’s own figures)', () => {
    it("a quote shows Nuvion's charge and WAWU's fee, adding up to one Fees row, and asks Nuvion nothing", async () => {
      const a = await withWallet();
      filled.calls.length = 0;
      const res = await get(
        appSet,
        a.auth,
        'fees/quote?kind=wawu_transfer&amountKobo=2000000',
      ).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const v = body<FeeQuoteView>(res).data!;
      expect(v).toMatchObject({
        kind: 'wawu_transfer',
        billCategory: null,
        amountKobo: 2_000_000,
        parts: [
          { code: 'balance_transfer', source: 'provider', amountKobo: 1234 },
          { code: 'wawu_fee', source: 'wawu', amountKobo: 1000 },
        ],
        fee: { providerFeeKobo: 1234, wawuFeeKobo: 1000, totalFeeKobo: 2234 },
        totalKobo: 2_002_234,
        withinDailyLimit: true,
        remainingTodayKobo: null,
      });

      const bank = body<FeeQuoteView>(
        await get(
          appSet,
          a.auth,
          'fees/quote?kind=bank_transfer&amountKobo=500000',
        ).expect(200),
      ).data!;
      expect(bank.parts).toEqual([
        { code: 'bank_transfer', source: 'provider', amountKobo: 4200 },
        { code: 'wawu_fee', source: 'wawu', amountKobo: 2500 },
      ]);
      expect(bank.totalKobo).toBe(500_000 + 6700);
      expect(filled.calls).toEqual([]);
    });

    it('a bill is 409 target_not_payable under Nuvion (no bill payments); the gate still answers a person with no wallet', async () => {
      const a = await withWallet();
      const res = await get(
        appSet,
        a.auth,
        'fees/quote?kind=bill&billCategory=airtime&amountKobo=10000',
      ).expect(409);
      expect(body(res).reason).toEqual({
        code: 'target_not_payable',
        message: 'Bills cannot be paid right now.',
      });
      const none = await get(
        appSet,
        `Bearer ${mintToken(randomUUID())}`,
        'fees/quote?kind=purchase&amountKobo=100',
      ).expect(409);
      expect(body(none).reason?.code).toBe('wallet_not_open');
      expect(filled.calls).toEqual([]);
    });
  });
});
