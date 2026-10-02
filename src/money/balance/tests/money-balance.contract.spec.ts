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
import {
  FintavaDouble,
  fintavaError,
  WALLET_BALANCE,
} from '../../../../test/fintava/fintava-double';
import { WawuIdClient } from '../../../common/auth/wawu-id.client';
import { WawuJwtStrategy } from '../../../common/auth/wawu-jwt.strategy';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { FINTAVA_DEFAULTS } from '../../../fintava/fintava-config';
import type { MoneyErrorReason } from '../../dto/money-error.dto';
import { MoneyModule } from '../../money.module';
import type { WalletBalanceView } from '../../money-view.type';

/**
 * GET /money/wallet/balance over HTTP (task MONEY-11): the real app module,
 * a real database, real RS256 tokens checked against the mock WAWU ID's
 * JWKS (WAWU_ID_JWKS_URL), and the real MONEY-06 Fintava client talking over
 * a socket to the local double that answers with the bodies the sandbox sent
 * (test/fintava/fintava-double.ts). Each test signs in as a brand-new
 * wawuUserId with brand-new wallet ids, so it owns its rows; afterAll
 * deletes them.
 */

const BASE = '/api/hub/money/wallet/balance';
const KEY = 'live_test_balance_0123456789FAKEKEY';
const READ_TIMEOUT_MS = 300;

const FINTAVA_ENV = {
  FINTAVA_BASE_URL: '',
  FINTAVA_API_KEY: KEY,
  FINTAVA_TIMEOUT_MS: String(READ_TIMEOUT_MS),
} as Record<string, string>;

function mintToken(sub: string): string {
  const privateKey = readFileSync(
    join(__dirname, '../../../../mock-wawu-id/private.pem'),
    'utf8',
  );
  return jwt.sign(
    {
      sub,
      email: `balance-${sub}@test.wawu.dev`,
      phone: '+2348000009998',
      firstName: 'Balance',
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

/** Keeps the app's own log lines out of the test output. */
class QuietLogger implements LoggerService {
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

type Envelope = {
  statusCode: number;
  message: string;
  data: WalletBalanceView | null;
  reason?: MoneyErrorReason;
};
const envelope = (res: Response): Envelope => res.body as Envelope;

/** A balance answer exactly as the sandbox sends it, with these figures. */
function balanceBody(available: unknown, booked: unknown = available) {
  return {
    ...WALLET_BALANCE,
    data: {
      ...WALLET_BALANCE.data,
      balance: { bookedBalance: booked, availableBalance: available },
    },
  };
}

describe('GET /money/wallet/balance (MONEY-11) over HTTP', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const double = new FintavaDouble();
  const logger = new QuietLogger();
  const users: string[] = [];
  const previous: Record<string, string | undefined> = {};

  type Person = { id: string; auth: string; walletId: string | null };

  /** A new person with a token and nothing stored. */
  function newUser(): Person {
    const id = randomUUID();
    users.push(id);
    return { id, auth: `Bearer ${mintToken(id)}`, walletId: null };
  }

  /** A new person whose Fintava wallet is on record (as MONEY-12 stores it). */
  async function withWallet(): Promise<Person> {
    const user = newUser();
    const walletId = randomUUID();
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId: user.id,
        customerId: randomUUID(),
        walletId,
        accountNumber: `11${String(Date.now()).slice(-6)}${String(users.length).padStart(2, '0')}`,
      },
    });
    return { ...user, walletId };
  }

  const balancePath = (walletId: string) =>
    `/customer/wallet/balance/${walletId}`;

  function answer(walletId: string, body: unknown, status = 200) {
    double.on('GET', balancePath(walletId), { status, body });
  }

  function get(auth?: string, path = BASE) {
    const req = request(app.getHttpServer()).get(path);
    return auth ? req.set('Authorization', auth) : req;
  }

  /** The refusal is W6, with nothing in it that reads as a balance. */
  function expectUnreachable(res: Response) {
    expect(res.status).toBe(503);
    const body = envelope(res);
    expect(body.data).toBeNull();
    expect(body.reason).toEqual({
      code: 'provider_unreachable',
      message:
        'We could not reach your account. Your money is safe. Try again in a moment.',
      retryAfterSeconds: FINTAVA_DEFAULTS.retryAfterSeconds,
    });
    expect(res.text).not.toMatch(/availableKobo|balanceKobo/);
  }

  beforeAll(async () => {
    await double.start();
    FINTAVA_ENV.FINTAVA_BASE_URL = double.baseUrl;
    for (const [k, v] of Object.entries(FINTAVA_ENV)) {
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
    }).compile();

    app = moduleRef.createNestApplication({ logger });
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

  beforeEach(() => double.reset());

  afterAll(async () => {
    await prisma.fintavaWallet.deleteMany({
      where: { wawuUserId: { in: users } },
    });
    await app.close();
    await double.stop();
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  describe('the balance is Fintava’s, in kobo', () => {
    it('a user with a wallet sees Fintava’s availableBalance as integer kobo', async () => {
      const user = await withWallet();
      answer(user.walletId!, balanceBody(1234.56));
      const before = Date.now();
      const res = await get(user.auth).expect(200);
      expect(envelope(res)).toMatchObject({
        statusCode: 200,
        message: 'OK',
        data: { availableKobo: 123456 },
      });
      expect(Object.keys(envelope(res).data!).sort()).toEqual([
        'asOf',
        'availableKobo',
      ]);
      const asOf = Date.parse(envelope(res).data!.asOf);
      expect(asOf).toBeGreaterThanOrEqual(before - 1);
      expect(asOf).toBeLessThanOrEqual(Date.now() + 1);
      // One read, of this person's wallet, with the key.
      expect(double.seen).toHaveLength(1);
      expect(double.seen[0]).toMatchObject({
        method: 'GET',
        path: balancePath(user.walletId!),
      });
      expect(double.seen[0].headers.authorization).toBe(`Bearer ${KEY}`);
    });

    it('converts naira to kobo without float error, and refuses rather than rounds', async () => {
      const user = await withWallet();
      // Each of these goes wrong as Math.round(x * 100) or x * 100 somewhere
      // (0.29 * 100 is 28.999999999999996; 1.15 * 100 is 114.99999999999999).
      const cases: Array<[unknown, number]> = [
        [1234.56, 123456],
        [0.29, 29],
        [1.15, 115],
        [0.1, 10],
        [19.99, 1999],
        [49960, 4996000],
        [250, 25000],
        [0, 0],
        ['1234.56', 123456],
        ['100.00', 10000],
        ['90071992547409.91', 9007199254740991],
      ];
      for (const [naira, kobo] of cases) {
        double.reset();
        answer(user.walletId!, balanceBody(naira));
        const res = await get(user.auth).expect(200);
        expect({ naira, kobo: envelope(res).data!.availableKobo }).toEqual({
          naira,
          kobo,
        });
        expect(Number.isInteger(envelope(res).data!.availableKobo)).toBe(true);
      }
      // Three decimals, or a figure too large for exact kobo, is never
      // rounded into a balance: there is no trustworthy figure, so W6.
      for (const naira of [1.005, '12.345', 1e21, 'NaN', null]) {
        double.reset();
        answer(user.walletId!, balanceBody(naira));
        expectUnreachable(await get(user.auth));
      }
    });

    it('answers availableBalance only, never bookedBalance', async () => {
      const user = await withWallet();
      answer(user.walletId!, balanceBody(70.25, 99.75));
      const res = await get(user.auth).expect(200);
      expect(Object.keys(envelope(res).data!).sort()).toEqual([
        'asOf',
        'availableKobo',
      ]);
      expect(envelope(res).data!.availableKobo).toBe(7025);
    });

    it('asks Fintava on every request and is never kept anywhere (no-store)', async () => {
      const user = await withWallet();
      let naira = 250;
      double.on('GET', balancePath(user.walletId!), () => ({
        status: 200,
        body: balanceBody(naira),
      }));
      const first = await get(user.auth).expect(200);
      naira = 260;
      const second = await get(user.auth).expect(200);
      naira = 250;
      const third = await get(user.auth).expect(200);
      expect(
        [first, second, third].map((r) => envelope(r).data!.availableKobo),
      ).toEqual([25000, 26000, 25000]);
      expect(double.seen).toHaveLength(3);
      for (const r of [first, second, third]) {
        expect(r.headers['cache-control']).toBe('no-store');
      }
    });
  });

  describe('Fintava unreachable is W6, never a 0', () => {
    it('a 5xx from Fintava is 503 provider_unreachable', async () => {
      const user = await withWallet();
      for (const status of [500, 502, 503, 504]) {
        double.reset();
        answer(user.walletId!, fintavaError(status, 'read ECONNRESET'), status);
        expectUnreachable(await get(user.auth));
      }
    });

    it('a timeout is 503 provider_unreachable, not a 0 and not a hang', async () => {
      const user = await withWallet();
      double.on('GET', balancePath(user.walletId!), {
        status: 200,
        body: balanceBody(0),
        delayMs: READ_TIMEOUT_MS * 4,
      });
      const started = Date.now();
      expectUnreachable(await get(user.auth));
      expect(Date.now() - started).toBeLessThan(READ_TIMEOUT_MS * 4);
    });

    it('a dropped connection is 503 provider_unreachable', async () => {
      const user = await withWallet();
      double.on('GET', balancePath(user.walletId!), {
        status: 200,
        hangUp: true,
      });
      expectUnreachable(await get(user.auth));
    });

    it('a 2xx without a balance in it is 503, never read as 0', async () => {
      const user = await withWallet();
      for (const body of [
        { status: 200, message: 'service not currently available' },
        {},
        { data: null },
        { data: { balance: {} } },
        'not json',
        '',
      ]) {
        double.reset();
        answer(user.walletId!, body);
        expectUnreachable(await get(user.auth));
      }
    });

    it('a key problem, a rate limit or Fintava not knowing the stored wallet is 503 too', async () => {
      const user = await withWallet();
      const cases: Array<[number, string]> = [
        [401, 'API Key is required'],
        [400, 'Invalid API key'],
        [404, 'Invalid API Key'],
        [429, 'Too Many Requests'],
        // sandbox/08-: an unknown wallet id is 400 "Wallet not found".
        [400, 'Wallet not found'],
      ];
      for (const [status, text] of cases) {
        double.reset();
        answer(user.walletId!, fintavaError(status, text), status);
        expectUnreachable(await get(user.auth));
      }
      // Fintava not knowing a wallet we stored is logged for us to look into.
      expect(logger.lines.join('\n')).toContain(
        'Fintava has no wallet under a stored walletId',
      );
    });

    it('no Fintava key in config is 503 and nothing is sent', async () => {
      const user = await withWallet();
      process.env.FINTAVA_API_KEY = '';
      const moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
          PassportModule.register({ defaultStrategy: 'wawu-jwt' }),
          PrismaModule,
          MoneyModule,
        ],
        providers: [WawuJwtStrategy, WawuIdClient],
      }).compile();
      process.env.FINTAVA_API_KEY = KEY;
      const keyless = moduleRef.createNestApplication<INestApplication<App>>({
        logger,
      });
      keyless.setGlobalPrefix('api/hub');
      keyless.useGlobalFilters(new AllExceptionsFilter());
      keyless.useGlobalInterceptors(new ResponseInterceptor());
      await keyless.init();
      try {
        answer(user.walletId!, balanceBody(250));
        const res = await request(keyless.getHttpServer())
          .get(BASE)
          .set('Authorization', user.auth);
        expectUnreachable(res);
        expect(double.seen).toHaveLength(0);
      } finally {
        await keyless.close();
      }
    });
  });

  describe('a frozen wallet', () => {
    it('Fintava’s frozen refusal is 423 wallet_frozen (the client’s own mapping)', async () => {
      const user = await withWallet();
      answer(
        user.walletId!,
        fintavaError(400, 'Kindly confirm both customer accounts are active'),
        400,
      );
      const res = await get(user.auth).expect(423);
      expect(envelope(res)).toEqual({
        statusCode: 423,
        message: 'This wallet cannot send or receive money right now.',
        data: null,
        reason: {
          code: 'wallet_frozen',
          message: 'This wallet cannot send or receive money right now.',
        },
      });
    });
  });

  describe('no wallet yet', () => {
    it('a user without a wallet gets 409 wallet_not_open, and Fintava is not asked', async () => {
      const user = newUser();
      const res = await get(user.auth).expect(409);
      expect(envelope(res)).toEqual({
        statusCode: 409,
        message: 'Open your wallet to see your balance.',
        data: null,
        reason: {
          code: 'wallet_not_open',
          message: 'Open your wallet to see your balance.',
        },
      });
      expect(double.seen).toHaveLength(0);
    });
  });

  describe('who can read it', () => {
    it('no token, or a token that does not verify, is 401 and Fintava is not asked', async () => {
      const user = await withWallet();
      answer(user.walletId!, balanceBody(250));
      await get().expect(401);
      await get('Bearer not-a-token').expect(401);
      const forged = jwt.sign({ sub: user.id }, 'not-the-key', {
        algorithm: 'HS256',
      });
      await get(`Bearer ${forged}`).expect(401);
      expect(double.seen).toHaveLength(0);
    });

    it('each person reads only their own wallet; another wallet cannot be named', async () => {
      const ada = await withWallet();
      const bayo = await withWallet();
      const nobody = newUser();
      answer(ada.walletId!, balanceBody(100));
      answer(bayo.walletId!, balanceBody(9999.99));

      expect(
        envelope(await get(ada.auth).expect(200)).data!.availableKobo,
      ).toBe(10000);
      expect(
        envelope(await get(bayo.auth).expect(200)).data!.availableKobo,
      ).toBe(999999);

      // Naming Bayo's wallet or Bayo in the query changes nothing: the
      // wallet is the token's.
      for (const q of [
        `walletId=${bayo.walletId}`,
        `wawuUserId=${bayo.id}`,
        `userId=${bayo.id}`,
      ]) {
        const res = await get(ada.auth, `${BASE}?${q}`).expect(200);
        expect(envelope(res).data!.availableKobo).toBe(10000);
      }
      // There is no route that takes a wallet id.
      await get(ada.auth, `${BASE}/${bayo.walletId}`).expect(404);
      // Someone with no wallet cannot borrow one.
      await get(nobody.auth, `${BASE}?walletId=${bayo.walletId}`).expect(409);

      const asked = double.seen.map((s) => s.path);
      expect(
        asked.filter((p) => p === balancePath(bayo.walletId!)),
      ).toHaveLength(1);
      expect(
        asked.filter((p) => p === balancePath(ada.walletId!)),
      ).toHaveLength(4);
    });
  });
});
