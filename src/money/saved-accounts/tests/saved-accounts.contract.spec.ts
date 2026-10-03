import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import {
  ConsoleLogger,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import * as jwt from 'jsonwebtoken';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import {
  BANKS,
  BVN_200,
  FintavaDouble,
  fintavaError,
  NAME_ENQUIRY,
  type SeenRequest,
} from '../../../../test/fintava/fintava-double';
import { WawuIdClient } from '../../../common/auth/wawu-id.client';
import { WawuJwtStrategy } from '../../../common/auth/wawu-jwt.strategy';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { FINTAVA_DEFAULTS } from '../../../fintava/fintava-config';
import type { MoneyErrorReason } from '../../dto/money-error.dto';
import { IdentityHasher } from '../../identity/identity-config';
import { MoneyModule } from '../../money.module';
import type {
  BeneficiaryView,
  PayoutAccountView,
  WalletView,
} from '../../money-view.type';
import {
  BANK_UNREACHABLE_MESSAGE,
  BankAccountCheckService,
  NAME_CHECK_FAILED_MESSAGE,
} from '../bank-account-check.service';
import { BENEFICIARIES_MAX } from '../beneficiary.service';
import { SAVED_ACCOUNTS_NOT_OPEN_MESSAGE } from '../open-wallet-gate';

/**
 * Saved beneficiaries and the payout account (task WALLET-14) over HTTP:
 * the real MoneyModule, a real database, real RS256 tokens checked against
 * the mock WAWU ID's JWKS (WAWU_ID_JWKS_URL), and the real MONEY-06 client
 * talking over a socket to the local Fintava double, which answers with the
 * bodies the sandbox sent (`/banks`, `/name/enquiry`) and Fintava's
 * documented BVN record. Every person is a new wawuUserId that owns its rows;
 * afterAll deletes them.
 *
 * The BVN name comes from the real KYC-01 route: each person whose name is
 * compared first passes `POST /money/identity/bvn`, which now keeps the
 * BVN record's first and last name as keyed word hashes only.
 */

const KEY = 'live_test_w14_0123456789FAKEKEY';
const HASH_KEY = 'w14-test-identity-hash-key-0123456789abcdef';
/** No sub-second client timeouts in specs (FIX-02). */
const READ_TIMEOUT_MS = 1000;

const ENV: Record<string, string> = {
  FINTAVA_BASE_URL: '',
  FINTAVA_API_KEY: KEY,
  FINTAVA_TIMEOUT_MS: String(READ_TIMEOUT_MS),
  FINTAVA_CHECK_TIMEOUT_MS: String(READ_TIMEOUT_MS),
  IDENTITY_HASH_KEY: HASH_KEY,
};

/** The phone on Fintava's documented BVN record (`BVN_200`), as the account's. */
const ACCOUNT_PHONE = '+2349012345678';
const BVN = '12345678901';
const NIN = '70190000999';
/** GTBank in Fintava's list (`sandbox/01-`); the sandbox stub account (`sandbox/02-`). */
const GTB = '000013';
const STUB_ACCOUNT = '0123456789';

const BANK_LIST = {
  ...BANKS,
  data: [
    ...BANKS.data,
    {
      id: 'g',
      createdAt: 'x',
      updatedAt: 'x',
      code: GTB,
      name: 'GTBANK PLC',
    },
    {
      id: 'h',
      createdAt: 'x',
      updatedAt: 'x',
      code: '000014',
      name: 'ACCESS BANK',
    },
  ],
};

function mintToken(sub: string, phone = ACCOUNT_PHONE): string {
  const privateKey = readFileSync(
    join(__dirname, '../../../../mock-wawu-id/private.pem'),
    'utf8',
  );
  return jwt.sign(
    {
      sub,
      email: `w14-${sub}@test.wawu.dev`,
      phone,
      firstName: 'Saved',
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

/** Every log line the app writes in this file, and every answer, for the leak check. */
const captured: string[] = [];
const restores: Array<() => void> = [];
function capture(target: object, method: string): void {
  const t = target as Record<string, (...a: unknown[]) => unknown>;
  const original = t[method];
  t[method] = (...args: unknown[]) => {
    captured.push(
      args
        .map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 6 })))
        .join(' '),
    );
    return true;
  };
  restores.push(() => {
    t[method] = original;
  });
}
const answered: string[] = [];
const body = <T>(res: Response): Envelope<T> => {
  answered.push(res.text);
  return res.body as Envelope<T>;
};

/** A name check answer as the sandbox sends it, for this name. */
function nameAnswer(
  accountName: string | null,
  over: Record<string, unknown> = {},
) {
  return {
    ...NAME_ENQUIRY,
    data: {
      ...NAME_ENQUIRY.data,
      account: { ...NAME_ENQUIRY.data.account, accountName, ...over },
    },
  };
}

/** Names WAWU ID gives saved WAWU users, keyed by id (a stand-in for /internal/users/lookup). */
const identities = new Map<
  string,
  { firstName: string | null; lastName: string | null }
>();
const fakeWawuId = {
  lookupPublicIdentities: (ids: string[]) =>
    Promise.resolve(
      new Map(
        ids
          .filter((id) => identities.has(id))
          .map((id) => [
            id,
            { ...identities.get(id)!, verificationTier: 'basic' },
          ]),
      ),
    ),
};

describe('Saved beneficiaries and the payout account (WALLET-14) over HTTP', () => {
  const logger = new ConsoleLogger({
    logLevels: ['log', 'error', 'warn', 'debug', 'verbose', 'fatal'],
  });
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let hasher: IdentityHasher;
  let checker: BankAccountCheckService;
  const double = new FintavaDouble();
  const users: string[] = [];
  const previous: Record<string, string | undefined> = {};

  type Person = { id: string; auth: string };
  function person(phone?: string): Person {
    const id = randomUUID();
    users.push(id);
    return { id, auth: `Bearer ${mintToken(id, phone)}` };
  }

  /** A person whose wallet is open (as MONEY-12 records it). */
  async function withWallet(phone?: string): Promise<Person> {
    const who = person(phone);
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId: who.id,
        customerId: randomUUID(),
        walletId: randomUUID(),
        accountNumber: `19${String(Date.now()).slice(-5)}${String(users.length).padStart(3, '0')}`,
      },
    });
    return who;
  }

  /** A person who passed the real BVN check (KYC-01) and whose wallet is open. */
  async function verified(
    record: Record<string, unknown> = {},
  ): Promise<Person> {
    const who = person();
    double.on('GET', '/compliance/verify/bvn', {
      status: 200,
      body: { data: { ...BVN_200.data, ...record } },
    });
    const res = await http()
      .post('/api/hub/money/identity/bvn')
      .set('Authorization', who.auth)
      .send({ bvn: BVN, nin: NIN });
    expect(res.status).toBe(200);
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId: who.id,
        customerId: randomUUID(),
        walletId: randomUUID(),
        accountNumber: `18${String(Date.now()).slice(-5)}${String(users.length).padStart(3, '0')}`,
      },
    });
    return who;
  }

  const http = () => request(app.getHttpServer());
  const authed = (req: request.Test, who: Person | null) =>
    who ? req.set('Authorization', who.auth) : req;
  const getPayout = (who: Person | null) =>
    authed(http().get('/api/hub/money/payout-account'), who);
  const putPayout = (who: Person | null, payload: unknown) =>
    authed(http().put('/api/hub/money/payout-account'), who).send(
      payload as object,
    );
  const list = (who: Person | null) =>
    authed(http().get('/api/hub/money/beneficiaries'), who);
  const save = (who: Person | null, payload: unknown) =>
    authed(http().post('/api/hub/money/beneficiaries'), who).send(
      payload as object,
    );
  const remove = (who: Person | null, id: string) =>
    authed(http().delete(`/api/hub/money/beneficiaries/${id}`), who);

  const nameChecks = (): SeenRequest[] =>
    double.seen.filter((s) => s.path === '/name/enquiry');
  const bankLists = (): SeenRequest[] =>
    double.seen.filter((s) => s.path === '/banks');

  /** The bank list, and the name the bank gives every account (or a handler). */
  function bank(
    answer: Parameters<FintavaDouble['on']>[2] = {
      status: 200,
      body: nameAnswer('SIMI MICHELLE'),
    },
  ) {
    double.on('GET', '/banks', { status: 200, body: BANK_LIST });
    double.on('GET', '/name/enquiry', answer);
  }

  function expectRefusal(
    res: Response,
    status: number,
    code: string,
    message?: string,
  ) {
    expect(res.status).toBe(status);
    const b = body<unknown>(res);
    expect(b.data).toBeNull();
    expect(b.reason?.code).toBe(code);
    if (message) expect(b.reason?.message).toBe(message);
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
      .overrideProvider(WawuIdClient)
      .useValue(fakeWawuId)
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
    // One server for the whole file (FIX-02): parallel requests below.
    await app.listen(0, '127.0.0.1');
    prisma = moduleRef.get(PrismaService);
    hasher = moduleRef.get(IdentityHasher);
    checker = moduleRef.get(BankAccountCheckService);
  });

  beforeEach(() => double.reset());

  afterAll(async () => {
    if (prisma) {
      await prisma.moneyBeneficiary.deleteMany({
        where: {
          OR: [
            { ownerWawuId: { in: users } },
            { recipientWawuId: { in: users } },
          ],
        },
      });
      await prisma.moneyPayoutAccount.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.walletIdentity.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.bvnCheckAttempt.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.fintavaWalletOpening.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.fintavaWallet.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.userProfile.deleteMany({
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
  describe('the BVN name, kept by the BVN check (KYC-01) as keyed word hashes', () => {
    it('stores one keyed hash per word of the first and last name, and no column holds the name', async () => {
      const who = await verified({
        first_name: 'Chidinma Adaeze',
        middle_name: 'Ngozi',
        last_name: 'Okorowawu',
      });
      const row = await prisma.walletIdentity.findUniqueOrThrow({
        where: { wawuUserId: who.id },
      });
      expect(row.bvnNameKeys).toEqual({
        first: [hasher.hash('name', 'CHIDINMA'), hasher.hash('name', 'ADAEZE')],
        last: [hasher.hash('name', 'OKOROWAWU')],
      });
      // Every text column of every table: the name words are nowhere.
      const columns = await prisma.$queryRawUnsafe<
        Array<{ table_name: string; column_name: string }>
      >(
        `SELECT table_name, column_name FROM information_schema.columns
         WHERE table_schema = 'public'
           AND data_type IN ('text', 'character varying', 'jsonb', 'json')`,
      );
      const hits: string[] = [];
      for (const { table_name, column_name } of columns) {
        const [{ n }] = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
          `SELECT count(*) AS n FROM "${table_name}"
           WHERE "${column_name}"::text ILIKE $1 OR "${column_name}"::text ILIKE $2`,
          '%Okorowawu%',
          '%Ngozi%',
        );
        if (Number(n) > 0) hits.push(`${table_name}.${column_name}`);
      }
      expect(hits).toEqual([]);
    });

    it('a record without a first or last name keeps no keys', async () => {
      const who = await verified({ first_name: '', last_name: 'Sandbox' });
      const row = await prisma.walletIdentity.findUniqueOrThrow({
        where: { wawuUserId: who.id },
      });
      expect(row.bvnNameKeys).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe('the payout account (A21, W17)', () => {
    it('is null until one is saved', async () => {
      const who = await withWallet();
      const res = await getPayout(who).expect(200);
      expect(body(res).data).toBeNull();
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('saves the bank code and the name the bank returned, and says it matches the BVN name', async () => {
      const who = await verified();
      bank({ status: 200, body: nameAnswer('SANDBOX ADA') });
      const res = await putPayout(who, {
        bankCode: GTB,
        accountNumber: STUB_ACCOUNT,
      }).expect(200);
      const view = body<PayoutAccountView>(res).data!;
      expect(view).toEqual({
        bankCode: GTB,
        bankName: 'GTBANK PLC',
        accountNumber: STUB_ACCOUNT,
        accountName: 'SANDBOX ADA',
        matchesBvnName: true,
        updatedAt: expect.any(String) as string,
      });
      expect(nameChecks()).toHaveLength(1);
      expect(nameChecks()[0].query).toEqual({
        accountNumber: STUB_ACCOUNT,
        sortCode: GTB,
      });

      // GET reads back the same thing.
      const again = body<PayoutAccountView>(await getPayout(who).expect(200));
      expect(again.data).toEqual(view);
    });

    it('flags an account whose name is not the BVN name, and saves it in place of the last one', async () => {
      const who = await verified();
      bank({ status: 200, body: nameAnswer('SANDBOX ADA') });
      await putPayout(who, {
        bankCode: GTB,
        accountNumber: STUB_ACCOUNT,
      }).expect(200);

      bank({
        status: 200,
        body: nameAnswer('SIMI MICHELLE', {
          bankCode: '000014',
          accountNumber: '0690000031',
        }),
      });
      const res = await putPayout(who, {
        bankCode: '000014',
        accountNumber: '0690000031',
      }).expect(200);
      const view = body<PayoutAccountView>(res).data!;
      expect(view.accountName).toBe('SIMI MICHELLE');
      expect(view.bankName).toBe('ACCESS BANK');
      expect(view.matchesBvnName).toBe(false);

      const read = body<PayoutAccountView>(await getPayout(who).expect(200));
      expect(read.data?.accountNumber).toBe('0690000031');
      expect(read.data?.matchesBvnName).toBe(false);
      expect(
        await prisma.moneyPayoutAccount.count({
          where: { wawuUserId: who.id },
        }),
      ).toBe(1);
    });

    it('never takes a name from the app: a body carrying one is refused and the bank is not asked', async () => {
      const who = await verified();
      bank();
      const res = await putPayout(who, {
        bankCode: GTB,
        accountNumber: STUB_ACCOUNT,
        accountName: 'ADA SANDBOX',
      });
      expect(res.status).toBe(400);
      expect(nameChecks()).toHaveLength(0);
      expect(
        await prisma.moneyPayoutAccount.findUnique({
          where: { wawuUserId: who.id },
        }),
      ).toBeNull();
    });

    it('matchesBvnName is null when there is no BVN name to compare with', async () => {
      // A wallet whose person has no passed check on record.
      const noCheck = await withWallet();
      bank({ status: 200, body: nameAnswer('SANDBOX ADA') });
      const a = body<PayoutAccountView>(
        await putPayout(noCheck, {
          bankCode: GTB,
          accountNumber: STUB_ACCOUNT,
        }).expect(200),
      );
      expect(a.data?.matchesBvnName).toBeNull();

      // A check whose record gave no first name.
      const noName = await verified({ first_name: null });
      bank({ status: 200, body: nameAnswer('SANDBOX ADA') });
      const b = body<PayoutAccountView>(
        await putPayout(noName, {
          bankCode: GTB,
          accountNumber: STUB_ACCOUNT,
        }).expect(200),
      );
      expect(b.data?.matchesBvnName).toBeNull();

      // A wallet opened under another BVN check than the one that kept the name.
      const other = await verified();
      await prisma.fintavaWalletOpening.create({
        data: {
          wawuUserId: other.id,
          state: 'open',
          bvnHash: 'f'.repeat(64).slice(0, 60) + randomUUID().slice(0, 4),
          bvnVerifiedAt: new Date(),
          phone: `+23490${String(Date.now()).slice(-8)}`,
        },
      });
      bank({ status: 200, body: nameAnswer('SANDBOX ADA') });
      const c = body<PayoutAccountView>(
        await putPayout(other, {
          bankCode: GTB,
          accountNumber: STUB_ACCOUNT,
        }).expect(200),
      );
      expect(c.data?.matchesBvnName).toBeNull();
    });

    it('the opening tied to the same check still compares', async () => {
      const who = await verified();
      const id = await prisma.walletIdentity.findUniqueOrThrow({
        where: { wawuUserId: who.id },
      });
      await prisma.fintavaWalletOpening.create({
        data: {
          wawuUserId: who.id,
          state: 'open',
          bvnHash: id.bvnHash!,
          bvnVerifiedAt: id.bvnVerifiedAt!,
          phone: ACCOUNT_PHONE,
        },
      });
      bank({ status: 200, body: nameAnswer('Ada Sandbox') });
      const res = body<PayoutAccountView>(
        await putPayout(who, {
          bankCode: GTB,
          accountNumber: STUB_ACCOUNT,
        }).expect(200),
      );
      expect(res.data?.matchesBvnName).toBe(true);
      await prisma.fintavaWalletOpening.delete({
        where: { wawuUserId: who.id },
      });
    });

    it('a name the bank does not confirm is 422 name_check_failed, and nothing changes', async () => {
      const who = await verified();
      bank({ status: 200, body: nameAnswer('SANDBOX ADA') });
      await putPayout(who, {
        bankCode: GTB,
        accountNumber: STUB_ACCOUNT,
      }).expect(200);

      // Each answer names the account asked about, except where the point
      // is that it names another one.
      const asked = { accountNumber: '0123456781' };
      for (const answer of [
        {
          status: 200,
          body: nameAnswer('SOMEONE', { ...asked, responseCode: '07' }),
        },
        {
          status: 200,
          body: {
            ...NAME_ENQUIRY,
            data: {
              status: false,
              account: { ...NAME_ENQUIRY.data.account, ...asked },
            },
          },
        },
        { status: 200, body: nameAnswer('', asked) },
        { status: 200, body: nameAnswer('   ', asked) },
        {
          status: 200,
          body: nameAnswer('OTHER', { accountNumber: '0123456780' }),
        },
        { status: 400, body: fintavaError(400, 'Invalid account number') },
      ]) {
        bank(answer);
        const res = await putPayout(who, {
          bankCode: GTB,
          accountNumber: '0123456781',
        });
        expectRefusal(res, 422, 'name_check_failed', NAME_CHECK_FAILED_MESSAGE);
      }
      const kept = body<PayoutAccountView>(await getPayout(who).expect(200));
      expect(kept.data?.accountNumber).toBe(STUB_ACCOUNT);
    });

    it('a bank code that is not in Fintava’s list is 422 before any name check', async () => {
      const who = await verified();
      bank();
      // 044 is Access Bank's old CBN code: the Flutterwave wallet's, not Fintava's.
      const res = await putPayout(who, {
        bankCode: '044',
        accountNumber: STUB_ACCOUNT,
      });
      expectRefusal(res, 422, 'name_check_failed');
      expect(nameChecks()).toHaveLength(0);
    });

    it('Fintava down, refusing our key, or too slow is 503 provider_unreachable, and nothing is saved', async () => {
      const who = await withWallet();
      for (const answer of [
        { status: 500, body: 'oops' },
        { status: 200, hangUp: true },
        { status: 400, body: fintavaError(400, 'Invalid API Key') },
        { status: 200, delayMs: READ_TIMEOUT_MS + 500, body: nameAnswer('X') },
      ]) {
        bank(answer);
        const res = await putPayout(who, {
          bankCode: GTB,
          accountNumber: STUB_ACCOUNT,
        });
        expectRefusal(
          res,
          503,
          'provider_unreachable',
          BANK_UNREACHABLE_MESSAGE,
        );
        expect(body(res).reason?.retryAfterSeconds).toBe(
          FINTAVA_DEFAULTS.retryAfterSeconds,
        );
      }
      expect(
        await prisma.moneyPayoutAccount.findUnique({
          where: { wawuUserId: who.id },
        }),
      ).toBeNull();
    });

    it('Fintava’s bank list not answering is 503 too, and no name check is sent', async () => {
      const who = await withWallet();
      // The list is kept for an hour; forget it so this request asks again.
      (checker as unknown as { banks: unknown }).banks = null;
      double.on('GET', '/banks', { status: 502, body: 'Bad Gateway' });
      double.on('GET', '/name/enquiry', {
        status: 200,
        body: nameAnswer('SIMI MICHELLE'),
      });
      const res = await putPayout(who, {
        bankCode: GTB,
        accountNumber: STUB_ACCOUNT,
      });
      expectRefusal(res, 503, 'provider_unreachable');
      expect(bankLists()).toHaveLength(1);
      expect(nameChecks()).toHaveLength(0);

      // Answering again, the list is read once and then kept.
      bank();
      await putPayout(who, {
        bankCode: GTB,
        accountNumber: STUB_ACCOUNT,
      }).expect(200);
      await putPayout(who, {
        bankCode: GTB,
        accountNumber: STUB_ACCOUNT,
      }).expect(200);
      expect(bankLists()).toHaveLength(2);
      expect(nameChecks()).toHaveLength(2);
    });

    it('refuses a bank code or account number in any other form (400, nothing sent)', async () => {
      const who = await withWallet();
      bank();
      for (const payload of [
        { bankCode: GTB, accountNumber: '0123 456 789' },
        { bankCode: GTB, accountNumber: '012345678' },
        { bankCode: 'GTB', accountNumber: STUB_ACCOUNT },
        { bankCode: GTB },
        { accountNumber: STUB_ACCOUNT },
      ]) {
        const res = await putPayout(who, payload);
        expect(res.status).toBe(400);
        expect(body(res).reason).toBeUndefined();
      }
      expect(nameChecks()).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('saved beneficiaries (W8, W12, W35)', () => {
    async function recipient(
      first: string,
      last: string,
      opts: { wallet?: boolean; tick?: 'creator' | 'professional' } = {},
    ): Promise<Person> {
      const who = opts.wallet === false ? person() : await withWallet();
      identities.set(who.id, { firstName: first, lastName: last });
      await prisma.userProfile.create({
        data: {
          wawuUserId: who.id,
          accountType: 'creator',
          handle: `w14_${who.id.slice(0, 8)}`,
          avatarUrl: 'https://cdn.test.wawu.dev/a.png',
          creatorVerifiedAt: opts.tick === 'creator' ? new Date() : null,
          professionalVerifiedAt:
            opts.tick === 'professional' ? new Date() : null,
        },
      });
      return who;
    }

    it('saves a bank account with the bank’s name for it, and lists it', async () => {
      const who = await withWallet();
      bank({ status: 200, body: nameAnswer('SIMI MICHELLE') });
      const res = await save(who, {
        kind: 'bank_account',
        bankCode: GTB,
        accountNumber: STUB_ACCOUNT,
      }).expect(201);
      const saved = body<BeneficiaryView>(res).data!;
      expect(saved).toEqual({
        id: expect.any(String) as string,
        kind: 'bank_account',
        wawuUser: null,
        bankAccount: {
          bankCode: GTB,
          bankName: 'GTBANK PLC',
          accountNumber: STUB_ACCOUNT,
          accountName: 'SIMI MICHELLE',
        },
        createdAt: expect.any(String) as string,
      });
      const listed = body<BeneficiaryView[]>(await list(who).expect(200));
      expect(listed.data).toEqual([saved]);

      // Saved again: the same row, and the bank is not asked again.
      const before = nameChecks().length;
      const again = body<BeneficiaryView>(
        await save(who, {
          kind: 'bank_account',
          bankCode: GTB,
          accountNumber: STUB_ACCOUNT,
        }).expect(201),
      );
      expect(again.data?.id).toBe(saved.id);
      expect(nameChecks()).toHaveLength(before);
    });

    it('a bank account the bank does not confirm is 422 and is not saved', async () => {
      const who = await withWallet();
      bank({
        status: 200,
        body: nameAnswer('SIMI MICHELLE', { responseCode: '25' }),
      });
      const res = await save(who, {
        kind: 'bank_account',
        bankCode: GTB,
        accountNumber: STUB_ACCOUNT,
      });
      expectRefusal(res, 422, 'name_check_failed');
      expect(body<BeneficiaryView[]>(await list(who).expect(200)).data).toEqual(
        [],
      );
    });

    it('saves a WAWU user with a wallet, named and ticked as WAWU ID and the profile say', async () => {
      const who = await withWallet();
      const them = await recipient('Chidinma', 'Okoro', { tick: 'creator' });
      const res = await save(who, {
        kind: 'wawu_user',
        wawuUserId: them.id,
      }).expect(201);
      expect(body<BeneficiaryView>(res).data).toEqual({
        id: expect.any(String) as string,
        kind: 'wawu_user',
        wawuUser: {
          wawuUserId: them.id,
          displayName: 'Chidinma Okoro',
          handle: `w14_${them.id.slice(0, 8)}`,
          avatarUrl: 'https://cdn.test.wawu.dev/a.png',
          tick: 'creator',
        },
        bankAccount: null,
        createdAt: expect.any(String) as string,
      });
      expect(nameChecks()).toHaveLength(0);
    });

    it('refuses a WAWU user without a wallet (409), an unknown person (404) and oneself (400)', async () => {
      const who = await withWallet();
      const noWallet = await recipient('No', 'Wallet', { wallet: false });
      expectRefusal(
        await save(who, { kind: 'wawu_user', wawuUserId: noWallet.id }),
        409,
        'recipient_has_no_wallet',
      );
      expectRefusal(
        await save(who, { kind: 'wawu_user', wawuUserId: randomUUID() }),
        404,
        'recipient_not_found',
      );
      expectRefusal(
        await save(who, { kind: 'wawu_user', wawuUserId: who.id }),
        400,
        'self_transfer',
      );
      expect(
        await prisma.moneyBeneficiary.count({ where: { ownerWawuId: who.id } }),
      ).toBe(0);
    });

    it('a body that names no place, or both kinds, is a plain 400 and nothing is asked', async () => {
      const who = await withWallet();
      const them = await recipient('Both', 'Kinds');
      bank();
      for (const payload of [
        { kind: 'wawu_user' },
        { kind: 'wawu_user', wawuUserId: 'not-a-uuid' },
        { kind: 'bank_account', bankCode: GTB },
        { kind: 'bank_account', accountNumber: STUB_ACCOUNT },
        { kind: 'bank_account', bankCode: GTB, accountNumber: '08031234567x' },
        {
          kind: 'wawu_user',
          wawuUserId: them.id,
          bankCode: GTB,
          accountNumber: STUB_ACCOUNT,
        },
        {
          kind: 'bank_account',
          wawuUserId: them.id,
          bankCode: GTB,
          accountNumber: STUB_ACCOUNT,
        },
        { kind: 'card' },
        {
          kind: 'bank_account',
          bankCode: GTB,
          accountNumber: STUB_ACCOUNT,
          accountName: 'MY NAME',
        },
      ]) {
        const res = await save(who, payload);
        expect({ payload, status: res.status }).toEqual({
          payload,
          status: 400,
        });
        expect(body(res).reason).toBeUndefined();
      }
      expect(nameChecks()).toHaveLength(0);
      expect(
        await prisma.moneyBeneficiary.count({ where: { ownerWawuId: who.id } }),
      ).toBe(0);
    });

    it('a saved beneficiary can be removed; removing again, or someone else’s, removes nothing and is 200', async () => {
      const a = await withWallet();
      const b = await withWallet();
      bank();
      const saved = body<BeneficiaryView>(
        await save(a, {
          kind: 'bank_account',
          bankCode: GTB,
          accountNumber: STUB_ACCOUNT,
        }).expect(201),
      ).data!;
      const other = await recipient('Kept', 'Person');
      const kept = body<BeneficiaryView>(
        await save(a, { kind: 'wawu_user', wawuUserId: other.id }).expect(201),
      ).data!;

      // B can neither see nor remove A's.
      expect(body<BeneficiaryView[]>(await list(b).expect(200)).data).toEqual(
        [],
      );
      const byB = await remove(b, saved.id).expect(200);
      expect(body(byB).data).toBeNull();
      expect(
        body<BeneficiaryView[]>(await list(a).expect(200)).data!.map(
          (x) => x.id,
        ),
      ).toEqual([kept.id, saved.id]);

      // A removes it.
      const res = await remove(a, saved.id).expect(200);
      expect(body(res).data).toBeNull();
      expect(
        body<BeneficiaryView[]>(await list(a).expect(200)).data!.map(
          (x) => x.id,
        ),
      ).toEqual([kept.id]);
      expect(
        await prisma.moneyBeneficiary.findUnique({ where: { id: saved.id } }),
      ).toBeNull();

      // Again: still 200, nothing else touched.
      await remove(a, saved.id).expect(200);
      await remove(a, randomUUID()).expect(200);
      expect(
        await prisma.moneyBeneficiary.count({ where: { ownerWawuId: a.id } }),
      ).toBe(1);
      // An id in any other form is a 400.
      expect((await remove(a, 'not-a-uuid')).status).toBe(400);
    });

    it('W35’s count is the list’s length, and a saved person whose wallet is gone leaves both', async () => {
      const who = await withWallet();
      bank();
      await save(who, {
        kind: 'bank_account',
        bankCode: GTB,
        accountNumber: STUB_ACCOUNT,
      }).expect(201);
      const them = await recipient('Gone', 'Soon');
      await save(who, { kind: 'wawu_user', wawuUserId: them.id }).expect(201);

      const wallet = async () =>
        body<WalletView>(
          await authed(http().get('/api/hub/money/wallet'), who).expect(200),
        ).data!;
      expect((await wallet()).beneficiaryCount).toBe(2);
      expect(body<BeneficiaryView[]>(await list(who)).data).toHaveLength(2);

      await prisma.fintavaWallet.delete({ where: { wawuUserId: them.id } });
      expect((await wallet()).beneficiaryCount).toBe(1);
      const left = body<BeneficiaryView[]>(await list(who)).data!;
      expect(left.map((x) => x.kind)).toEqual(['bank_account']);
    });

    it('two saves of the same place at the same moment keep one row', async () => {
      const who = await withWallet();
      bank({ status: 200, body: nameAnswer('SIMI MICHELLE'), delayMs: 100 });
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          save(who, {
            kind: 'bank_account',
            bankCode: GTB,
            accountNumber: STUB_ACCOUNT,
          }),
        ),
      );
      expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201]);
      const ids = new Set(
        results.map((r) => body<BeneficiaryView>(r).data!.id),
      );
      expect(ids.size).toBe(1);
      expect(
        await prisma.moneyBeneficiary.count({ where: { ownerWawuId: who.id } }),
      ).toBe(1);
    });

    it(`keeps at most ${BENEFICIARIES_MAX}, even for saves sent at the same moment`, async () => {
      const who = await withWallet();
      await prisma.moneyBeneficiary.createMany({
        data: Array.from({ length: BENEFICIARIES_MAX - 1 }, (_, i) => ({
          ownerWawuId: who.id,
          kind: 'bank_account',
          bankCode: GTB,
          bankName: 'GTBANK PLC',
          accountNumber: `55${String(i).padStart(8, '0')}`,
          accountName: 'SIMI MICHELLE',
        })),
      });
      bank((req) => ({
        status: 200,
        body: nameAnswer('SIMI MICHELLE', {
          accountNumber: req.query.accountNumber,
        }),
        delayMs: 50,
      }));
      const results = await Promise.all(
        ['6600000001', '6600000002', '6600000003'].map((accountNumber) =>
          save(who, { kind: 'bank_account', bankCode: GTB, accountNumber }),
        ),
      );
      expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
      for (const r of results.filter((x) => x.status === 409)) {
        expect(body(r).reason?.code).toBe('beneficiary_limit_reached');
      }
      expect(
        await prisma.moneyBeneficiary.count({ where: { ownerWawuId: who.id } }),
      ).toBe(BENEFICIARIES_MAX);

      // Full: refused before the bank is asked.
      const asked = nameChecks().length;
      expectRefusal(
        await save(who, {
          kind: 'bank_account',
          bankCode: GTB,
          accountNumber: '6600000009',
        }),
        409,
        'beneficiary_limit_reached',
      );
      expect(nameChecks()).toHaveLength(asked);
      expect(body<BeneficiaryView[]>(await list(who)).data).toHaveLength(
        BENEFICIARIES_MAX,
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('who can call them', () => {
    const someId = randomUUID();
    const routes = (who: Person | null) => [
      list(who),
      save(who, {
        kind: 'bank_account',
        bankCode: GTB,
        accountNumber: STUB_ACCOUNT,
      }),
      remove(who, someId),
      getPayout(who),
      putPayout(who, { bankCode: GTB, accountNumber: STUB_ACCOUNT }),
    ];

    it('every route needs a WAWU ID token; nothing goes to Fintava without one', async () => {
      bank();
      for (const res of await Promise.all(routes(null))) {
        expect(res.status).toBe(401);
      }
      expect(double.seen).toHaveLength(0);
    });

    it('without a wallet every route is 409 wallet_not_open, and the bank is not asked', async () => {
      const who = person();
      bank();
      for (const res of await Promise.all(routes(who))) {
        expectRefusal(
          res,
          409,
          'wallet_not_open',
          SAVED_ACCOUNTS_NOT_OPEN_MESSAGE,
        );
      }
      expect(double.seen).toHaveLength(0);
    });

    it('while the account is being opened every route is 409 wallet_opening', async () => {
      const who = person();
      await prisma.fintavaWalletOpening.create({
        data: {
          wawuUserId: who.id,
          state: 'opening',
          bvnHash: randomUUID().replace(/-/g, '').padEnd(64, '0'),
          bvnVerifiedAt: new Date(),
          phone: `+23490${String(Date.now()).slice(-8)}`,
        },
      });
      bank();
      for (const res of await Promise.all(routes(who))) {
        expectRefusal(res, 409, 'wallet_opening');
      }
      expect(double.seen).toHaveLength(0);
    });

    it('a wawuUserId in a payout body is refused: the account is always the caller’s', async () => {
      const a = await withWallet();
      const b = await withWallet();
      bank();
      const res = await putPayout(a, {
        bankCode: GTB,
        accountNumber: STUB_ACCOUNT,
        wawuUserId: b.id,
      });
      expect(res.status).toBe(400);
      expect(
        await prisma.moneyPayoutAccount.count({
          where: { wawuUserId: { in: [a.id, b.id] } },
        }),
      ).toBe(0);
    });
  });

  it('no log line carries an account number, an account name or a BVN', () => {
    const logs = captured.join('\n');
    for (const secret of [
      STUB_ACCOUNT,
      '0690000031',
      'SIMI MICHELLE',
      BVN,
      NIN,
      'Okorowawu',
    ]) {
      expect({ secret, inLogs: logs.includes(secret) }).toEqual({
        secret,
        inLogs: false,
      });
    }
    // Answers carry the account (that is their job) but never the BVN.
    for (const a of answered) {
      expect(a).not.toContain(BVN);
      expect(a).not.toContain(NIN);
    }
  });
});
