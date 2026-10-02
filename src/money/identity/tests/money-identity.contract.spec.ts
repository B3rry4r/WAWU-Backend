import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import {
  ConsoleLogger,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import * as jwt from 'jsonwebtoken';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import {
  BVN_200,
  FintavaDouble,
  fintavaError,
} from '../../../../test/fintava/fintava-double';
import { WawuIdClient } from '../../../common/auth/wawu-id.client';
import { WawuJwtStrategy } from '../../../common/auth/wawu-jwt.strategy';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { FintavaClient } from '../../../fintava/fintava-client';
import type { MoneyErrorReason } from '../../dto/money-error.dto';
import { MoneyModule } from '../../money.module';
import { IdentityConfigError, IdentityHasher } from '../identity-config';
import type { BvnCheckView, WalletIdentityView } from '../identity-view.type';
import {
  BVN_PHONE_MISMATCH_MESSAGE,
  WalletIdentityService,
} from '../wallet-identity.service';

/**
 * Open your wallet's identity step (task KYC-01) over HTTP: the real
 * MoneyModule, a real database, real RS256 tokens checked against the mock
 * WAWU ID's JWKS (WAWU_ID_JWKS_URL), and the real MONEY-06 Fintava client
 * talking over a socket to the local double (test/fintava/fintava-double.ts),
 * which answers with Fintava's documented BVN success body and the refusal
 * the sandbox really sent. Each test signs in as brand-new people, so it owns
 * its rows; afterAll deletes them.
 *
 * Every BVN, NIN and phone here is made up, and every log line the app writes
 * during the whole file is captured: the last test proves none of them, and
 * no answer, carries a full BVN, NIN or the BVN record's phone.
 */

const KEY = 'live_test_identity_0123456789FAKEKEY';
const HASH_KEY = 'k01-test-identity-hash-key-0123456789abcdef';
const CHECK_TIMEOUT_MS = 300;

const ENV: Record<string, string> = {
  FINTAVA_BASE_URL: '',
  FINTAVA_API_KEY: KEY,
  FINTAVA_CHECK_TIMEOUT_MS: String(CHECK_TIMEOUT_MS),
  IDENTITY_HASH_KEY: HASH_KEY,
  BVN_CHECKS_PER_DAY: '',
};

/** The account phone every person here signed up with, and the same number in Fintava's local form. */
const ACCOUNT_PHONE = '+2348031234412';
const BVN_PHONE_SAME = '08031234412';
/** A BVN record whose phone is somebody else's. */
const BVN_PHONE_OTHER = '09057770001';

/** Made-up 11-digit numbers, one per use, so a leak names its source. */
const BVNS = {
  good: '22190000111',
  mismatch: '22190000222',
  refused: '22190000333',
  limit: '22190000444',
  logged: '22190000555',
};
const NIN = '70190000999';

// ---------------------------------------------------------------------------
// Every channel a log line can leave by, captured for the whole file.
// ---------------------------------------------------------------------------
const captured: string[] = [];
const restores: Array<() => void> = [];
function capture(target: object, method: string): void {
  const t = target as Record<string, (...a: unknown[]) => unknown>;
  const original = t[method];
  t[method] = (...args: unknown[]) => {
    captured.push(
      args
        .map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 8 })))
        .join(' '),
    );
    return true;
  };
  restores.push(() => {
    t[method] = original;
  });
}
/** Every answer body the app sent, for the same proof. */
const answered: string[] = [];

function mintToken(sub: string, phone: string = ACCOUNT_PHONE): string {
  const privateKey = readFileSync(
    join(__dirname, '../../../../mock-wawu-id/private.pem'),
    'utf8',
  );
  return jwt.sign(
    {
      sub,
      email: `identity-${sub}@test.wawu.dev`,
      phone,
      firstName: 'Identity',
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

type Envelope<T> = {
  statusCode: number;
  message: string;
  data: T | null;
  reason?: MoneyErrorReason;
};
const body = <T>(res: Response): Envelope<T> => {
  answered.push(res.text);
  return res.body as Envelope<T>;
};

/** Fintava's documented success body with this phone (and optionally other fields). */
function bvnAnswer(phone: string | null, over: Record<string, unknown> = {}) {
  return {
    data: { ...BVN_200.data, phone_number1: phone, ...over },
  };
}

describe('Open your wallet identity step (KYC-01) over HTTP', () => {
  // Every level on: whatever the app logs is printed, and so captured.
  const logger = new ConsoleLogger({
    logLevels: ['log', 'error', 'warn', 'debug', 'verbose', 'fatal'],
  });
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let service: WalletIdentityService;
  let fintava: FintavaClient;
  const double = new FintavaDouble();
  const users: string[] = [];
  const previous: Record<string, string | undefined> = {};

  type Person = { id: string; auth: string };
  function person(phone?: string): Person {
    const id = randomUUID();
    users.push(id);
    return { id, auth: `Bearer ${mintToken(id, phone)}` };
  }

  const http = () => request(app.getHttpServer());
  const check = (who: Person | null, payload: unknown) => {
    const req = http().post('/api/hub/money/identity/bvn');
    return (who ? req.set('Authorization', who.auth) : req).send(
      payload as object,
    );
  };
  const read = (who: Person | null) => {
    const req = http().get('/api/hub/money/identity');
    return who ? req.set('Authorization', who.auth) : req;
  };
  const occupation = (who: Person | null, payload: unknown) => {
    const req = http().put('/api/hub/money/identity/occupation');
    return (who ? req.set('Authorization', who.auth) : req).send(
      payload as object,
    );
  };
  const bvnCalls = () =>
    double.seen.filter((s) => s.path === '/compliance/verify/bvn');
  function answerBvn(answer: Parameters<FintavaDouble['on']>[2]) {
    double.on('GET', '/compliance/verify/bvn', answer);
  }

  beforeAll(async () => {
    capture(process.stdout, 'write');
    capture(process.stderr, 'write');
    for (const m of ['log', 'info', 'warn', 'error', 'debug', 'trace'])
      capture(console, m);

    await double.start();
    ENV.FINTAVA_BASE_URL = double.baseUrl;
    for (const [k, v] of Object.entries(ENV)) {
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
      .setLogger(logger)
      .compile();

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
    service = moduleRef.get(WalletIdentityService);
    fintava = moduleRef.get(FintavaClient);
  });

  beforeEach(() => double.reset());

  afterAll(async () => {
    if (prisma) {
      await prisma.walletIdentity.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.bvnCheckAttempt.deleteMany({
        where: { wawuUserId: { in: users } },
      });
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
    for (const restore of restores.reverse()) restore();
  });

  // -------------------------------------------------------------------------
  describe('a valid BVN fills the A5 details', () => {
    it('answers name, date of birth and gender from the BVN record, and the last 4 digits only', async () => {
      const user = person();
      answerBvn({ status: 200, body: bvnAnswer(BVN_PHONE_SAME) });
      const res = await check(user, { bvn: BVNS.good, nin: NIN }).expect(200);
      const out = body<BvnCheckView>(res);
      expect(out.statusCode).toBe(200);
      expect(out.data!.prefill).toEqual({
        firstName: 'Ada',
        middleName: 'B',
        lastName: 'Sandbox',
        dateOfBirth: '1992-10-04',
        gender: 'female',
      });
      expect(out.data!.identity).toMatchObject({
        bvn: { last4: '0111' },
        ninLast4: '0999',
        occupation: null,
        checksLeft: 2,
      });
      expect(Date.parse(out.data!.identity.bvn!.verifiedAt)).not.toBeNaN();
      expect(res.headers['cache-control']).toBe('no-store');
      // The photo and the BVN's phone are not passed on.
      expect(res.text).not.toContain(BVN_200.data.image);
      expect(res.text).not.toContain(BVN_PHONE_SAME);
      // One lookup, of this BVN, with the key; the BVN went in Fintava's query only.
      expect(bvnCalls()).toHaveLength(1);
      expect(bvnCalls()[0].query).toEqual({ bvn: BVNS.good });
      expect(bvnCalls()[0].headers.authorization).toBe(`Bearer ${KEY}`);
    });

    it('reads NIBSS-style dates and upper-case genders, and leaves what it cannot read null', async () => {
      const a = person();
      answerBvn({
        status: 200,
        body: bvnAnswer(BVN_PHONE_SAME, {
          date_of_birth: '14-Mar-1994',
          gender: 'MALE',
          middle_name: '  ',
        }),
      });
      const one = body<BvnCheckView>(
        await check(a, { bvn: BVNS.good, nin: NIN }).expect(200),
      );
      expect(one.data!.prefill).toMatchObject({
        dateOfBirth: '1994-03-14',
        gender: 'male',
        middleName: null,
      });

      const b = person();
      answerBvn({
        status: 200,
        body: bvnAnswer(BVN_PHONE_SAME, {
          date_of_birth: '31/02/1994',
          gender: 'unknown',
        }),
      });
      const two = body<BvnCheckView>(
        await check(b, { bvn: BVNS.good, nin: NIN }).expect(200),
      );
      expect(two.data!.prefill).toMatchObject({
        dateOfBirth: null,
        gender: null,
      });
    });

    it('accepts the account phone in any Nigerian form (+234 against 0...)', async () => {
      const user = person('0803 123 4412');
      answerBvn({ status: 200, body: bvnAnswer('2348031234412') });
      await check(user, { bvn: BVNS.good, nin: NIN }).expect(200);
    });

    it('GET /money/identity then shows the passed check, last 4 digits only', async () => {
      const user = person();
      answerBvn({ status: 200, body: bvnAnswer(BVN_PHONE_SAME) });
      await check(user, { bvn: BVNS.good, nin: NIN }).expect(200);
      const res = await read(user).expect(200);
      const view = body<WalletIdentityView>(res).data!;
      expect(view).toMatchObject({
        bvn: { last4: '0111' },
        ninLast4: '0999',
        occupation: null,
        checksLeft: 2,
      });
      expect(Object.keys(view).sort()).toEqual([
        'bvn',
        'checksLeft',
        'ninLast4',
        'occupation',
      ]);
      expect(res.text).not.toContain(BVNS.good);
      expect(res.text).not.toContain(NIN);
    });

    it('a person who never checked reads an empty step with every check left', async () => {
      const res = await read(person()).expect(200);
      expect(body<WalletIdentityView>(res).data).toEqual({
        bvn: null,
        ninLast4: null,
        occupation: null,
        checksLeft: 3,
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('the full BVN and NIN are never stored', () => {
    it('stores a keyed hash and the last 4 digits; no column anywhere holds the full number', async () => {
      const user = person();
      answerBvn({ status: 200, body: bvnAnswer(BVN_PHONE_SAME) });
      await check(user, { bvn: BVNS.good, nin: NIN }).expect(200);

      const row = await prisma.walletIdentity.findUniqueOrThrow({
        where: { wawuUserId: user.id },
      });
      expect(row.bvnLast4).toBe('0111');
      expect(row.ninLast4).toBe('0999');
      expect(row.verifiedPhone).toBe(ACCOUNT_PHONE);
      expect(row.bvnHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.ninHash).toMatch(/^[0-9a-f]{64}$/);
      // Not a plain hash anyone could rebuild by trying every BVN.
      for (const plain of [
        createHash('sha256').update(BVNS.good).digest('hex'),
        createHash('sha256').update(`bvn:${BVNS.good}`).digest('hex'),
      ]) {
        expect(row.bvnHash).not.toBe(plain);
      }
      // The hash is the service's own keyed one (it is what KYC-02 and
      // MONEY-12 compare against).
      await expect(
        service.matchesCheckedIdentity(user.id, BVNS.good, NIN),
      ).resolves.toBe(true);
      await expect(
        service.matchesCheckedIdentity(user.id, BVNS.mismatch, NIN),
      ).resolves.toBe(false);
      await expect(
        service.matchesCheckedIdentity(user.id, BVNS.good, '70190000998'),
      ).resolves.toBe(false);

      // Every text column of every table in this database: none holds the
      // full BVN or NIN (a full scan, not only the tables this task added).
      const columns = await prisma.$queryRawUnsafe<
        Array<{ table_name: string; column_name: string }>
      >(
        `SELECT table_name, column_name FROM information_schema.columns
         WHERE table_schema = 'public'
           AND data_type IN ('text', 'character varying', 'jsonb', 'json')`,
      );
      expect(columns.length).toBeGreaterThan(20);
      const hits: string[] = [];
      for (const { table_name, column_name } of columns) {
        const [{ n }] = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
          `SELECT count(*) AS n FROM "${table_name}"
           WHERE "${column_name}"::text LIKE $1 OR "${column_name}"::text LIKE $2`,
          `%${BVNS.good}%`,
          `%${NIN}%`,
        );
        if (Number(n) > 0) hits.push(`${table_name}.${column_name}`);
      }
      expect(hits).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  describe('A14: a BVN whose phone is not the account’s', () => {
    it('answers 422 bvn_phone_mismatch with A14’s words, and nothing from the BVN record', async () => {
      const user = person();
      answerBvn({ status: 200, body: bvnAnswer(BVN_PHONE_OTHER) });
      const res = await check(user, { bvn: BVNS.mismatch, nin: NIN }).expect(
        422,
      );
      const out = body<null>(res);
      expect(out).toEqual({
        statusCode: 422,
        message: BVN_PHONE_MISMATCH_MESSAGE,
        data: null,
        reason: {
          code: 'bvn_phone_mismatch',
          message: "This isn't the number on your BVN. Use that one.",
          checksLeft: 2,
        },
      });
      // No digit run of the BVN's phone, not even its last 4, and no name.
      expect(res.text).not.toContain(BVN_PHONE_OTHER.slice(-4));
      expect(res.text).not.toMatch(/Ada|Sandbox|1992/);
      // Nothing is marked checked.
      expect(
        await prisma.walletIdentity.findUnique({
          where: { wawuUserId: user.id },
        }),
      ).toBeNull();
      const attempts = await prisma.bvnCheckAttempt.findMany({
        where: { wawuUserId: user.id },
      });
      expect(attempts.map((a) => a.outcome)).toEqual(['phone_mismatch']);
    });

    it('a BVN record without a phone cannot match, so it is A14 too', async () => {
      const user = person();
      answerBvn({ status: 200, body: bvnAnswer(null) });
      const res = await check(user, { bvn: BVNS.mismatch, nin: NIN }).expect(
        422,
      );
      expect(body<null>(res).reason?.code).toBe('bvn_phone_mismatch');
    });

    it('a later mismatch does not undo a check that passed', async () => {
      const user = person();
      answerBvn({ status: 200, body: bvnAnswer(BVN_PHONE_SAME) });
      await check(user, { bvn: BVNS.good, nin: NIN }).expect(200);
      double.reset();
      answerBvn({ status: 200, body: bvnAnswer(BVN_PHONE_OTHER) });
      await check(user, { bvn: BVNS.mismatch, nin: NIN }).expect(422);
      const view = body<WalletIdentityView>(await read(user).expect(200)).data!;
      expect(view.bvn?.last4).toBe('0111');
      expect(view.checksLeft).toBe(1);
    });

    it('an account phone that is not Nigerian is refused before Fintava is asked (nothing charged)', async () => {
      const user = person('+447700900123');
      const res = await check(user, { bvn: BVNS.good, nin: NIN }).expect(422);
      expect(body<null>(res).reason?.code).toBe('phone_not_nigerian');
      expect(bvnCalls()).toHaveLength(0);
      expect(
        await prisma.bvnCheckAttempt.count({ where: { wawuUserId: user.id } }),
      ).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('Fintava saying no, or not answering', () => {
    it('the sandbox’s own refusal is 422 bvn_not_confirmed, counted against the day', async () => {
      const user = person();
      answerBvn({
        status: 400,
        body: fintavaError(400, 'Invalid BVN or BVN does not exist'),
      });
      const res = await check(user, { bvn: BVNS.refused, nin: NIN }).expect(
        422,
      );
      expect(body<null>(res).reason).toEqual({
        code: 'bvn_not_confirmed',
        message:
          'We could not confirm that BVN. Check the number and try again.',
        checksLeft: 2,
      });
      expect(res.text).not.toMatch(/Invalid BVN|does not exist/);
    });

    it('a 5xx or a timeout is 503 provider_unreachable, and still counts (it may have been charged)', async () => {
      const user = person();
      answerBvn({ status: 502, body: '<html>bad gateway</html>' });
      const one = await check(user, { bvn: BVNS.refused, nin: NIN }).expect(
        503,
      );
      expect(body<null>(one).reason).toEqual({
        code: 'provider_unreachable',
        message:
          'We could not check your BVN right now. Try again in a moment.',
        retryAfterSeconds: 30,
      });
      double.reset();
      answerBvn({
        status: 200,
        body: bvnAnswer(BVN_PHONE_SAME),
        delayMs: CHECK_TIMEOUT_MS + 300,
      });
      await check(user, { bvn: BVNS.refused, nin: NIN }).expect(503);
      const view = body<WalletIdentityView>(await read(user).expect(200)).data!;
      expect(view).toMatchObject({ bvn: null, checksLeft: 1 });
    });

    it('a key Fintava refuses is 503 and gives the check back (nothing reached the provider)', async () => {
      const user = person();
      answerBvn({ status: 401, body: fintavaError(401, 'Invalid API key') });
      await check(user, { bvn: BVNS.refused, nin: NIN }).expect(503);
      expect(
        await prisma.bvnCheckAttempt.count({ where: { wawuUserId: user.id } }),
      ).toBe(0);
    });

    it('a person whose wallet is already open is refused before Fintava is asked', async () => {
      const user = person();
      await prisma.fintavaWallet.create({
        data: {
          wawuUserId: user.id,
          customerId: randomUUID(),
          walletId: randomUUID(),
          accountNumber: `17${String(Date.now()).slice(-8)}`,
        },
      });
      const res = await check(user, { bvn: BVNS.good, nin: NIN }).expect(409);
      expect(body<null>(res).reason?.code).toBe('wallet_already_open');
      expect(bvnCalls()).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('the daily limit per person', () => {
    it('allows 3 checks in 24 hours, then 429 identity_checks_exhausted without asking Fintava', async () => {
      const user = person();
      answerBvn({
        status: 400,
        body: fintavaError(400, 'Invalid BVN or BVN does not exist'),
      });
      const left: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        const res = await check(user, { bvn: BVNS.limit, nin: NIN }).expect(
          422,
        );
        left.push(body<null>(res).reason!.checksLeft!);
      }
      expect(left).toEqual([2, 1, 0]);
      const res = await check(user, { bvn: BVNS.limit, nin: NIN }).expect(429);
      const reason = body<null>(res).reason!;
      expect(reason.code).toBe('identity_checks_exhausted');
      expect(reason.retryAfterSeconds).toBeGreaterThan(86_000);
      expect(reason.retryAfterSeconds).toBeLessThanOrEqual(86_400);
      expect(bvnCalls()).toHaveLength(3);

      // Somebody else is not affected.
      const other = person();
      await check(other, { bvn: BVNS.limit, nin: NIN }).expect(422);
      expect(bvnCalls()).toHaveLength(4);
    });

    it('checks older than 24 hours no longer count', async () => {
      const user = person();
      await prisma.bvnCheckAttempt.createMany({
        data: [1, 2, 3].map(() => ({
          wawuUserId: user.id,
          outcome: 'refused',
          createdAt: new Date(Date.now() - 25 * 60 * 60_000),
        })),
      });
      answerBvn({ status: 200, body: bvnAnswer(BVN_PHONE_SAME) });
      await check(user, { bvn: BVNS.good, nin: NIN }).expect(200);
    });

    it('checks sent at the same moment cannot get past the limit together', async () => {
      const user = person();
      answerBvn({
        status: 400,
        body: fintavaError(400, 'Invalid BVN or BVN does not exist'),
        delayMs: 50,
      });
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          check(user, { bvn: BVNS.limit, nin: NIN }),
        ),
      );
      const statuses = results.map((r) => r.status);
      expect(statuses.filter((s) => s === 422).length).toBeLessThanOrEqual(3);
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(
        3,
      );
      expect(bvnCalls().length).toBeLessThanOrEqual(3);
      expect(
        await prisma.bvnCheckAttempt.count({ where: { wawuUserId: user.id } }),
      ).toBeLessThanOrEqual(3);
    });
  });

  // -------------------------------------------------------------------------
  describe('occupation, typed on A5', () => {
    it('is stored once the BVN has passed, trimmed, and read back', async () => {
      const user = person();
      answerBvn({ status: 200, body: bvnAnswer(BVN_PHONE_SAME) });
      await check(user, { bvn: BVNS.good, nin: NIN }).expect(200);
      const res = await occupation(user, { occupation: '  Filmmaker ' }).expect(
        200,
      );
      expect(body<WalletIdentityView>(res).data).toMatchObject({
        occupation: 'Filmmaker',
        bvn: { last4: '0111' },
      });
      const view = body<WalletIdentityView>(await read(user).expect(200)).data!;
      expect(view.occupation).toBe('Filmmaker');
    });

    it('is refused before a passed BVN check (409 bvn_not_checked)', async () => {
      const res = await occupation(person(), {
        occupation: 'Filmmaker',
      }).expect(409);
      expect(body<null>(res).reason?.code).toBe('bvn_not_checked');
    });

    it('refuses an empty, letterless or marked-up occupation', async () => {
      const user = person();
      for (const bad of ['', '   ', '12345', '<b>x</b>', 'x'.repeat(81), 7]) {
        await occupation(user, { occupation: bad }).expect(400);
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('auth, and one person never reaches another’s', () => {
    it('every route needs a WAWU ID token; nothing goes to Fintava without one', async () => {
      await check(null, { bvn: BVNS.good, nin: NIN }).expect(401);
      await read(null).expect(401);
      await occupation(null, { occupation: 'Filmmaker' }).expect(401);
      await check(
        { id: 'x', auth: 'Bearer not-a-token' },
        { bvn: BVNS.good, nin: NIN },
      ).expect(401);
      expect(bvnCalls()).toHaveLength(0);
    });

    it('no route takes a person: a wawuUserId in the body is refused, and reads are the caller’s own', async () => {
      const a = person();
      const b = person();
      answerBvn({ status: 200, body: bvnAnswer(BVN_PHONE_SAME) });
      await check(a, { bvn: BVNS.good, nin: NIN }).expect(200);
      await occupation(a, { occupation: 'Filmmaker' }).expect(200);

      // B sees nothing of A's.
      const bView = body<WalletIdentityView>(await read(b).expect(200)).data;
      expect(bView).toEqual({
        bvn: null,
        ninLast4: null,
        occupation: null,
        checksLeft: 3,
      });
      // B cannot aim a request at A.
      await check(b, { bvn: BVNS.good, nin: NIN, wawuUserId: a.id }).expect(
        400,
      );
      await occupation(b, { occupation: 'Thief', wawuUserId: a.id }).expect(
        400,
      );
      await occupation(b, { occupation: 'Thief' }).expect(409);
      // B's own check writes B's row only.
      await check(b, { bvn: BVNS.mismatch, nin: '70190000888' }).expect(200);
      const aRow = await prisma.walletIdentity.findUniqueOrThrow({
        where: { wawuUserId: a.id },
      });
      expect(aRow).toMatchObject({
        bvnLast4: '0111',
        ninLast4: '0999',
        occupation: 'Filmmaker',
      });
      const aView = body<WalletIdentityView>(await read(a).expect(200)).data!;
      expect(aView.checksLeft).toBe(2);
      // A's identity does not match with B's numbers, nor B's with A's.
      await expect(
        service.matchesCheckedIdentity(b.id, BVNS.good, NIN),
      ).resolves.toBe(false);
      await expect(
        service.matchesCheckedIdentity(a.id, BVNS.mismatch, '70190000888'),
      ).resolves.toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe('requests', () => {
    it('a malformed BVN or NIN is a 400 that does not repeat it, and nothing is sent', async () => {
      const user = person();
      for (const payload of [
        { bvn: '2219000011', nin: NIN },
        { bvn: '221900001111', nin: NIN },
        { bvn: '2219 000 0111', nin: NIN },
        { bvn: 22190000111, nin: NIN },
        { bvn: BVNS.good, nin: '7019000099' },
        { bvn: BVNS.good },
        {},
      ]) {
        const res = await check(user, payload).expect(400);
        expect(res.text).not.toContain('2219000011');
        expect(res.text).not.toContain('7019000099');
      }
      expect(bvnCalls()).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('settings', () => {
    it('without IDENTITY_HASH_KEY the check answers 503 and nothing is sent', async () => {
      const hasher = new IdentityHasher(
        new ConfigService({ IDENTITY_HASH_KEY: '' }),
      );
      expect(hasher.configured).toBe(false);
      const bare = new WalletIdentityService(prisma, fintava, hasher);
      const user = person();
      await expect(
        bare.checkBvn(user.id, ACCOUNT_PHONE, { bvn: BVNS.good, nin: NIN }),
      ).rejects.toMatchObject({
        code: 'provider_unreachable',
      });
      await expect(
        bare.matchesCheckedIdentity(user.id, BVNS.good, NIN),
      ).resolves.toBe(false);
      expect(bvnCalls()).toHaveLength(0);
    });

    it('a set but short key, or a wrong daily limit, stops the app at boot; the key never prints', () => {
      expect(
        () =>
          new IdentityHasher(new ConfigService({ IDENTITY_HASH_KEY: 'short' })),
      ).toThrow(IdentityConfigError);
      expect(
        () =>
          new IdentityHasher(
            new ConfigService({
              IDENTITY_HASH_KEY: HASH_KEY,
              BVN_CHECKS_PER_DAY: '0',
            }),
          ),
      ).toThrow(IdentityConfigError);
      const hasher = new IdentityHasher(
        new ConfigService({ IDENTITY_HASH_KEY: HASH_KEY }),
      );
      expect(inspect(hasher)).not.toContain(HASH_KEY);
      expect(JSON.stringify(hasher)).not.toContain(HASH_KEY);
      expect(hasher.hash('bvn', BVNS.good)).not.toBe(
        hasher.hash('nin', BVNS.good),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Runs last: everything above has gone through every path.
  it('no log line and no answer anywhere in this file carries a full BVN, NIN or the BVN record’s phone', async () => {
    // One more pass through the riskiest path, a BVN Fintava echoes back in
    // its refusal, as a careless provider might.
    const user = person();
    answerBvn({
      status: 400,
      body: fintavaError(
        400,
        `Invalid BVN ${BVNS.logged} for phone ${BVN_PHONE_OTHER}`,
      ),
    });
    await check(user, { bvn: BVNS.logged, nin: NIN }).expect(422);

    const secrets = [
      ...Object.values(BVNS),
      NIN,
      '70190000888',
      BVN_PHONE_SAME,
      BVN_PHONE_OTHER,
      HASH_KEY,
    ];
    // The proof is only worth something if the capture saw the app's logs.
    expect(captured.join('\n')).toMatch(/verify BVN/);
    for (const text of [...captured, ...answered]) {
      for (const secret of secrets) {
        expect({ secret, leaked: text.includes(secret) }).toEqual({
          secret,
          leaked: false,
        });
      }
    }
  });
});
