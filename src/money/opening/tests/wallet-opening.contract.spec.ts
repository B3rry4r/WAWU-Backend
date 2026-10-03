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
import type { MoneyErrorReason } from '../../dto/money-error.dto';
import { WalletIdentityService } from '../../identity/wallet-identity.service';
import { MoneyModule } from '../../money.module';
import type { WalletView } from '../../money-view.type';
import { WalletOpeningService } from '../wallet-opening.service';

/**
 * Opening the account at Fintava (task MONEY-12) over HTTP: the real
 * MoneyModule, a real database, real RS256 tokens checked against the
 * stand-in WAWU ID's JWKS (WAWU_ID_JWKS_URL), and the real MONEY-06 client
 * talking over a socket to a stateful stand-in for Fintava's customer
 * routes built on the local double: a create adds a customer (with the
 * sandbox's 201 shape, `sandbox/07-`), the details, by-id and list reads find
 * it, and an unknown phone is the sandbox's own `404 ["Customer not
 * found"]` (`sandbox/32-money12-account.md`). Each person passes the BVN
 * check (KYC-01) and the selfie (KYC-02) through their own routes first, as
 * the app does; the selfie's pass is the KYC-02 stand-in `SELFIE_MATCHED`,
 * since no real selfie has matched in the sandbox yet (G-25).
 *
 * The money timeout is 300 ms here, so a create the stand-in answers after
 * 700 ms is a lost answer: Fintava made the customer and the client never
 * heard. Every log line the app writes during the file is captured, and
 * every answer kept: the last tests prove no BVN, NIN, date of birth or
 * address reached a log, an answer or a column.
 */

const KEY = 'live_test_m12_open_0123456789FAKEKEY';
const HASH_KEY = 'm12-test-opening-hash-key-0123456789abcdef';
const TIMEOUT_MS = 300;
const LATE_MS = 700;

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
  const realLookup = (phone: string) =>
    FintavaClient.prototype.lookupCustomerByPhone.call(client, phone);
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

  function makeCustomer(phone: string, first: string, last: string): Made {
    const m: Made = {
      customerId: randomUUID(),
      recordId: randomUUID(),
      walletId: randomUUID(),
      accountNumber: digits(10),
      accountName: `${first} ${last}`,
      phone,
      createdAt: new Date().toISOString(),
    };
    customers.unshift(m);
    return m;
  }
  const userInfo = (m: Made) => ({
    id: m.customerId,
    createdAt: m.createdAt,
    updatedAt: m.createdAt,
    firstName: m.accountName.split(' ')[0],
    lastName: m.accountName.split(' ')[1],
    phoneNumber: m.phone,
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
      };
      const mode = createMode;
      switch (mode.kind) {
        case 'refuse':
          return mode.answer;
        case 'nothing_then_500':
          return { status: 500, body: fintavaError(500, 'read ECONNRESET') };
        default: {
          const m = makeCustomer(b.phoneNumber, b.firstName, b.lastName);
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
      dateOfBirth: '1991-07-0' + String(randomInt(1, 10)),
      address: `${randomInt(10, 999)} Opening Close, Yaba, Lagos`,
    };
    secrets.push(bvn, nin, details.address);
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
        const b = req.body as { phoneNumber: string };
        const m: Made = {
          customerId: randomUUID(),
          recordId: randomUUID(),
          walletId: randomUUID(),
          accountNumber: digits(10),
          accountName: 'Amaka Opener',
          phone: b.phoneNumber,
          createdAt: new Date().toISOString(),
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
      lookup.mockImplementationOnce(async (phone) => {
        // As if the sweep had taken this opening over meanwhile.
        await prisma.fintavaWalletOpening.update({
          where: { wawuUserId: user.id },
          data: { state: 'unknown' },
        });
        return realLookup(phone);
      });
      const view = body<WalletView>(await open(user).expect(200)).data!;
      expect(view.state).toBe('opening');
      expect(creates()).toHaveLength(0);
    });

    it('an account found for an attempt that has since moved on is not recorded for it', async () => {
      const user = person();
      await ready(user);
      makeCustomer(user.local, 'Amaka', 'Opener');
      const lookup = jest.spyOn(fintavaClient(), 'lookupCustomerByPhone');
      lookup.mockImplementationOnce(async (phone) => {
        const out = await realLookup(phone);
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
      const m = makeCustomer(user.local, 'Amaka', 'Opener');
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
      const m = makeCustomer(user.local, 'Amaka', 'Opener');
      const view = body<WalletView>(await open(user).expect(200)).data!;
      expect(view.account?.accountNumber).toBe(m.accountNumber);
      expect(creates()).toHaveLength(0);
    });

    it('Fintava has an account for the phone that another WAWU account holds: 409 identity_has_wallet, nothing made', async () => {
      const user = person();
      await ready(user);
      const m = makeCustomer(user.local, 'Someone', 'Else');
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
