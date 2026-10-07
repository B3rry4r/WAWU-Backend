import { randomInt, randomUUID } from 'node:crypto';
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
  BVN_200,
  type CannedAnswer,
  FintavaDouble,
  fintavaError,
  fintavaValidation,
  SELFIE_MATCHED,
  type SeenRequest,
  WALLET_BALANCE,
} from '../../../../test/fintava/fintava-double';
import { jpegImage } from '../../../../test/fixtures/selfie/selfie-images';
import { WawuIdClient } from '../../../common/auth/wawu-id.client';
import { WawuJwtStrategy } from '../../../common/auth/wawu-jwt.strategy';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { FintavaClient } from '../../../fintava/fintava-client';
import type { FintavaBvnDigest } from '../../../fintava/fintava.interface';
import type { MoneyErrorReason } from '../../dto/money-error.dto';
import { WalletIdentityService } from '../../identity/wallet-identity.service';
import { MoneyModule } from '../../money.module';
import type { WalletView } from '../../money-view.type';
import { AccountPurgeService } from '../../../account-purge/account-purge.service';
import type { OpenNairaWalletDto } from '../dto/open-wallet.dto';
import {
  PHONE_HELD_MESSAGE,
  WalletOpeningService,
} from '../wallet-opening.service';

/**
 * Opening the account at Fintava (task MONEY-12) over HTTP: the real
 * MoneyModule, a real database, real RS256 tokens checked against the
 * stand-in WAWU ID's JWKS (WAWU_ID_JWKS_URL), and the real MONEY-06 client
 * talking over a socket to a stateful stand-in for Fintava's customer
 * routes built on the local double: a create adds a customer (with the
 * sandbox's 201 shape, `sandbox/07-`), the details, by-id and list reads find
 * it, and an unknown phone is the sandbox's own `404 ["Customer not
 * found"]` (`sandbox/32-money12-account.md`). Every read carries the
 * customer's full `userInfo.bvn` and `dateOfBirth`, as the sandbox's do
 * (round 2: the first stand-in left them out, which hid D1). Each person passes the BVN
 * check (KYC-01) and the selfie (KYC-02) through their own routes first, as
 * the app does; the selfie's pass is the KYC-02 stand-in `SELFIE_MATCHED`,
 * since no real selfie has matched in the sandbox yet (G-25).
 *
 * Every Fintava timeout is 2 s here, so a create the stand-in answers
 * 2.5 s after it arrived is a lost answer: Fintava made the customer and the
 * client never heard. Every log line the app writes during the file is
 * captured, and every answer kept: the last tests prove no BVN, NIN, date of
 * birth or address reached a log, an answer or a column.
 *
 * Timing (FIX-02). The stand-in runs in this process, so a busy machine
 * stalls its answers and the client's deadline together. An answer meant to
 * arrive in time must fit the timeout with room for that stall: at 300 ms a
 * stall of 0.5 to 0.9 s under CPU load turned the lookup before the create
 * into a timeout, a correct `503 provider_unreachable` for a Fintava that
 * did not answer in time, and failed the double tap. A late answer needs no
 * room: its timer is set after the client's deadline and runs out after it
 * (LATE_MS > TIMEOUT_MS), so the deadline always fires first, however slow
 * the machine. The app listens on one port for the whole file (beforeAll):
 * see FIX-02 in the mobile repo for why per-request servers reset taps.
 */

const KEY = 'live_test_m12_open_0123456789FAKEKEY';
const HASH_KEY = 'm12-test-opening-hash-key-0123456789abcdef';
const TIMEOUT_MS = 2_000;
const LATE_MS = TIMEOUT_MS + 500;

// A lost answer waits out the client's timeout, then the late answer.
jest.setTimeout(30_000);

const ENV: Record<string, string> = {
  FINTAVA_BASE_URL: '',
  FINTAVA_API_KEY: KEY,
  FINTAVA_TIMEOUT_MS: String(TIMEOUT_MS),
  FINTAVA_MONEY_TIMEOUT_MS: String(TIMEOUT_MS),
  FINTAVA_CHECK_TIMEOUT_MS: String(TIMEOUT_MS),
  FINTAVA_RESEND_SAFETY_MS: '',
  IDENTITY_HASH_KEY: HASH_KEY,
  BVN_CHECKS_PER_DAY: '',
  SELFIE_CHECKS_PER_DAY: '',
  WALLET_BANK_NAME: '',
  WALLET_LICENCE_LINE: '',
  WALLET_DEPOSIT_INSURANCE_LINE: '',
};

/** The resend window with the defaults: money timeout plus ten minutes. */
const RESEND_AFTER_MS = TIMEOUT_MS + 10 * 60_000;

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
const answered: string[] = [];

/** Made-up digits, distinct per person, so a leak names its source. */
function digits(n: number): string {
  let out = String(randomInt(1, 10));
  while (out.length < n) out += String(randomInt(0, 10));
  return out;
}

type Person = {
  id: string;
  auth: string;
  /** E.164, the account's and the BVN record's. */
  phone: string;
  local: string;
  bvn: string;
  nin: string;
  details: OpenBody;
};
type OpenBody = {
  bvn: string;
  nin: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  address: string;
};

/** Every identity value sent in this file, for the final scans. */
const secrets: string[] = [];

/** A date of birth no other person or customer in this file has. */
const datesUsed = new Set<string>();
function uniqueDate(): string {
  for (;;) {
    const d = `19${randomInt(40, 99)}-${String(randomInt(1, 13)).padStart(2, '0')}-${String(randomInt(10, 29))}`;
    if (!datesUsed.has(d)) {
      datesUsed.add(d);
      return d;
    }
  }
}

function mintToken(
  sub: string,
  phone: string,
  email: string | null = `open-${sub}@example.com`,
): string {
  const privateKey = readFileSync(
    join(__dirname, '../../../../mock-wawu-id/private.pem'),
    'utf8',
  );
  return jwt.sign(
    {
      sub,
      email,
      phone,
      firstName: 'Open',
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

// ---------------------------------------------------------------------------
// A stateful stand-in for Fintava's customers.
// ---------------------------------------------------------------------------
type Made = {
  customerId: string;
  recordId: string;
  walletId: string;
  accountNumber: string;
  accountName: string;
  /** Local `0...` form. */
  phone: string;
  createdAt: string;
  /** As Fintava's reads carry it, in full (`sandbox/32-`, call 4 of round 2). */
  bvn: string;
  dateOfBirth: string;
};

describe('Opening the Fintava account (MONEY-12) over HTTP', () => {
  const logger = new ConsoleLogger({
    logLevels: ['log', 'error', 'warn', 'debug', 'verbose', 'fatal'],
  });
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let opening: WalletOpeningService;
  let identity: WalletIdentityService;
  let client: FintavaClient;
  const fintavaClient = () => client;
  const realLookup = (phone: string, digest: FintavaBvnDigest) =>
    FintavaClient.prototype.lookupCustomerByPhone.call(client, phone, digest);
  const double = new FintavaDouble();
  const users: string[] = [];
  const previous: Record<string, string | undefined> = {};

  /** Customers the stand-in holds, newest first. */
  let customers: Made[] = [];
  /** How the next create is answered. */
  let createMode:
    | { kind: 'ok' }
    | { kind: 'late' }
    | { kind: 'made_then_500' }
    | { kind: 'nothing_then_500' }
    | { kind: 'made_then_unreadable' }
    | { kind: 'refuse'; answer: CannedAnswer } = { kind: 'ok' };
  /** How the details lookup answers, when not by the customers held. */
  let detailsOverride: ((req: SeenRequest) => CannedAnswer) | null = null;
  /** How the list answers, when not by the customers held. */
  let listOverride: ((req: SeenRequest) => CannedAnswer) | null = null;

  function makeCustomer(
    phone: string,
    first: string,
    last: string,
    bvn: string,
    opts: { dateOfBirth?: string; createdAt?: string } = {},
  ): Made {
    const m: Made = {
      customerId: randomUUID(),
      recordId: randomUUID(),
      walletId: randomUUID(),
      accountNumber: digits(10),
      accountName: `${first} ${last}`,
      phone,
      createdAt: opts.createdAt ?? new Date().toISOString(),
      bvn,
      dateOfBirth: opts.dateOfBirth ?? '1970-01-01',
    };
    customers.unshift(m);
    return m;
  }
  /** A customer someone else made at Fintava for this phone: their BVN, name, date of birth. */
  function stranger(phone: string, createdAt?: string): Made {
    const bvn = digits(11);
    const dateOfBirth = uniqueDate();
    secrets.push(bvn, dateOfBirth);
    return makeCustomer(phone, 'Chidi', 'Stranger', bvn, {
      dateOfBirth,
      createdAt,
    });
  }
  const userInfo = (m: Made) => ({
    id: m.customerId,
    createdAt: m.createdAt,
    updatedAt: m.createdAt,
    firstName: m.accountName.split(' ')[0],
    lastName: m.accountName.split(' ')[1],
    phoneNumber: m.phone,
    bvn: m.bvn,
    dateOfBirth: m.dateOfBirth,
    roles: ['USER'],
    userType: 'CUSTOMER',
    nin: null,
    twoFA: false,
  });
  const walletRead = (m: Made) => ({
    id: m.walletId,
    accountNumber: m.accountNumber,
    accountName: m.accountName,
    isFrozen: false,
    status: 'active',
    fundMethod: 'STATIC_FUND',
    tagpayCustomerId: randomUUID(),
    tagpayWalletId: m.accountNumber,
    currency: 'NGN',
    serviceProvider: 'loma',
    tier: 'TIER_2',
  });
  const created201 = (m: Made) => ({
    data: {
      userInfo: userInfo(m),
      wallet: {
        id: m.walletId,
        accountNumber: m.accountNumber,
        accountName: m.accountName,
        isFrozen: false,
        status: 'active',
        fundMethod: 'STATIC_FUND',
      },
    },
    status: 201,
    message: 'User created successfully',
  });

  function installFintava(): void {
    double.on('GET', /^\/customers\/[^/]+$/, (req) => {
      const id = req.path.split('/')[2];
      const m = customers.find((c) => c.customerId === id);
      return m
        ? {
            status: 200,
            body: {
              data: {
                id: m.recordId,
                phone: m.phone,
                customerType: 'INDIVIDUAL',
                approvalStatus: 'PENDING',
                userInfo: userInfo(m),
                wallet: walletRead(m),
              },
              status: 200,
              message: 'Customer record fetched',
            },
          }
        : { status: 404, body: fintavaError(404, 'Customer not found') };
    });
    double.on('GET', '/customers/details', (req) => {
      if (detailsOverride) return detailsOverride(req);
      const m = customers.find((c) => c.phone === req.query.phone);
      return m
        ? {
            status: 200,
            body: {
              data: {
                id: m.recordId,
                phone: m.phone,
                userInfo: { ...userInfo(m), auth: null },
              },
              status: 200,
              message: 'Customer record fetched',
            },
          }
        : { status: 404, body: fintavaError(404, 'Customer not found') };
    });
    double.on('GET', '/customers/list', (req) => {
      if (listOverride) return listOverride(req);
      const take = Number(req.query.take);
      const page = Number(req.query.page);
      const rows = customers.slice((page - 1) * take, page * take);
      return {
        status: 200,
        body: {
          data: rows.map((m) => ({
            id: m.recordId,
            createdAt: m.createdAt,
            phone: m.phone,
            userInfo: { ...userInfo(m), wallet: walletRead(m) },
          })),
          meta: {
            page: String(page),
            take: String(take),
            itemCount: customers.length,
            pageCount: Math.ceil(customers.length / take),
            hasPreviousPage: page > 1,
            hasNextPage: page * take < customers.length,
          },
          message: 'Merchant customers list fetched',
          status: 200,
        },
      };
    });
    double.on('POST', '/create/customer', (req) => {
      const b = req.body as {
        phoneNumber: string;
        firstName: string;
        lastName: string;
        bvn: string;
        dateOfBirth: string;
      };
      const mode = createMode;
      switch (mode.kind) {
        case 'refuse':
          return mode.answer;
        case 'nothing_then_500':
          return { status: 500, body: fintavaError(500, 'read ECONNRESET') };
        default: {
          const m = makeCustomer(
            b.phoneNumber,
            b.firstName,
            b.lastName,
            b.bvn,
            {
              dateOfBirth: b.dateOfBirth,
            },
          );
          if (mode.kind === 'late') {
            return { status: 201, body: created201(m), delayMs: LATE_MS };
          }
          if (mode.kind === 'made_then_500') {
            return { status: 500, body: fintavaError(500, 'read ECONNRESET') };
          }
          if (mode.kind === 'made_then_unreadable') {
            return { status: 201, body: {} };
          }
          return { status: 201, body: created201(m) };
        }
      }
    });
    double.on('GET', /^\/customer\/wallet\/balance\/.+$/, {
      status: 200,
      body: WALLET_BALANCE,
    });
  }

  const creates = () =>
    double.seen.filter(
      (s) => s.method === 'POST' && s.path === '/create/customer',
    );
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // -------------------------------------------------------------------------
  const http = () => request(app.getHttpServer());

  function person(
    email: string | null | undefined = undefined,
    shared?: Partial<Pick<Person, 'phone' | 'bvn' | 'nin'>>,
  ): Person {
    const id = randomUUID();
    users.push(id);
    const local = shared?.phone
      ? `0${shared.phone.slice(4)}`
      : `080${digits(8)}`;
    const phone = `+234${local.slice(1)}`;
    const bvn = shared?.bvn ?? digits(11);
    const nin = shared?.nin ?? digits(11);
    const details: OpenBody = {
      bvn,
      nin,
      firstName: 'Amaka',
      lastName: 'Opener',
      dateOfBirth: uniqueDate(),
      address: `${randomInt(10, 999)} Opening Close, Yaba, Lagos`,
    };
    secrets.push(bvn, nin, details.address, details.dateOfBirth);
    const token =
      email === undefined ? mintToken(id, phone) : mintToken(id, phone, email);
    return { id, auth: `Bearer ${token}`, phone, local, bvn, nin, details };
  }

  /** KYC-01's BVN check, passed, through its own route. */
  async function bvnChecked(
    who: Person,
    bvn = who.bvn,
    nin = who.nin,
  ): Promise<void> {
    double.on('GET', '/compliance/verify/bvn', {
      status: 200,
      body: { data: { ...BVN_200.data, bvn, phone_number1: who.local } },
    });
    await http()
      .post('/api/hub/money/identity/bvn')
      .set('Authorization', who.auth)
      .send({ bvn, nin })
      .expect(200);
  }

  /** KYC-02's selfie, matched (the stand-in pass), through its own route. */
  async function selfieMatched(who: Person, bvn = who.bvn): Promise<void> {
    double.on('POST', '/compliance/verify/bvn/selfie', {
      status: 200,
      body: SELFIE_MATCHED,
    });
    await http()
      .post('/api/hub/money/identity/selfie')
      .set('Authorization', who.auth)
      .send({ bvn, image: jpegImage().toString('base64') })
      .expect(200);
  }

  /** Both identity steps, then the double is cleared for the opening. */
  async function ready(who: Person): Promise<void> {
    await bvnChecked(who);
    await selfieMatched(who);
    double.reset();
    installFintava();
  }

  const open = (who: Person | null, payload?: unknown) => {
    const req = http().post('/api/hub/money/wallet/open');
    return (who ? req.set('Authorization', who.auth) : req).send(
      payload ?? (who ? who.details : {}),
    );
  };
  const wallet = (who: Person) =>
    http().get('/api/hub/money/wallet').set('Authorization', who.auth);
  const row = (who: Person) =>
    prisma.fintavaWalletOpening.findUnique({ where: { wawuUserId: who.id } });
  const walletRow = (who: Person) =>
    prisma.fintavaWallet.findUnique({ where: { wawuUserId: who.id } });
  /** Moves the attempt back in time, as if it was sent `ms` ago. */
  const age = (who: Person, ms: number) =>
    prisma.fintavaWalletOpening.update({
      where: { wawuUserId: who.id },
      data: { attemptStartedAt: new Date(Date.now() - ms), checkedAt: null },
    });

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
    // One server for the whole file. Unlistened, supertest opens a server
    // per request and the first concurrent tap to finish closes it under
    // the others, resetting the taps still queued (read ECONNRESET).
    await app.listen(0, '127.0.0.1');
    prisma = moduleRef.get(PrismaService);
    opening = moduleRef.get(WalletOpeningService);
    identity = moduleRef.get(WalletIdentityService);
    client = moduleRef.get(FintavaClient);
  });

  beforeEach(() => {
    double.reset();
    customers = [];
    createMode = { kind: 'ok' };
    detailsOverride = null;
    listOverride = null;
    installFintava();
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    if (prisma) {
      const where = { wawuUserId: { in: users } };
      await prisma.fintavaWalletOpening.deleteMany({ where });
      await prisma.fintavaWallet.deleteMany({ where });
      await prisma.selfieMatchAttempt.deleteMany({ where });
      await prisma.walletIdentity.deleteMany({ where });
      await prisma.bvnCheckAttempt.deleteMany({ where });
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
  describe('a person who finished Open your wallet gets their own account', () => {
    it('opens it with the details sent, stores the three ids and shows the account number Fintava gave', async () => {
      const user = person();
      await ready(user);
      const res = await open(user).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const view = body<WalletView>(res).data!;
      const made = customers[0];
      expect(view).toEqual({
        state: 'open',
        account: {
          accountNumber: made.accountNumber,
          accountName: 'Amaka Opener',
          bankName: 'Loma Bank',
          bankCode: '090620',
          licenceLine: null,
          depositInsuranceLine: null,
          openedAt: expect.any(String) as string,
        },
        limits: null,
        pin: { isSet: false, changedAt: null, triesLeft: 5, lockedUntil: null },
        bankTransfers: { allowed: true, blockedBy: null },
        beneficiaryCount: 0,
      });

      // Asked first whether Fintava had one (it had not), then one create.
      expect(double.seen.map((s) => `${s.method} ${s.path}`)).toEqual([
        'GET /customers/details',
        'POST /create/customer',
      ]);
      expect(double.seen[0].query).toEqual({ phone: user.local });
      expect(creates()[0].body).toEqual({
        firstName: 'Amaka',
        lastName: 'Opener',
        phoneNumber: user.local,
        email: `open-${user.id}@example.com`,
        fundingMethod: 'STATIC_FUND',
        address: user.details.address,
        dateOfBirth: user.details.dateOfBirth,
        bvn: user.bvn,
        nin: user.nin,
      });
      expect(creates()[0].headers.authorization).toBe(`Bearer ${KEY}`);

      expect(await walletRow(user)).toMatchObject({
        customerId: made.customerId,
        walletId: made.walletId,
        accountNumber: made.accountNumber,
        accountName: 'Amaka Opener',
      });
      const id = await prisma.walletIdentity.findUnique({
        where: { wawuUserId: user.id },
      });
      expect(await row(user)).toMatchObject({
        state: 'open',
        attempts: 1,
        bvnHash: id!.bvnHash,
        bvnVerifiedAt: id!.bvnVerifiedAt,
        phone: user.phone,
        failure: null,
      });

      // GET /money/wallet reads the same, and the balance is Fintava's for
      // the stored walletId.
      const got = body<WalletView>(await wallet(user).expect(200)).data!;
      expect(got).toEqual(view);
      await http()
        .get('/api/hub/money/wallet/balance')
        .set('Authorization', user.auth)
        .expect(200);
      expect(double.seen.at(-1)!.path).toBe(
        `/customer/wallet/balance/${made.walletId}`,
      );
    });

    it('asking again once open answers the same account and sends nothing', async () => {
      const user = person();
      await ready(user);
      const first = body<WalletView>(await open(user).expect(200)).data!;
      double.seen.length = 0;
      const again = body<WalletView>(await open(user).expect(200)).data!;
      expect(again).toEqual(first);
      expect(double.seen).toHaveLength(0);
    });

    it('a double tap (10 at once, then 5 more while the create is in flight) opens exactly one account', async () => {
      const user = person();
      await ready(user);
      // Fintava holds the customer only once it answers, 200 ms later.
      double.on('POST', '/create/customer', (req) => {
        const b = req.body as {
          phoneNumber: string;
          bvn: string;
          dateOfBirth: string;
        };
        const m: Made = {
          customerId: randomUUID(),
          recordId: randomUUID(),
          walletId: randomUUID(),
          accountNumber: digits(10),
          accountName: 'Amaka Opener',
          phone: b.phoneNumber,
          createdAt: new Date().toISOString(),
          bvn: b.bvn,
          dateOfBirth: b.dateOfBirth,
        };
        setTimeout(() => customers.unshift(m), 200);
        return { status: 201, body: created201(m), delayMs: 200 };
      });
      const first = Array.from({ length: 10 }, () => open(user));
      await sleep(80);
      const later = Array.from({ length: 5 }, () => open(user));
      const all = await Promise.all([...first, ...later]);
      for (const r of all) {
        expect(r.status).toBe(200);
        expect(['open', 'opening']).toContain(body<WalletView>(r).data!.state);
      }
      expect(creates()).toHaveLength(1);
      expect(customers).toHaveLength(1);
      expect(
        await prisma.fintavaWallet.count({ where: { wawuUserId: user.id } }),
      ).toBe(1);
      expect(body<WalletView>(await wallet(user)).data!.state).toBe('open');
      expect((await row(user))!.attempts).toBe(1);
    });

    it('a request whose claim was taken over before the create goes out sends nothing', async () => {
      const user = person();
      await ready(user);
      const lookup = jest.spyOn(fintavaClient(), 'lookupCustomerByPhone');
      lookup.mockImplementationOnce(async (phone, digest) => {
        // As if the sweep had taken this opening over meanwhile.
        await prisma.fintavaWalletOpening.update({
          where: { wawuUserId: user.id },
          data: { state: 'unknown' },
        });
        return realLookup(phone, digest);
      });
      const view = body<WalletView>(await open(user).expect(200)).data!;
      expect(view.state).toBe('opening');
      expect(creates()).toHaveLength(0);
    });

    it('an account found for an attempt that has since moved on is not recorded for it', async () => {
      const user = person();
      await ready(user);
      makeCustomer(user.local, 'Amaka', 'Opener', user.bvn);
      const lookup = jest.spyOn(fintavaClient(), 'lookupCustomerByPhone');
      lookup.mockImplementationOnce(async (phone, digest) => {
        const out = await realLookup(phone, digest);
        // Another attempt took the opening meanwhile.
        await prisma.fintavaWalletOpening.update({
          where: { wawuUserId: user.id },
          data: { attempts: { increment: 1 } },
        });
        return out;
      });
      await open(user).expect(200);
      expect(await walletRow(user)).toBeNull();
      expect(creates()).toHaveLength(0);
    });

    it('someone with no wallet reads not_open, with no account', async () => {
      const user = person();
      const view = body<WalletView>(await wallet(user).expect(200)).data!;
      expect(view).toMatchObject({
        state: 'not_open',
        account: null,
        limits: null,
        bankTransfers: { allowed: false, blockedBy: null },
        beneficiaryCount: 0,
      });
      expect(double.seen).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('a lost answer is reconciled, never sent again blindly', () => {
    it('a create that lands after the timeout: "still opening", then found by phone and recorded, one create in all', async () => {
      const user = person();
      await ready(user);
      createMode = { kind: 'late' };
      const first = body<WalletView>(await open(user).expect(200)).data!;
      expect(first.state).toBe('opening');
      expect(first.account).toBeNull();
      expect((await row(user))!.state).toBe('unknown');

      // A7: the wallet says opening, the balance says opening.
      expect(body<WalletView>(await wallet(user)).data!.state).toBe('opening');
      const bal = await http()
        .get('/api/hub/money/wallet/balance')
        .set('Authorization', user.auth)
        .expect(409);
      expect(body<null>(bal).reason?.code).toBe('wallet_opening');

      await sleep(LATE_MS);
      createMode = { kind: 'ok' };
      const second = body<WalletView>(await open(user).expect(200)).data!;
      expect(second.state).toBe('open');
      expect(second.account?.accountNumber).toBe(customers[0].accountNumber);
      expect(creates()).toHaveLength(1);
      expect(customers).toHaveLength(1);
      expect((await row(user))!.state).toBe('open');
    });

    it('a 5xx after Fintava made the customer: recorded on the next ask, never made twice', async () => {
      const user = person();
      await ready(user);
      createMode = { kind: 'made_then_500' };
      expect(body<WalletView>(await open(user).expect(200)).data!.state).toBe(
        'opening',
      );
      createMode = { kind: 'ok' };
      expect(body<WalletView>(await open(user).expect(200)).data!.state).toBe(
        'open',
      );
      expect(creates()).toHaveLength(1);
      expect((await walletRow(user))!.customerId).toBe(customers[0].customerId);
    });

    it('a 2xx without the customer in it (not confirmed) is a lost answer too', async () => {
      const user = person();
      await ready(user);
      createMode = { kind: 'made_then_unreadable' };
      expect(body<WalletView>(await open(user).expect(200)).data!.state).toBe(
        'opening',
      );
      expect((await row(user))!.state).toBe('unknown');
      expect(body<WalletView>(await open(user).expect(200)).data!.state).toBe(
        'open',
      );
      expect(creates()).toHaveLength(1);
    });

    it('a refusal saying the customer exists is a lost answer, not a failure', async () => {
      const user = person();
      await ready(user);
      createMode = {
        kind: 'refuse',
        answer: {
          status: 400,
          body: fintavaError(400, 'phoneNumber already exists'),
        },
      };
      expect(body<WalletView>(await open(user).expect(200)).data!.state).toBe(
        'opening',
      );
      expect((await row(user))!.state).toBe('unknown');
    });

    it('nothing made: waits through the resend window, then a new attempt sends one more create', async () => {
      const user = person();
      await ready(user);
      createMode = { kind: 'nothing_then_500' };
      expect(body<WalletView>(await open(user).expect(200)).data!.state).toBe(
        'opening',
      );
      expect(creates()).toHaveLength(1);

      // Fintava's own 404 and an empty list, but too soon: nothing sent.
      await age(user, RESEND_AFTER_MS - 60_000);
      expect(body<WalletView>(await open(user).expect(200)).data!.state).toBe(
        'opening',
      );
      expect(creates()).toHaveLength(1);
      expect((await row(user))!.state).toBe('unknown');

      // Past the window: proved not created, so this request sends again.
      await age(user, RESEND_AFTER_MS + 1_000);
      createMode = { kind: 'ok' };
      const view = body<WalletView>(await open(user).expect(200)).data!;
      expect(view.state).toBe('open');
      expect(creates()).toHaveLength(2);
      expect(customers).toHaveLength(1);
      expect(await row(user)).toMatchObject({ state: 'open', attempts: 2 });
    });

    it('details says not found but the list shows the phone: that account is recorded, nothing resent', async () => {
      const user = person();
      await ready(user);
      createMode = { kind: 'made_then_500' };
      await open(user).expect(200);
      detailsOverride = () => ({
        status: 404,
        body: fintavaError(404, 'Customer not found'),
      });
      await age(user, RESEND_AFTER_MS + 1_000);
      createMode = { kind: 'ok' };
      expect(body<WalletView>(await open(user).expect(200)).data!.state).toBe(
        'open',
      );
      expect(creates()).toHaveLength(1);
      expect((await walletRow(user))!.customerId).toBe(customers[0].customerId);
    });

    it.each<[string, (req: SeenRequest) => CannedAnswer]>([
      ['details answers {}', () => ({ status: 200, body: {} })],
      [
        'details answers data: null',
        () => ({ status: 200, body: { data: null, status: 200 } }),
      ],
      [
        'details 404 with another message',
        () => ({
          status: 404,
          body: fintavaError(404, 'No wallet exists for the customer'),
        }),
      ],
      ['details 404 with an empty body', () => ({ status: 404, body: '' })],
      ['details 500', () => ({ status: 500, body: 'boom' })],
      [
        'details too slow',
        () => ({
          status: 404,
          body: fintavaError(404, 'Customer not found'),
          delayMs: LATE_MS,
        }),
      ],
    ])(
      '%s: waits, even long past the window, and sends nothing',
      async (_name, details) => {
        const user = person();
        await ready(user);
        createMode = { kind: 'nothing_then_500' };
        await open(user).expect(200);
        detailsOverride = details;
        await age(user, RESEND_AFTER_MS * 10);
        createMode = { kind: 'ok' };
        expect(body<WalletView>(await open(user).expect(200)).data!.state).toBe(
          'opening',
        );
        expect(creates()).toHaveLength(1);
        expect((await row(user))!.state).toBe('unknown');
      },
    );

    it.each<[string, (req: SeenRequest) => CannedAnswer]>([
      ['the list fails', () => ({ status: 500, body: 'boom' })],
      [
        'a list row has no time',
        () => ({
          status: 200,
          body: {
            data: [
              {
                id: 'r',
                userInfo: { id: randomUUID(), phoneNumber: '08000000001' },
              },
            ],
            meta: {
              page: '1',
              take: '100',
              itemCount: 1,
              pageCount: 1,
              hasNextPage: false,
            },
          },
        }),
      ],
      [
        'the list never reaches the attempt (every page newer, pages run out)',
        (req) => ({
          status: 200,
          body: {
            data: [
              {
                id: 'r',
                createdAt: new Date().toISOString(),
                userInfo: {
                  id: randomUUID(),
                  phoneNumber: '08000000001',
                  createdAt: new Date().toISOString(),
                },
              },
            ],
            meta: {
              page: req.query.page,
              take: '100',
              itemCount: 99999,
              pageCount: 9999,
              hasNextPage: true,
            },
          },
        }),
      ],
    ])('%s: waits and sends nothing', async (_name, list) => {
      const user = person();
      await ready(user);
      createMode = { kind: 'nothing_then_500' };
      await open(user).expect(200);
      listOverride = list;
      await age(user, RESEND_AFTER_MS + 1_000);
      createMode = { kind: 'ok' };
      expect(body<WalletView>(await open(user).expect(200)).data!.state).toBe(
        'opening',
      );
      expect(creates()).toHaveLength(1);
    });

    it('a request that never finished (the server stopped) is reconciled by the sweep', async () => {
      const user = person();
      await ready(user);
      const id = await prisma.walletIdentity.findUnique({
        where: { wawuUserId: user.id },
      });
      // As if the create was sent and the server died before writing back.
      const m = makeCustomer(user.local, 'Amaka', 'Opener', user.bvn);
      await prisma.fintavaWalletOpening.create({
        data: {
          wawuUserId: user.id,
          state: 'opening',
          bvnHash: id!.bvnHash!,
          bvnVerifiedAt: id!.bvnVerifiedAt!,
          phone: user.phone,
          attemptStartedAt: new Date(Date.now() - 5 * 60_000),
        },
      });
      // Not stuck yet for a fresh one: a request in flight is left alone.
      const fresh = person();
      await ready(fresh);
      const fid = await prisma.walletIdentity.findUnique({
        where: { wawuUserId: fresh.id },
      });
      await prisma.fintavaWalletOpening.create({
        data: {
          wawuUserId: fresh.id,
          state: 'opening',
          bvnHash: fid!.bvnHash!,
          bvnVerifiedAt: fid!.bvnVerifiedAt!,
          phone: fresh.phone,
        },
      });
      const counts = await opening.sweep();
      expect(counts.open).toBeGreaterThanOrEqual(1);
      expect((await walletRow(user))!.customerId).toBe(m.customerId);
      expect((await row(user))!.state).toBe('open');
      expect((await row(fresh))!.state).toBe('opening');
      expect(creates()).toHaveLength(0);
    });

    it('the sweep proves a lost create absent only past the window, and then the person may start again', async () => {
      const user = person();
      await ready(user);
      createMode = { kind: 'nothing_then_500' };
      await open(user).expect(200);
      await opening.sweep();
      expect((await row(user))!.state).toBe('unknown');
      await age(user, RESEND_AFTER_MS + 1_000);
      await opening.sweep();
      expect(await row(user)).toMatchObject({
        state: 'failed',
        failure: 'not_created',
      });
      expect(body<WalletView>(await wallet(user)).data!.state).toBe('not_open');
      const bal = await http()
        .get('/api/hub/money/wallet/balance')
        .set('Authorization', user.auth)
        .expect(409);
      expect(body<null>(bal).reason?.code).toBe('wallet_not_open');
      createMode = { kind: 'ok' };
      expect(body<WalletView>(await open(user).expect(200)).data!.state).toBe(
        'open',
      );
      expect(creates()).toHaveLength(2);
    });

    it('two reconciling at once record the account once', async () => {
      const user = person();
      await ready(user);
      createMode = { kind: 'made_then_500' };
      await open(user).expect(200);
      createMode = { kind: 'ok' };
      const all = await Promise.all([
        open(user),
        open(user),
        opening.sweep(),
        open(user),
      ]);
      for (const r of all.slice(0, 2)) expect((r as Response).status).toBe(200);
      expect(creates()).toHaveLength(1);
      expect(
        await prisma.fintavaWallet.count({ where: { wawuUserId: user.id } }),
      ).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  describe('one person, one account', () => {
    it('Fintava already has an account for the phone that nobody holds: it is recorded, not made again', async () => {
      const user = person();
      await ready(user);
      const m = makeCustomer(user.local, 'Amaka', 'Opener', user.bvn);
      const view = body<WalletView>(await open(user).expect(200)).data!;
      expect(view.account?.accountNumber).toBe(m.accountNumber);
      expect(creates()).toHaveLength(0);
    });

    it('Fintava has an account for the phone that another WAWU account holds: 409 identity_has_wallet, nothing made', async () => {
      const user = person();
      await ready(user);
      // Carries this person's BVN (a wallet row written outside the flow).
      const m = makeCustomer(user.local, 'Someone', 'Else', user.bvn);
      const other = person();
      await prisma.fintavaWallet.create({
        data: {
          wawuUserId: other.id,
          customerId: m.customerId,
          walletId: m.walletId,
          accountNumber: m.accountNumber,
        },
      });
      const res = await open(user).expect(409);
      expect(body<null>(res).reason?.code).toBe('identity_has_wallet');
      expect(creates()).toHaveLength(0);
      expect(await walletRow(user)).toBeNull();
      expect(await row(user)).toMatchObject({
        state: 'failed',
        failure: 'held_by_another_account',
      });
    });

    it('a second WAWU account with the same BVN and phone cannot open a second account', async () => {
      const first = person();
      await ready(first);
      await open(first).expect(200);
      const second = person(undefined, {
        phone: first.phone,
        bvn: first.bvn,
        nin: first.nin,
      });
      await ready(second);
      const res = await open(second).expect(409);
      expect(body<null>(res).reason?.code).toBe('identity_has_wallet');
      expect(creates()).toHaveLength(0);
    });

    it('when the lookup before a create cannot be read, nothing is made and the person may try again', async () => {
      const user = person();
      await ready(user);
      detailsOverride = () => ({ status: 500, body: 'boom' });
      const res = await open(user).expect(503);
      expect(body<null>(res).reason?.code).toBe('provider_unreachable');
      expect(creates()).toHaveLength(0);
      expect(await row(user)).toMatchObject({
        state: 'failed',
        failure: 'lookup_unavailable',
      });
      detailsOverride = () => ({ status: 200, body: {} });
      await open(user).expect(503);
      expect(creates()).toHaveLength(0);
      detailsOverride = null;
      expect(body<WalletView>(await open(user).expect(200)).data!.state).toBe(
        'open',
      );
      expect(creates()).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  describe('Fintava refuses', () => {
    it.each<[string, CannedAnswer, number, string]>([
      [
        'a blacklisted NIN (403)',
        {
          status: 403,
          body: fintavaError(
            403,
            'This NIN is blacklisted',
            'please contact support for assistance.',
          ),
        },
        422,
        'account_not_opened',
      ],
      [
        'a validation refusal (400)',
        { status: 400, body: fintavaValidation('email must be an email') },
        422,
        'account_not_opened',
      ],
      [
        'the merchant gate (403)',
        { status: 403, body: fintavaError(403, 'Merchant is not active') },
        503,
        'provider_unreachable',
      ],
      [
        'a key refused',
        { status: 401, body: fintavaError(401, 'API Key is required') },
        503,
        'provider_unreachable',
      ],
    ])(
      '%s: nothing was made, the answer says so, and a new attempt may start',
      async (_name, answer, status, code) => {
        const user = person();
        await ready(user);
        createMode = { kind: 'refuse', answer };
        const res = await open(user).expect(status);
        const out = body<null>(res);
        expect(out.reason?.code).toBe(code);
        expect(out.message).not.toMatch(/fintava|blacklist|merchant|key|—/i);
        expect((await row(user))!.state).toBe('failed');
        expect(body<WalletView>(await wallet(user)).data!.state).toBe(
          'not_open',
        );
        createMode = { kind: 'ok' };
        expect(body<WalletView>(await open(user).expect(200)).data!.state).toBe(
          'open',
        );
        expect(creates()).toHaveLength(2);
        expect(await row(user)).toMatchObject({ state: 'open', attempts: 2 });
      },
    );
  });

  // -------------------------------------------------------------------------
  describe('identity, read once', () => {
    it('no BVN check: 409 bvn_not_checked, nothing sent', async () => {
      const user = person();
      const res = await open(user).expect(409);
      expect(body<null>(res).reason?.code).toBe('bvn_not_checked');
      expect(double.seen).toHaveLength(0);
      expect(await row(user)).toBeNull();
    });

    it('another BVN, or another NIN, than the check passed with: 409 bvn_not_checked (the NIN is required)', async () => {
      const user = person();
      await ready(user);
      for (const payload of [
        { ...user.details, bvn: digits(11) },
        { ...user.details, nin: digits(11) },
      ]) {
        const res = await open(user, payload).expect(409);
        expect(body<null>(res).reason?.code).toBe('bvn_not_checked');
      }
      const noNin: Partial<OpenBody> = { ...user.details };
      delete noNin.nin;
      await open(user, noNin).expect(400);
      expect(double.seen).toHaveLength(0);
    });

    it('a BVN check but no selfie: 409 selfie_required', async () => {
      const user = person();
      await bvnChecked(user);
      double.reset();
      installFintava();
      const res = await open(user).expect(409);
      expect(body<null>(res).reason?.code).toBe('selfie_required');
      expect(double.seen).toHaveLength(0);
    });

    it('a selfie that matched an earlier check does not count for a later one', async () => {
      const user = person();
      await ready(user);
      await bvnChecked(user);
      double.reset();
      installFintava();
      const res = await open(user).expect(409);
      expect(body<null>(res).reason?.code).toBe('selfie_required');
      expect(creates()).toHaveLength(0);
    });

    it('another BVN check passing right after the identity read does not change what is opened (finding 3)', async () => {
      const user = person();
      await ready(user);
      const otherBvn = digits(11);
      secrets.push(otherBvn);
      const real = identity.checkedIdentity.bind(identity);
      const read = jest.spyOn(identity, 'checkedIdentity');
      read.mockImplementationOnce(async (...args) => {
        const check = await real(...args);
        // B's check passes now, for a BVN with no selfie.
        await bvnChecked(user, otherBvn);
        installFintava();
        return check;
      });
      const res = await open(user).expect(200);
      expect(read).toHaveBeenCalledTimes(1);
      // Opened with the BVN whose check AND selfie matched (A), tied to A.
      expect(body<WalletView>(res).data!.state).toBe('open');
      expect((creates()[0].body as { bvn: string }).bvn).toBe(user.bvn);
      const current = await prisma.walletIdentity.findUnique({
        where: { wawuUserId: user.id },
      });
      const r = await row(user);
      expect(r!.bvnHash).not.toBe(current!.bvnHash);
      expect(r!.bvnVerifiedAt.getTime()).toBeLessThan(
        current!.bvnVerifiedAt!.getTime(),
      );
    });

    it("B's BVN after B's check, with only A's selfie: 409 selfie_required", async () => {
      const user = person();
      await ready(user);
      const otherBvn = digits(11);
      secrets.push(otherBvn);
      await bvnChecked(user, otherBvn);
      double.reset();
      installFintava();
      const res = await open(user, { ...user.details, bvn: otherBvn }).expect(
        409,
      );
      expect(body<null>(res).reason?.code).toBe('selfie_required');
      expect(creates()).toHaveLength(0);
    });

    it('an account with no email: 422 account_not_opened, nothing sent', async () => {
      const user = person(null);
      await ready(user);
      const res = await open(user).expect(422);
      expect(body<null>(res).reason?.code).toBe('account_not_opened');
      expect(creates()).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('the request', () => {
    it('without a token: 401 on both routes', async () => {
      await open(null, {}).expect(401);
      await http().get('/api/hub/money/wallet').expect(401);
    });

    it.each<[string, Record<string, unknown>]>([
      ['a wawuUserId', { wawuUserId: randomUUID() }],
      ['a BVN of 10 digits', { bvn: '1234567890' }],
      ['a NIN with a space', { nin: '1234567 8901' }],
      ['a date that does not exist', { dateOfBirth: '1990-02-30' }],
      ['a date in the future', { dateOfBirth: '2999-01-01' }],
      ['a date written 04/10/1992', { dateOfBirth: '04/10/1992' }],
      ['a first name with digits', { firstName: 'Am4ka' }],
      ['an empty last name', { lastName: '  ' }],
      ['an address too short', { address: 'Lag' }],
      ['an address with markup', { address: '<b>1 Street</b> Lagos' }],
      ['an address of 201 characters', { address: 'a'.repeat(201) }],
    ])(
      '%s: 400, nothing sent, and the answer does not repeat it',
      async (_name, change) => {
        const user = person();
        const res = await open(user, { ...user.details, ...change }).expect(
          400,
        );
        expect(res.text).not.toContain(user.bvn);
        expect(double.seen).toHaveLength(0);
        expect(await row(user)).toBeNull();
      },
    );
  });

  // -------------------------------------------------------------------------
  // Round 2, D1: a customer is adopted only when Fintava's record carries
  // the checked BVN (keyed hash of userInfo.bvn = the opening's bvnHash).
  // A1 to A4 are the verifier's reproductions, now refused.
  // -------------------------------------------------------------------------
  describe("Fintava's customer for the phone is this person's only if it carries their BVN (D1)", () => {
    const stops = () =>
      captured.filter((l) => l.includes('is not shown to be this person'))
        .length;
    const balance = (who: Person) =>
      http()
        .get('/api/hub/money/wallet/balance')
        .set('Authorization', who.auth);

    /** The answer, the row, GET /money/wallet and the balance once stopped. */
    async function expectStopped(
      who: Person,
      res: Response,
      failure: string,
    ): Promise<void> {
      expect(res.status).toBe(409);
      const out = body<null>(res);
      expect(out.reason?.code).toBe('phone_held_by_other_identity');
      expect(out.message).toBe(PHONE_HELD_MESSAGE);
      expect(out.message).not.toMatch(/—|fintava|stranger|chidi/i);
      expect(await walletRow(who)).toBeNull();
      expect(await row(who)).toMatchObject({ state: 'conflict', failure });
      const seen = double.seen.length;
      const view = body<WalletView>(await wallet(who).expect(200)).data!;
      expect(view).toMatchObject({ state: 'not_open', account: null });
      expect(body<null>(await balance(who).expect(409)).reason?.code).toBe(
        'wallet_not_open',
      );
      // Every later open answers the same and asks Fintava nothing.
      const again = await open(who).expect(409);
      expect(body<null>(again).reason?.code).toBe(
        'phone_held_by_other_identity',
      );
      expect(double.seen).toHaveLength(seen);
    }

    it('A1: a customer made elsewhere for the phone, with another BVN, name and date of birth, is refused: nothing adopted, nothing created', async () => {
      const user = person();
      await ready(user);
      const other = stranger(user.local, '2024-01-01T00:00:00.000Z');
      expect(other.bvn).not.toBe(user.bvn);
      const before = stops();
      const res = await open(user);
      await expectStopped(user, res, 'phone_held_by_other_identity');
      expect(res.text).not.toContain(other.accountNumber);
      expect(creates()).toHaveLength(0);
      expect(stops()).toBe(before + 1);
      // Fintava was read, never written: details, then the record by id.
      expect(double.seen.map((s) => `${s.method} ${s.path}`)).toEqual([
        'GET /customers/details',
        `GET /customers/${other.customerId}`,
      ]);
    });

    it("a record whose BVN is masked or absent is not this person's either", async () => {
      for (const bvn of [`*******${digits(4)}`, '']) {
        double.seen.length = 0;
        const user = person();
        await ready(user);
        makeCustomer(user.local, 'Amaka', 'Opener', bvn);
        const res = await open(user);
        await expectStopped(user, res, 'phone_holder_bvn_unreadable');
        expect(creates()).toHaveLength(0);
      }
    });

    it('a customer for the phone that carries the checked BVN is adopted, however old (the same person coming back)', async () => {
      const user = person();
      await ready(user);
      const mine = makeCustomer(user.local, 'Amaka', 'Opener', user.bvn, {
        createdAt: '2024-06-01T00:00:00.000Z',
      });
      const view = body<WalletView>(await open(user).expect(200)).data!;
      expect(view.state).toBe('open');
      expect(view.account?.accountNumber).toBe(mine.accountNumber);
      expect((await walletRow(user))!.customerId).toBe(mine.customerId);
      expect(creates()).toHaveLength(0);
    });

    it('A2: a number reissued after its first holder deleted their account is refused for the new holder; the first holder gets theirs back', async () => {
      const first = person();
      await ready(first);
      expect(body<WalletView>(await open(first).expect(200)).data!.state).toBe(
        'open',
      );
      const firstCustomer = customers[0];
      await new AccountPurgeService(prisma).purge(first.id);
      expect(await row(first)).toBeNull();

      const second = person(undefined, { phone: first.phone });
      await ready(second);
      expect(second.bvn).not.toBe(first.bvn);
      const res = await open(second);
      await expectStopped(second, res, 'phone_held_by_other_identity');
      expect(res.text).not.toContain(firstCustomer.accountNumber);
      expect(creates()).toHaveLength(0);
      expect(customers).toHaveLength(1);

      // The first holder, signing up again with the same BVN and phone
      // (G-36's case), gets their own account back once the stopped
      // opening is cleared by review.
      await prisma.fintavaWalletOpening.delete({
        where: { wawuUserId: second.id },
      });
      const back = person(undefined, {
        phone: first.phone,
        bvn: first.bvn,
        nin: first.nin,
      });
      await ready(back);
      const view = body<WalletView>(await open(back).expect(200)).data!;
      expect(view.account?.accountNumber).toBe(firstCustomer.accountNumber);
      expect(creates()).toHaveLength(0);
    });

    it('A3: "already exists" is a lost answer, and the list row it then finds by phone (a 2-year-old stranger) is refused, not adopted', async () => {
      const user = person();
      await ready(user);
      const other = stranger(user.local, '2024-10-01T00:00:00.000Z');
      detailsOverride = () => ({
        status: 404,
        body: fintavaError(404, 'Customer not found'),
      });
      createMode = {
        kind: 'refuse',
        answer: {
          status: 400,
          body: fintavaError(400, 'phoneNumber already exists'),
        },
      };
      const first = body<WalletView>(await open(user).expect(200)).data!;
      expect(first.state).toBe('opening');
      expect((await row(user))!.state).toBe('unknown');
      const res = await open(user);
      await expectStopped(user, res, 'phone_held_by_other_identity');
      expect(res.text).not.toContain(other.accountNumber);
      expect(creates()).toHaveLength(1);
      expect(
        double.seen.some((s) => s.path === `/customers/${other.customerId}`),
      ).toBe(true);
    });

    it('a lost answer whose list row by phone carries the checked BVN, of any age, is adopted', async () => {
      const user = person();
      await ready(user);
      const mine = makeCustomer(user.local, 'Amaka', 'Opener', user.bvn, {
        createdAt: '2024-10-01T00:00:00.000Z',
      });
      detailsOverride = () => ({
        status: 404,
        body: fintavaError(404, 'Customer not found'),
      });
      createMode = {
        kind: 'refuse',
        answer: {
          status: 400,
          body: fintavaError(400, 'phoneNumber already exists'),
        },
      };
      // The lookup before the create misses it too (details 404).
      expect(body<WalletView>(await open(user).expect(200)).data!.state).toBe(
        'opening',
      );
      const view = body<WalletView>(await open(user).expect(200)).data!;
      expect(view.account?.accountNumber).toBe(mine.accountNumber);
      expect(creates()).toHaveLength(1);
    });

    it("a lost answer whose details lookup finds a stranger's customer is refused", async () => {
      const user = person();
      await ready(user);
      createMode = { kind: 'nothing_then_500' };
      await open(user).expect(200);
      expect((await row(user))!.state).toBe('unknown');
      stranger(user.local);
      const res = await open(user);
      await expectStopped(user, res, 'phone_held_by_other_identity');
      expect(creates()).toHaveLength(1);
    });

    it('A4: the sweep alone refuses a stranger for a stuck opening, and the person is then told', async () => {
      const user = person();
      await ready(user);
      const id = await prisma.walletIdentity.findUnique({
        where: { wawuUserId: user.id },
      });
      stranger(user.local, '2023-01-01T00:00:00.000Z');
      await prisma.fintavaWalletOpening.create({
        data: {
          wawuUserId: user.id,
          state: 'unknown',
          bvnHash: id!.bvnHash!,
          bvnVerifiedAt: id!.bvnVerifiedAt!,
          phone: user.phone,
          attemptStartedAt: new Date(Date.now() - 60_000),
        },
      });
      const counts = await opening.sweep();
      expect(counts.conflict).toBeGreaterThanOrEqual(1);
      expect(counts.open).toBe(0);
      const res = await open(user);
      await expectStopped(user, res, 'phone_held_by_other_identity');
      expect(creates()).toHaveLength(0);
    });

    it('a stopped opening stays stopped through further sweeps', async () => {
      const user = person();
      await ready(user);
      stranger(user.local);
      await open(user).expect(409);
      await opening.sweep();
      await opening.sweep();
      expect(await row(user)).toMatchObject({
        state: 'conflict',
        failure: 'phone_held_by_other_identity',
      });
      expect(creates()).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Round 2, N1: the list's newest-first order is checked, not assumed.
  // -------------------------------------------------------------------------
  describe('the customer list is only trusted newest first (N1)', () => {
    const listRows = (
      rows: Made[],
      page: number,
      take: number,
      total: number,
    ) => ({
      status: 200,
      body: {
        data: rows.map((m) => ({
          id: m.recordId,
          createdAt: m.createdAt,
          phone: m.phone,
          userInfo: { ...userInfo(m), wallet: walletRead(m) },
        })),
        meta: {
          page: String(page),
          take: String(take),
          itemCount: total,
          pageCount: Math.ceil(total / take),
          hasPreviousPage: page > 1,
          hasNextPage: page * take < total,
        },
      },
    });

    /** A lost create Fintava made, which its details lookup then misses. */
    async function lostAndMissedByDetails(user: Person): Promise<void> {
      createMode = { kind: 'made_then_500' };
      await open(user).expect(200);
      detailsOverride = () => ({
        status: 404,
        body: fintavaError(404, 'Customer not found'),
      });
      await age(user, RESEND_AFTER_MS + 1_000);
      createMode = { kind: 'ok' };
    }
    const oldRow = (ms: number): Made => ({
      customerId: randomUUID(),
      recordId: randomUUID(),
      walletId: randomUUID(),
      accountNumber: digits(10),
      accountName: 'Old Row',
      phone: `080${digits(8)}`,
      createdAt: new Date(ms).toISOString(),
      bvn: digits(11),
      dateOfBirth: '1970-01-01',
    });

    it('served oldest first, with details missing the new customer: the list is read to its end and finds it, one create', async () => {
      const user = person();
      await ready(user);
      // 150 older customers, made oldest first, so `customers` is truly
      // newest first and its reverse truly oldest first.
      for (let k = 0; k < 150; k += 1) {
        makeCustomer(`080${digits(8)}`, 'Old', 'Row', digits(11), {
          createdAt: new Date(
            Date.now() - 3_600_000 - (150 - k) * 1000,
          ).toISOString(),
        });
      }
      await lostAndMissedByDetails(user);
      listOverride = (req) => {
        const take = Number(req.query.take);
        const page = Number(req.query.page);
        const asc = [...customers].reverse();
        return listRows(
          asc.slice((page - 1) * take, page * take),
          page,
          take,
          asc.length,
        );
      };
      const view = body<WalletView>(await open(user).expect(200)).data!;
      expect(view.state).toBe('open');
      expect(view.account?.accountNumber).toBe(customers[0].accountNumber);
      expect(creates()).toHaveLength(1);
      expect(customers.filter((c) => c.phone === user.local)).toHaveLength(1);
      expect(
        double.seen.filter((x) => x.path === '/customers/list').length,
      ).toBe(2);
    });

    it("the verifier's C3 order (older rows first page, the new customer last): found, never a second create", async () => {
      const user = person();
      await ready(user);
      for (let i = 0; i < 150; i += 1) {
        makeCustomer(`080${digits(8)}`, 'Old', 'Row', digits(11), {
          createdAt: new Date(Date.now() - 3_600_000 - i * 1000).toISOString(),
        });
      }
      await lostAndMissedByDetails(user);
      listOverride = (req) => {
        const take = Number(req.query.take);
        const page = Number(req.query.page);
        const asc = [...customers].reverse();
        return listRows(
          asc.slice((page - 1) * take, page * take),
          page,
          take,
          asc.length,
        );
      };
      expect(body<WalletView>(await open(user).expect(200)).data!.state).toBe(
        'open',
      );
      expect(creates()).toHaveLength(1);
      expect(customers.filter((c) => c.phone === user.local)).toHaveLength(1);
    });

    it('a list longer than we read, not newest first: waits, never a second create', async () => {
      const user = person();
      await ready(user);
      await lostAndMissedByDetails(user);
      const now = Date.now();
      // Each page newest first on its own, but page 2 starts newer than page
      // 1 ended; all of it long before the attempt; pages never run out.
      listOverride = (req) => {
        const page = Number(req.query.page);
        const top = now - 3_600_000 - (page % 2 === 0 ? 0 : 200_000);
        const rows = Array.from({ length: 100 }, (_, i) =>
          oldRow(top - i * 1000),
        );
        return listRows(rows, page, 100, 99_999);
      };
      expect(body<WalletView>(await open(user).expect(200)).data!.state).toBe(
        'opening',
      );
      await age(user, RESEND_AFTER_MS * 3);
      await opening.sweep();
      expect((await row(user))!.state).toBe('unknown');
      expect(creates()).toHaveLength(1);
      expect(
        captured.some((l) =>
          l.includes(
            'customer list is longer than we read and not newest first',
          ),
        ),
      ).toBe(true);
    });

    it('a list longer than we read, newest first and back past the attempt, without the phone: proved absent as before', async () => {
      const user = person();
      await ready(user);
      createMode = { kind: 'nothing_then_500' };
      await open(user).expect(200);
      await age(user, RESEND_AFTER_MS + 1_000);
      const now = Date.now();
      listOverride = (req) => {
        const page = Number(req.query.page);
        const rows = Array.from({ length: 100 }, (_, i) =>
          oldRow(now - ((page - 1) * 100 + i) * 60_000),
        );
        return listRows(rows, page, 100, 99_999);
      };
      createMode = { kind: 'ok' };
      expect(body<WalletView>(await open(user).expect(200)).data!.state).toBe(
        'open',
      );
      expect(creates()).toHaveLength(2);
      expect(
        double.seen.filter((x) => x.path === '/customers/list').length,
      ).toBe(10);
    });
  });

  // -------------------------------------------------------------------------
  // Round 2, N2: one clock, the database's, for every opening time.
  // -------------------------------------------------------------------------
  describe("the resend window is measured on the database's clock (N2)", () => {
    const RealDate = Date;
    /** This process's clock, moved by `offsetMs` (as a server whose clock is off). */
    function skewClock(offsetMs: number): () => void {
      class Skewed extends RealDate {
        constructor(...args: unknown[]) {
          if (args.length === 0) super(RealDate.now() + offsetMs);
          else super(...(args as [number]));
        }
        static now(): number {
          return RealDate.now() + offsetMs;
        }
      }
      global.Date = Skewed as DateConstructor;
      return () => {
        global.Date = RealDate;
      };
    }
    const SKEW_MS = RESEND_AFTER_MS + 2 * 60_000;

    /** Starts an open whose create is held in flight until `release`. */
    async function inFlight(user: Person) {
      let release!: () => void;
      const held = new Promise<void>((r) => {
        release = r;
      });
      const real = client.createCustomer.bind(client);
      const spy = jest
        .spyOn(client, 'createCustomer')
        .mockImplementationOnce(async (input) => {
          await held;
          return real(input);
        });
      const pending = open(user).then((r) => r);
      // The claim is stamped and the create is on its way once it is called.
      for (let i = 0; i < 300 && spy.mock.calls.length === 0; i += 1) {
        await sleep(10);
      }
      expect(spy).toHaveBeenCalledTimes(1);
      return { pending, release };
    }

    afterEach(() => {
      global.Date = RealDate;
    });

    it("a sweep on a server whose clock runs 12 minutes fast leaves a create in flight alone, and a tap sends nothing (the verifier's C4)", async () => {
      const user = person();
      await ready(user);
      createMode = { kind: 'nothing_then_500' };
      const { pending, release } = await inFlight(user);
      expect((await row(user))!.state).toBe('opening');
      const restore = skewClock(SKEW_MS);
      try {
        await opening.sweep();
        await opening.sweep();
        expect((await row(user))!.state).toBe('opening');
        createMode = { kind: 'ok' };
        const tap = await open(user).expect(200);
        expect(body<WalletView>(tap).data!.state).toBe('opening');
      } finally {
        restore();
      }
      release();
      await pending;
      // The held create was the only one sent.
      expect(creates()).toHaveLength(1);
    });

    it('a create stamped by a server whose clock runs 12 minutes slow is not called absent by a server on time', async () => {
      const user = person();
      await ready(user);
      createMode = { kind: 'nothing_then_500' };
      const restore = skewClock(-SKEW_MS);
      let flight: Awaited<ReturnType<typeof inFlight>>;
      try {
        flight = await inFlight(user);
      } finally {
        restore();
      }
      const stamped = (await row(user))!.attemptStartedAt.getTime();
      expect(Math.abs(stamped - Date.now())).toBeLessThan(60_000);
      await opening.sweep();
      expect((await row(user))!.state).toBe('opening');
      createMode = { kind: 'ok' };
      expect(body<WalletView>(await open(user).expect(200)).data!.state).toBe(
        'opening',
      );
      flight.release();
      await flight.pending;
      expect(creates()).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // The verifier's other attack cases (round 1), kept.
  // -------------------------------------------------------------------------
  describe("the verifier's races and lost-answer cases", () => {
    it('3 WAWU accounts with the same BVN and phone, 8 taps each at once: one create, one wallet', async () => {
      const a = person();
      const b = person(undefined, { phone: a.phone, bvn: a.bvn, nin: a.nin });
      const c = person(undefined, { phone: a.phone, bvn: a.bvn, nin: a.nin });
      for (const p of [a, b, c]) {
        await bvnChecked(p);
        await selfieMatched(p);
      }
      double.reset();
      installFintava();
      createMode = { kind: 'late' };
      const all: Response[] = [];
      await Promise.all(
        [a, b, c].flatMap((p) =>
          Array.from({ length: 8 }, async () => {
            all.push(await open(p));
          }),
        ),
      );
      await sleep(LATE_MS + 200);
      createMode = { kind: 'ok' };
      for (const p of [a, b, c]) await open(p);
      for (const r of all) {
        const e = r.body as Envelope<WalletView>;
        expect([
          '200:opening',
          '200:open',
          '409:identity_has_wallet',
        ]).toContain(`${r.status}:${e.reason?.code ?? e.data?.state}`);
      }
      expect(creates()).toHaveLength(1);
      expect(customers).toHaveLength(1);
      expect(
        await prisma.fintavaWallet.count({
          where: { wawuUserId: { in: [a.id, b.id, c.id] } },
        }),
      ).toBe(1);
    });

    it('same BVN on two accounts with different phones, at once: one create, the other 409', async () => {
      const a = person();
      const b = person(undefined, { bvn: a.bvn, nin: a.nin });
      await bvnChecked(a);
      await selfieMatched(a);
      await bvnChecked(b);
      await selfieMatched(b);
      double.reset();
      installFintava();
      const res = await Promise.all([open(a), open(b), open(a), open(b)]);
      expect(creates()).toHaveLength(1);
      expect(
        res.filter(
          (r) =>
            (r.body as Envelope<null>).reason?.code === 'identity_has_wallet',
        ).length,
      ).toBeGreaterThanOrEqual(1);
    });

    it('a second service instance on the same database, both sweeps racing the routes, create late: one create', async () => {
      const user = person();
      await ready(user);
      createMode = { kind: 'late' };
      const parts = opening as unknown as Record<string, never>;
      const other = new WalletOpeningService(
        prisma,
        parts.provider,
        parts.hasher,
        identity,
        parts.selfie,
        parts.pins,
        parts.settings,
      );
      const email = `open-${user.id}@example.com`;
      const details: OpenNairaWalletDto = user.details;
      const jobs: Array<Promise<unknown>> = [];
      for (let i = 0; i < 6; i += 1) {
        jobs.push(open(user));
        jobs.push(other.open(user.id, email, details).catch((e: Error) => e));
      }
      jobs.push(opening.sweep(), other.sweep());
      await Promise.all(jobs);
      await sleep(LATE_MS + 200);
      createMode = { kind: 'ok' };
      await Promise.all([
        open(user),
        other.open(user.id, email, details),
        opening.sweep(),
        other.sweep(),
      ]);
      expect(creates()).toHaveLength(1);
      expect((await row(user))!.state).toBe('open');
    });

    it('the window boundary: 50 ms before it waits, 50 ms after it is proved absent', async () => {
      const user = person();
      await ready(user);
      createMode = { kind: 'nothing_then_500' };
      await open(user).expect(200);
      await age(user, RESEND_AFTER_MS - 2_000);
      expect(await opening.reconcile((await row(user))!)).toBe('wait');
      await age(user, RESEND_AFTER_MS + 50);
      expect(await opening.reconcile((await row(user))!)).toBe('absent');
      expect(creates()).toHaveLength(1);
    });

    it("Fintava's clock 6 minutes behind ours and details missing the new customer: the list still finds it, nothing resent", async () => {
      const user = person();
      await ready(user);
      for (let i = 0; i < 30; i += 1) {
        makeCustomer(`080${digits(8)}`, 'Old', 'Row', digits(11), {
          createdAt: new Date(Date.now() - 3_600_000 - i).toISOString(),
        });
      }
      createMode = { kind: 'made_then_500' };
      await open(user).expect(200);
      customers[0].createdAt = new Date(Date.now() - 6 * 60_000).toISOString();
      detailsOverride = () => ({
        status: 404,
        body: fintavaError(404, 'Customer not found'),
      });
      await age(user, RESEND_AFTER_MS + 1_000);
      expect(body<WalletView>(await open(user).expect(200)).data!.state).toBe(
        'open',
      );
      expect(creates()).toHaveLength(1);
    });

    it('a new BVN check while a lost create is reconciled: once proved absent, the old BVN is refused and the new one needs its own selfie', async () => {
      const user = person();
      await ready(user);
      createMode = { kind: 'nothing_then_500' };
      await open(user).expect(200);
      const otherBvn = digits(11);
      secrets.push(otherBvn);
      await bvnChecked(user, otherBvn);
      installFintava();
      await age(user, RESEND_AFTER_MS + 1_000);
      createMode = { kind: 'ok' };
      const r = await open(user).expect(409);
      expect(body<null>(r).reason?.code).toBe('bvn_not_checked');
      expect(creates()).toHaveLength(1);
      const r2 = await open(user, { ...user.details, bvn: otherBvn }).expect(
        409,
      );
      expect(body<null>(r2).reason?.code).toBe('selfie_required');
      expect(creates()).toHaveLength(1);
    });

    it('G-36 as filed (the owner decides): after a purge, the same BVN with a NEW phone makes a second Fintava customer', async () => {
      const first = person();
      await ready(first);
      await open(first).expect(200);
      await new AccountPurgeService(prisma).purge(first.id);
      const again = person(undefined, { bvn: first.bvn, nin: first.nin });
      await ready(again);
      expect(body<WalletView>(await open(again).expect(200)).data!.state).toBe(
        'open',
      );
      expect(creates()).toHaveLength(1);
      expect(customers.filter((c) => c.bvn === first.bvn)).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  describe('never stored, never logged', () => {
    it('no BVN, NIN or address in any column of any table', async () => {
      const tables = await prisma.$queryRawUnsafe<
        Array<{ table_name: string; column_name: string }>
      >(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND data_type IN ('text', 'character varying', 'jsonb', 'json', 'ARRAY')`,
      );
      expect(tables.length).toBeGreaterThan(100);
      const patterns = secrets.map((s) => `%${s}%`);
      const hits: string[] = [];
      for (const { table_name, column_name } of tables) {
        const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
          `SELECT count(*) AS n FROM "${table_name}" WHERE "${column_name}"::text LIKE ANY($1::text[])`,
          patterns,
        );
        if (Number(rows[0].n) > 0) hits.push(`${table_name}.${column_name}`);
      }
      expect(hits).toEqual([]);
    }, 120_000);

    it('no BVN, NIN, address or key in any log line or answer', () => {
      const all = [...captured, ...answered].join('\n');
      expect(captured.length).toBeGreaterThan(10);
      for (const s of secrets) expect(all).not.toContain(s);
      for (let i = 0; i + 8 <= KEY.length; i += 1) {
        expect(all).not.toContain(KEY.slice(i, i + 8));
      }
      expect(all).not.toContain(HASH_KEY);
    });
  });
});
