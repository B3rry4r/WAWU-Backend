import {
  createCipheriv,
  randomBytes,
  randomInt,
  randomUUID,
} from 'node:crypto';
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
  SELFIE_MATCHED,
  WALLET_BALANCE,
} from '../../../../test/fintava/fintava-double';
import { jpegImage } from '../../../../test/fixtures/selfie/selfie-images';
import { WawuIdClient } from '../../../common/auth/wawu-id.client';
import { WawuJwtStrategy } from '../../../common/auth/wawu-jwt.strategy';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { MoneyErrorReason } from '../../dto/money-error.dto';
import { MoneyModule } from '../../money.module';
import type { WalletView } from '../../money-view.type';
import {
  CHECK_HANDLE_LABEL,
  CHECK_HANDLE_TTL_SECONDS,
  CheckHandleSealer,
} from '../check-handle';
import { CHECK_HANDLE_INVALID_MESSAGE } from '../dto/identity-request.dto';
import { IdentityHasher } from '../identity-config';
import type { BvnCheckView, SelfieMatchView } from '../identity-view.type';
import { CHECK_AGAIN_MESSAGE } from '../wallet-identity.service';

/**
 * The check handle (task KYC-03, BACKEND_GAPS G-72 in the mobile repo) over
 * HTTP: the real MoneyModule, a real database, real RS256 tokens checked
 * against the stand-in WAWU ID's JWKS, and the real MONEY-06 client talking
 * to the local Fintava double. A person passes the BVN check, gets a sealed
 * handle in its answer, and sends that handle instead of the BVN to the
 * selfie match and instead of the BVN and NIN to the account opening; the
 * server unseals the numbers and Fintava receives them as before.
 *
 * Every handle the app is handed or that this file makes is collected, and
 * every log line the app writes during the file is captured: the last tests
 * prove no handle reached a log, a column or any answer but the check's own.
 */

const KEY = 'live_test_k03_handle_0123456789FAKEKEY';
const HASH_KEY = 'k03-test-handle-hash-key-0123456789abcdef0';
const TIMEOUT_MS = 2_000;
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

/** Every answer body, tagged with whether it was a BVN check's own (the one place a handle may appear). */
const answered: Array<{ fromCheck: boolean; text: string }> = [];
/** Every handle issued or made here. */
const handles: string[] = [];

function digits(n: number): string {
  let out = String(randomInt(1, 10));
  while (out.length < n) out += String(randomInt(0, 10));
  return out;
}

type Envelope<T> = {
  statusCode: number;
  message: string;
  data: T | null;
  reason?: MoneyErrorReason;
};
function body<T>(res: Response, fromCheck = false): Envelope<T> {
  answered.push({ fromCheck, text: res.text });
  return res.body as Envelope<T>;
}

function mintToken(sub: string, phone: string): string {
  const privateKey = readFileSync(
    join(__dirname, '../../../../mock-wawu-id/private.pem'),
    'utf8',
  );
  return jwt.sign(
    {
      sub,
      email: `handle-${sub}@example.com`,
      phone,
      firstName: 'Handle',
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

type Person = {
  id: string;
  auth: string;
  local: string;
  bvn: string;
  nin: string;
};

describe('The check handle (KYC-03) over HTTP', () => {
  const logger = new ConsoleLogger({
    logLevels: ['log', 'error', 'warn', 'debug', 'verbose', 'fatal'],
  });
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let sealer: CheckHandleSealer;
  const double = new FintavaDouble();
  const users: string[] = [];
  const previous: Record<string, string | undefined> = {};
  const http = () => request(app.getHttpServer());

  function person(): Person {
    const id = randomUUID();
    users.push(id);
    const local = `080${digits(8)}`;
    return {
      id,
      auth: `Bearer ${mintToken(id, `+234${local.slice(1)}`)}`,
      local,
      bvn: digits(11),
      nin: digits(11),
    };
  }

  function installFintava(): void {
    double.on('POST', '/compliance/verify/bvn/selfie', {
      status: 200,
      body: SELFIE_MATCHED,
    });
    double.on('GET', '/customers/details', {
      status: 404,
      body: {
        status: 404,
        timestamp: new Date().toISOString(),
        message: ['Customer not found'],
        path: '/api/dev/customers/details',
      },
    });
    double.on('GET', '/customers/list', {
      status: 200,
      body: {
        data: [],
        meta: {
          page: '1',
          take: '100',
          itemCount: 0,
          pageCount: 0,
          hasPreviousPage: false,
          hasNextPage: false,
        },
        message: 'Merchant customers list fetched',
        status: 200,
      },
    });
    double.on('POST', '/create/customer', (req) => {
      const b = req.body as { phoneNumber: string; bvn: string };
      const customerId = randomUUID();
      return {
        status: 201,
        body: {
          data: {
            userInfo: {
              id: customerId,
              phoneNumber: b.phoneNumber,
              bvn: b.bvn,
              firstName: 'Amaka',
              lastName: 'Opener',
            },
            wallet: {
              id: randomUUID(),
              accountNumber: digits(10),
              accountName: 'Amaka Opener',
              isFrozen: false,
              status: 'active',
              fundMethod: 'STATIC_FUND',
            },
          },
          status: 201,
          message: 'User created successfully',
        },
      };
    });
    double.on('GET', /^\/customer\/wallet\/balance\/.+$/, {
      status: 200,
      body: WALLET_BALANCE,
    });
  }

  /** KYC-01's check, passed, through its own route: answers the handle. */
  async function checked(
    who: Person,
    bvn = who.bvn,
    nin = who.nin,
  ): Promise<string> {
    double.on('GET', '/compliance/verify/bvn', {
      status: 200,
      body: { data: { ...BVN_200.data, bvn, phone_number1: who.local } },
    });
    const res = await http()
      .post('/api/hub/money/identity/bvn')
      .set('Authorization', who.auth)
      .send({ bvn, nin })
      .expect(200);
    const handle = body<BvnCheckView>(res, true).data!.checkHandle;
    handles.push(handle);
    return handle;
  }

  const selfie = (who: Person, payload: Record<string, unknown>) =>
    http()
      .post('/api/hub/money/identity/selfie')
      .set('Authorization', who.auth)
      .send({ image: jpegImage().toString('base64'), ...payload });
  const details = {
    firstName: 'Amaka',
    lastName: 'Opener',
    dateOfBirth: '1990-05-17',
    address: '14 Admiralty Way, Lekki, Lagos',
  };
  const open = (who: Person, payload: Record<string, unknown>) =>
    http()
      .post('/api/hub/money/wallet/open')
      .set('Authorization', who.auth)
      .send({ ...details, ...payload });

  const selfieCalls = () =>
    double.seen.filter((s) => s.path === '/compliance/verify/bvn/selfie');
  const creates = () =>
    double.seen.filter(
      (s) => s.method === 'POST' && s.path === '/create/customer',
    );

  /** A refusal of a handle: one plain answer, no detail of what failed, nothing sent to Fintava. */
  function expectCheckAgain(res: Response): void {
    expect(res.status).toBe(409);
    const b = body<null>(res);
    expect(b.message).toBe(CHECK_AGAIN_MESSAGE);
    expect(b.reason).toEqual({
      code: 'bvn_not_checked',
      message: CHECK_AGAIN_MESSAGE,
    });
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
    await app.listen(0, '127.0.0.1');
    prisma = moduleRef.get(PrismaService);
    sealer = new CheckHandleSealer(moduleRef.get(IdentityHasher));
  });

  beforeEach(() => {
    double.reset();
    installFintava();
  });

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
  describe('the round trip', () => {
    it('a passed check answers a handle; the selfie and the opening take it in place of the numbers, and Fintava gets them as before', async () => {
      const user = person();
      const handle = await checked(user);
      expect(handle).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
      expect(handle).not.toContain(user.bvn);
      expect(handle).not.toContain(user.nin);

      const matched = await selfie(user, { checkHandle: handle }).expect(200);
      expect(body<SelfieMatchView>(matched).data!.matchedAt).not.toBeNull();
      expect(selfieCalls()).toHaveLength(1);
      expect((selfieCalls()[0].body as { bvn: string }).bvn).toBe(user.bvn);

      const opened = await open(user, { checkHandle: handle }).expect(200);
      expect(body<WalletView>(opened).data!.state).toBe('open');
      expect(creates()).toHaveLength(1);
      const sent = creates()[0].body as { bvn: string; nin?: string };
      expect(sent.bvn).toBe(user.bvn);
      expect(JSON.stringify(creates()[0].body)).toContain(user.nin);
    });

    it('the numbers sent again still work as before (additive)', async () => {
      const user = person();
      await checked(user);
      await selfie(user, { bvn: user.bvn }).expect(200);
      const opened = await open(user, { bvn: user.bvn, nin: user.nin }).expect(
        200,
      );
      expect(body<WalletView>(opened).data!.state).toBe('open');
    });

    it('one handle serves a retried selfie and a retried opening within its life', async () => {
      const user = person();
      const handle = await checked(user);
      double.on('POST', '/compliance/verify/bvn/selfie', {
        status: 200,
        body: { data: { match: false }, status: 200, message: 'successful' },
      });
      await selfie(user, { checkHandle: handle }).expect(422);
      double.on('POST', '/compliance/verify/bvn/selfie', {
        status: 200,
        body: SELFIE_MATCHED,
      });
      await selfie(user, { checkHandle: handle }).expect(200);
      await open(user, { checkHandle: handle }).expect(200);
    });
  });

  // -------------------------------------------------------------------------
  describe('a handle that cannot be used is refused, the same way, and Fintava is not asked', () => {
    it('a changed byte anywhere (nonce, sealed body, tag) is refused', async () => {
      const user = person();
      const handle = await checked(user);
      const raw = Buffer.from(handle.slice(3), 'base64url');
      for (const at of [0, 20, raw.length - 1]) {
        const bent = Buffer.from(raw);
        bent[at] ^= 0x01;
        const tampered = `v1.${bent.toString('base64url')}`;
        handles.push(tampered);
        expectCheckAgain(await selfie(user, { checkHandle: tampered }));
        expectCheckAgain(await open(user, { checkHandle: tampered }));
      }
      expect(selfieCalls()).toHaveLength(0);
      expect(creates()).toHaveLength(0);
    });

    it('an expired handle is refused', async () => {
      const user = person();
      await checked(user);
      const attempt = await prisma.bvnCheckAttempt.findFirstOrThrow({
        where: { wawuUserId: user.id, outcome: 'verified' },
      });
      const past = new Date(Date.now() - (CHECK_HANDLE_TTL_SECONDS + 5) * 1000);
      const stale = sealer.seal(
        { sub: user.id, bvn: user.bvn, nin: user.nin, checkId: attempt.id },
        past,
      );
      handles.push(stale);
      expectCheckAgain(await selfie(user, { checkHandle: stale }));
      expectCheckAgain(await open(user, { checkHandle: stale }));
      // The same check, sealed now, opens: only the time differs.
      const fresh = sealer.seal({
        sub: user.id,
        bvn: user.bvn,
        nin: user.nin,
        checkId: attempt.id,
      });
      handles.push(fresh);
      await selfie(user, { checkHandle: fresh }).expect(200);
    });

    it('another person’s handle is refused, though both passed a check', async () => {
      const a = person();
      const b = person();
      const handleA = await checked(a);
      await checked(b);
      expectCheckAgain(await selfie(b, { checkHandle: handleA }));
      expectCheckAgain(await open(b, { checkHandle: handleA }));
      expect(selfieCalls()).toHaveLength(0);
    });

    it('a handle naming a check that did not pass, or that is not this person’s, is refused', async () => {
      const user = person();
      await checked(user);
      const refused = await prisma.bvnCheckAttempt.create({
        data: { wawuUserId: user.id, outcome: 'refused' },
      });
      const other = person();
      await checked(other);
      const othersAttempt = await prisma.bvnCheckAttempt.findFirstOrThrow({
        where: { wawuUserId: other.id, outcome: 'verified' },
      });
      for (const checkId of [refused.id, othersAttempt.id, randomUUID()]) {
        const h = sealer.seal({
          sub: user.id,
          bvn: user.bvn,
          nin: user.nin,
          checkId,
        });
        handles.push(h);
        expectCheckAgain(await selfie(user, { checkHandle: h }));
      }
      expect(selfieCalls()).toHaveLength(0);
    });

    it('a handle from an earlier check is refused once a check of another BVN has passed', async () => {
      const user = person();
      const first = await checked(user);
      await checked(user, digits(11));
      expectCheckAgain(await selfie(user, { checkHandle: first }));
      expectCheckAgain(await open(user, { checkHandle: first }));
    });

    it('a handle from an earlier check is refused once a check of the same BVN with another NIN has passed: the NIN is compared too', async () => {
      const user = person();
      const first = await checked(user);
      const newNin = digits(11);
      const second = await checked(user, user.bvn, newNin);
      expectCheckAgain(await selfie(user, { checkHandle: first }));
      expectCheckAgain(await open(user, { checkHandle: first }));
      expect(selfieCalls()).toHaveLength(0);
      expect(creates()).toHaveLength(0);
      // The newer handle serves, and Fintava gets the NIN of the check that is current.
      await selfie(user, { checkHandle: second }).expect(200);
      await open(user, { checkHandle: second }).expect(200);
      expect(JSON.stringify(creates()[0].body)).toContain(newNin);
      expect(JSON.stringify(creates()[0].body)).not.toContain(user.nin);
    });

    it('a handle sealed under another key, or not a handle at all, is refused, never a 500', async () => {
      const user = person();
      const handle = await checked(user);
      const foreignHasher = new IdentityHasher(
        new ConfigService({
          IDENTITY_HASH_KEY: 'another-servers-key-0123456789abcdef0123',
        }),
      );
      const attempt = await prisma.bvnCheckAttempt.findFirstOrThrow({
        where: { wawuUserId: user.id, outcome: 'verified' },
      });
      const foreign = new CheckHandleSealer(foreignHasher).seal({
        sub: user.id,
        bvn: user.bvn,
        nin: user.nin,
        checkId: attempt.id,
      });
      handles.push(foreign);
      for (const bad of [
        foreign,
        'v1.',
        'v2' + handle.slice(2),
        handle.slice(0, 40),
        'v1.!!!!',
        '',
        'x'.repeat(1024),
      ]) {
        expectCheckAgain(await selfie(user, { checkHandle: bad }));
      }
      expect(selfieCalls()).toHaveLength(0);
    });

    it('a handle that is not a string, or too long, is a 400 that repeats nothing sent', async () => {
      const user = person();
      for (const bad of [42, { bvn: user.bvn }, 'v1.' + 'A'.repeat(1100)]) {
        const res = await selfie(user, { checkHandle: bad });
        expect(res.status).toBe(400);
        const b = body<null>(res);
        expect(b.message).toBe(CHECK_HANDLE_INVALID_MESSAGE);
        expect(res.text).not.toContain(user.bvn);
        expect(res.text).not.toContain('AAAAAAAA');
      }
    });

    it('a handle with the numbers too is a 400; neither is a 400', async () => {
      const user = person();
      const handle = await checked(user);
      const both = await selfie(user, { checkHandle: handle, bvn: user.bvn });
      expect(both.status).toBe(400);
      expect(body<null>(both).message).toBe(
        'Send checkHandle or bvn, not both.',
      );
      const bothOpen = await open(user, { checkHandle: handle, nin: user.nin });
      expect(bothOpen.status).toBe(400);
      // The first refusal is the one answered: here the missing BVN of the pair.
      expect([
        'Send checkHandle, or bvn and nin, not both.',
        'bvn must be 11 digits',
      ]).toContain(body<null>(bothOpen).message);
      const bothNumbers = await open(user, {
        checkHandle: handle,
        bvn: user.bvn,
        nin: user.nin,
      });
      expect(bothNumbers.status).toBe(400);
      expect(body<null>(bothNumbers).message).toBe(
        'Send checkHandle, or bvn and nin, not both.',
      );
      const neither = await selfie(user, {});
      expect(neither.status).toBe(400);
      expect(body<null>(neither).message).toBe('bvn must be 11 digits');
      expect(selfieCalls()).toHaveLength(0);
    });
  });

  /** Seals any claims under this server's handle key, as only the server can: for shapes `seal` never makes. */
  function sealRaw(claims: Record<string, unknown>): string {
    const key = app.get(IdentityHasher).deriveKey(CHECK_HANDLE_LABEL);
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(CHECK_HANDLE_LABEL));
    const sealed = Buffer.concat([
      cipher.update(JSON.stringify(claims), 'utf8'),
      cipher.final(),
    ]);
    const h = `v1.${Buffer.concat([nonce, sealed, cipher.getAuthTag()]).toString('base64url')}`;
    handles.push(h);
    return h;
  }

  describe('a handle sealed by this server but not for this use is refused', () => {
    it('one sealed for someone else, naming this person’s own passed check and numbers, is refused', async () => {
      const user = person();
      await checked(user);
      const attempt = await prisma.bvnCheckAttempt.findFirstOrThrow({
        where: { wawuUserId: user.id, outcome: 'verified' },
      });
      const notMine = sealer.seal({
        sub: randomUUID(),
        bvn: user.bvn,
        nin: user.nin,
        checkId: attempt.id,
      });
      handles.push(notMine);
      expectCheckAgain(await selfie(user, { checkHandle: notMine }));
      expectCheckAgain(await open(user, { checkHandle: notMine }));
      expect(selfieCalls()).toHaveLength(0);
    });

    it('one that claims a longer life than a handle has, or an extra field, or misses one, is refused', async () => {
      const user = person();
      await checked(user);
      const attempt = await prisma.bvnCheckAttempt.findFirstOrThrow({
        where: { wawuUserId: user.id, outcome: 'verified' },
      });
      const now = Math.floor(Date.now() / 1000);
      const good = {
        sub: user.id,
        bvn: user.bvn,
        nin: user.nin,
        checkId: attempt.id,
        iat: now,
        exp: now + 60,
      };
      // The same shape opens: only the change differs in each case below.
      await selfie(user, { checkHandle: sealRaw(good) }).expect(200);
      const user2 = person();
      await checked(user2);
      const attempt2 = await prisma.bvnCheckAttempt.findFirstOrThrow({
        where: { wawuUserId: user2.id, outcome: 'verified' },
      });
      const base = {
        ...good,
        sub: user2.id,
        bvn: user2.bvn,
        nin: user2.nin,
        checkId: attempt2.id,
      };
      const { nin: _dropped, ...missing } = base;
      void _dropped;
      for (const claims of [
        { ...base, iat: now - 10, exp: now + CHECK_HANDLE_TTL_SECONDS * 10 },
        { ...base, extra: 'x' },
        missing,
        { ...base, bvn: 22190000111 },
        { ...base, iat: now + 3600, exp: now + 3600 + 60 },
      ]) {
        expectCheckAgain(await selfie(user2, { checkHandle: sealRaw(claims) }));
      }
      expect(selfieCalls()).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  describe('the sealer', () => {
    it('seals under the HKDF key for its label, with a fresh nonce each time', () => {
      const claims = {
        sub: randomUUID(),
        bvn: digits(11),
        nin: digits(11),
        checkId: randomUUID(),
      };
      const a = sealer.seal(claims);
      const b = sealer.seal(claims);
      handles.push(a, b);
      expect(a).not.toBe(b);
      expect(sealer.open(a)).toMatchObject(claims);
      const opened = sealer.open(a)!;
      expect(opened.exp - opened.iat).toBe(CHECK_HANDLE_TTL_SECONDS);
      expect(CHECK_HANDLE_LABEL).toBe('wawu/kyc-check-handle/v1');
      // Expired at the second it ends; still good a second before.
      const at = new Date((opened.exp - 1) * 1000);
      expect(sealer.open(a, at)).not.toBeNull();
      expect(sealer.open(a, new Date(opened.exp * 1000))).toBeNull();
    });

    it('never shows its key', () => {
      expect(JSON.stringify(sealer)).toBe('{}');
      expect(inspect(sealer)).toBe('CheckHandleSealer {}');
    });
  });

  // -------------------------------------------------------------------------
  describe('a handle is never logged, stored or echoed', () => {
    it('no log line holds a handle or any part of one', () => {
      expect(handles.length).toBeGreaterThan(10);
      const logs = captured.join('\n');
      for (const h of handles) {
        expect(logs).not.toContain(h.slice(3, 40));
      }
    });

    it('no answer but the BVN check’s own carries a handle', () => {
      for (const a of answered.filter((x) => !x.fromCheck)) {
        for (const h of handles) expect(a.text).not.toContain(h.slice(3, 40));
        expect(a.text).not.toContain('checkHandle":"v1.');
      }
    });

    it('no column of any row these people own holds a handle', async () => {
      const where = { wawuUserId: { in: users } };
      const rows = JSON.stringify([
        await prisma.walletIdentity.findMany({ where }),
        await prisma.bvnCheckAttempt.findMany({ where }),
        await prisma.selfieMatchAttempt.findMany({ where }),
        await prisma.fintavaWalletOpening.findMany({ where }),
        await prisma.fintavaWallet.findMany({ where }),
      ]);
      for (const h of handles) expect(rows).not.toContain(h.slice(3, 40));
      expect(rows).not.toContain('v1.');
    });
  });
});
