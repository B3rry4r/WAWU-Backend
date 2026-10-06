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
import type { MoneyErrorReason } from '../../dto/money-error.dto';
import { NO_WALLET_MESSAGE } from '../../gate/wallet-gate';
import { MoneyError } from '../../money-error';
import { MoneyModule } from '../../money.module';
import type { FeeQuoteView } from '../../money-view.type';
import { FEE_CONFIG_KEYS } from '../fee-config';
import { FeeQuoteService } from '../fee-quote.service';

/**
 * GET /money/fees/quote over HTTP (task WALLET-15): the real MoneyModule, a
 * real database for the wallet gate, real RS256 tokens checked against the
 * stand-in WAWU ID's JWKS (WAWU_ID_JWKS_URL). The fee schedule is the ruled
 * default (no fee setting in this app's config), except the merchant cap,
 * set the way `.env.example` sets it. The route never calls Fintava: no
 * FINTAVA_* setting is given, and a quote still answers.
 */

const BASE = '/api/hub/money/fees/quote';
const naira = (n: number) => Math.round(n * 100);

function mintToken(sub: string): string {
  const privateKey = readFileSync(
    join(__dirname, '../../../../mock-wawu-id/private.pem'),
    'utf8',
  );
  return jwt.sign(
    {
      sub,
      email: `fees-${sub}@test.wawu.dev`,
      phone: '+2348000009996',
      firstName: 'Fees',
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

type Envelope<T> = {
  statusCode: number;
  message: string | string[];
  data: T | null;
  reason?: MoneyErrorReason;
};
const body = <T>(res: Response): Envelope<T> => res.body as Envelope<T>;

let accountSeq = 0;
function nuban(): string {
  accountSeq += 1;
  return `8${String(Date.now()).slice(-6)}${String(accountSeq).padStart(3, '0')}`;
}

describe('GET /money/fees/quote (WALLET-15) over HTTP', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let quotes: FeeQuoteService;
  const logger = new QuietLogger();
  const users: string[] = [];

  type Person = { id: string; auth: string };

  function newUser(): Person {
    const id = randomUUID();
    users.push(id);
    return { id, auth: `Bearer ${mintToken(id)}` };
  }

  async function withWallet(): Promise<Person> {
    const user = newUser();
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId: user.id,
        customerId: randomUUID(),
        walletId: randomUUID(),
        accountNumber: nuban(),
        accountName: null,
      },
    });
    return user;
  }

  function get(auth: string | undefined, query: string) {
    const req = request(app.getHttpServer()).get(`${BASE}?${query}`);
    return auth ? req.set('Authorization', auth) : req;
  }

  async function quote(p: Person, query: string): Promise<FeeQuoteView> {
    const res = await get(p.auth, query).expect(200);
    return body<FeeQuoteView>(res).data!;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              [FEE_CONFIG_KEYS.merchantMaxPerTxn]: '1000000000',
              [FEE_CONFIG_KEYS.quoteKey]: 'w15-contract-spec-key-'.padEnd(
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
    await app.listen(0, '127.0.0.1');
    prisma = moduleRef.get(PrismaService);
    quotes = moduleRef.get(FeeQuoteService);
  });

  afterAll(async () => {
    await prisma.fintavaWallet.deleteMany({
      where: { wawuUserId: { in: users } },
    });
    await prisma.fintavaWalletOpening.deleteMany({
      where: { wawuUserId: { in: users } },
    });
    await app.close();
  });

  describe('who can ask', () => {
    it('without a token it is 401', async () => {
      await get(undefined, 'kind=bank_transfer&amountKobo=1000000').expect(401);
    });

    it('a person with no wallet gets 409 wallet_not_open (R-6), whatever the query', async () => {
      const u = newUser();
      for (const q of [
        'kind=bank_transfer&amountKobo=1000000',
        'kind=nonsense&amountKobo=-4',
      ]) {
        const res = await get(u.auth, q).expect(409);
        expect(body(res).reason).toEqual({
          code: 'wallet_not_open',
          message: NO_WALLET_MESSAGE,
        });
      }
    });
  });

  describe('the capability checks', () => {
    it('a user sending ₦10,000 to a bank sees ₦40 + ₦25 = ₦65 and a total of ₦10,065 before confirming', async () => {
      const a = await withWallet();
      const res = await get(
        a.auth,
        `kind=bank_transfer&amountKobo=${naira(10_000)}`,
      ).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const v = body<FeeQuoteView>(res).data!;
      expect(v).toMatchObject({
        kind: 'bank_transfer',
        billCategory: null,
        amountKobo: 1_000_000,
        fee: { providerFeeKobo: 4000, wawuFeeKobo: 2500, totalFeeKobo: 6500 },
        parts: [
          { code: 'bank_transfer', source: 'provider', amountKobo: 4000 },
          { code: 'wawu_fee', source: 'wawu', amountKobo: 2500 },
        ],
        totalKobo: 1_006_500,
        withinDailyLimit: true,
        remainingTodayKobo: null,
      });
      expect(typeof v.quoteToken).toBe('string');
      expect(new Date(v.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    it('a ₦4,999 purchase quotes ₦23.25 and a ₦5,000 purchase ₦15.75, and the paying request honours exactly that total', async () => {
      const a = await withWallet();
      const below = await quote(a, `kind=purchase&amountKobo=${naira(4_999)}`);
      expect(below.fee).toEqual({
        providerFeeKobo: 2325,
        wawuFeeKobo: 0,
        totalFeeKobo: 2325,
      });
      expect(below.totalKobo).toBe(502_225);
      const at = await quote(a, `kind=purchase&amountKobo=${naira(5_000)}`);
      expect(at.fee).toEqual({
        providerFeeKobo: 1575,
        wawuFeeKobo: 0,
        totalFeeKobo: 1575,
      });
      expect(at.totalKobo).toBe(501_575);

      // What MONEY-17 will do with the quote the person saw: same total, honoured.
      for (const [v, amountKobo] of [
        [below, naira(4_999)],
        [at, naira(5_000)],
      ] as const) {
        const checked = quotes.check(
          a.id,
          { kind: 'purchase', amountKobo },
          v.totalKobo,
          v.quoteToken,
        );
        expect(checked.totalKobo).toBe(v.totalKobo);
      }
    });

    it("an electricity bill of ₦10,000 quotes its ₦100 bill charge and the payer's balance-transfer charge, each as its own part", async () => {
      const a = await withWallet();
      const v = await quote(
        a,
        `kind=bill&billCategory=electricity&amountKobo=${naira(10_000)}`,
      );
      expect(v.billCategory).toBe('electricity');
      expect(v.parts).toEqual([
        { code: 'bill_charge', source: 'provider', amountKobo: 10_000 },
        { code: 'wawu_fee', source: 'wawu', amountKobo: 0 },
        { code: 'balance_transfer', source: 'provider', amountKobo: 1575 },
      ]);
      expect(v.fee).toEqual({
        providerFeeKobo: 11_575,
        wawuFeeKobo: 0,
        totalFeeKobo: 11_575,
      });
      expect(v.totalKobo).toBe(1_011_575);
    });
  });

  describe('the other kinds', () => {
    it("a send to a WAWU user is the band charge plus WAWU's ₦10", async () => {
      const a = await withWallet();
      const v = await quote(a, `kind=wawu_transfer&amountKobo=${naira(2_000)}`);
      expect(v.parts).toEqual([
        { code: 'balance_transfer', source: 'provider', amountKobo: 2325 },
        { code: 'wawu_fee', source: 'wawu', amountKobo: 1000 },
      ]);
      expect(v.totalKobo).toBe(200_000 + 3325);
    });

    it('airtime and data carry no bill charge, cable ₦100', async () => {
      const a = await withWallet();
      const parts = async (c: string) =>
        (await quote(a, `kind=bill&billCategory=${c}&amountKobo=${naira(500)}`))
          .parts[0].amountKobo;
      expect(await parts('airtime')).toBe(0);
      expect(await parts('data')).toBe(0);
      expect(await parts('cable')).toBe(10_000);
    });
  });

  describe('what it refuses', () => {
    it('amounts in any form but whole kobo are a 400 (a naira decimal, a comma, a sign, nothing)', async () => {
      const a = await withWallet();
      for (const amount of [
        '10000.50',
        '100.00',
        '1e4',
        '10,000',
        '-500',
        '0',
        '',
        'NaN',
        '₦10000',
        ' 100',
      ]) {
        const res = await get(
          a.auth,
          `kind=bank_transfer&amountKobo=${encodeURIComponent(amount)}`,
        );
        expect([amount, res.status]).toEqual([amount, 400]);
        expect(body(res).reason).toBeUndefined();
        expect(body(res).message).toBe(
          'amountKobo must be a whole number of kobo, 1 or more, written in digits only.',
        );
      }
      await get(a.auth, 'kind=bank_transfer').expect(400);
    });

    it('an unknown kind, a bill without its category, or a category on anything but a bill is a 400', async () => {
      const a = await withWallet();
      for (const q of [
        'kind=card_topup&amountKobo=1000',
        'kind=bill&amountKobo=1000',
        'kind=bill&billCategory=water&amountKobo=1000',
        'kind=purchase&billCategory=electricity&amountKobo=1000',
        'kind=bank_transfer&billCategory=airtime&amountKobo=1000',
        'kind=purchase&amountKobo=1000&wawuUserId=someone',
      ]) {
        const res = await get(a.auth, q);
        expect([q, res.status]).toEqual([q, 400]);
      }
    });

    it('a purchase above the merchant wallet cap is 400 amount_out_of_range with the largest amount that fits; a send is not capped', async () => {
      const a = await withWallet();
      const res = await get(
        a.auth,
        'kind=purchase&amountKobo=1000000000',
      ).expect(400);
      const reason = body(res).reason!;
      expect(reason.code).toBe('amount_out_of_range');
      expect(reason.maximumKobo).toBe(1_000_000_000 - 1575);
      expect(reason.message).not.toMatch(/—/);
      const fits = await quote(
        a,
        `kind=purchase&amountKobo=${reason.maximumKobo}`,
      );
      expect(fits.totalKobo).toBe(1_000_000_000);
      await get(a.auth, 'kind=bank_transfer&amountKobo=1000000000').expect(200);
    });
  });

  describe('the quote is checkable by the request that pays it', () => {
    it("another person cannot pay at someone else's quote; an expired one is quote_changed with the new quote", async () => {
      const a = await withWallet();
      const b = await withWallet();
      const v = await quote(
        a,
        `kind=bank_transfer&amountKobo=${naira(10_000)}`,
      );
      const input = {
        kind: 'bank_transfer' as const,
        amountKobo: naira(10_000),
      };
      expect(() =>
        quotes.check(b.id, input, v.totalKobo, v.quoteToken),
      ).toThrow(MoneyError);
      try {
        quotes.check(
          a.id,
          input,
          v.totalKobo,
          v.quoteToken,
          new Date(Date.parse(v.expiresAt) + 1),
        );
        throw new Error('expected quote_changed');
      } catch (e) {
        expect(e).toBeInstanceOf(MoneyError);
        const r = (e as MoneyError).getResponse() as {
          reason: MoneyErrorReason;
        };
        expect((e as MoneyError).getStatus()).toBe(409);
        expect(r.reason.code).toBe('quote_changed');
        expect(r.reason.feeQuote?.totalKobo).toBe(1_006_500);
      }
    });

    it('every figure on the wire is an integer of kobo', async () => {
      const a = await withWallet();
      const res = await get(
        a.auth,
        `kind=wawu_transfer&amountKobo=${naira(7_777.77)}`,
      ).expect(200);
      expect(res.text).not.toMatch(/"[a-zA-Z]*Kobo":-?[0-9]+\.[0-9]/);
    });
  });

  it('logs nothing about a quote, and never the signing key', () => {
    const all = logger.lines.join('\n');
    expect(all).not.toContain('w15-contract-spec-key-');
    expect(all).not.toMatch(/quoteToken/);
  });
});
