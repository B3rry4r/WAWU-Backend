import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  INestApplication,
  LoggerService,
  RequestMethod,
  ValidationPipe,
} from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { ConfigModule } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import * as argon2 from 'argon2';
import * as jwt from 'jsonwebtoken';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import {
  FintavaDouble,
  WALLET_BALANCE,
} from '../../../../test/fintava/fintava-double';
import { WawuIdClient } from '../../../common/auth/wawu-id.client';
import { WawuJwtStrategy } from '../../../common/auth/wawu-jwt.strategy';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { MoneyModule } from '../../money.module';
import type { WalletView } from '../../money-view.type';
import { PIN_MAX_TRIES } from '../../pin/transaction-pin.service';
import {
  NO_WALLET_MESSAGE,
  WALLET_OPENING_MESSAGE,
  WalletGateGuard,
} from '../wallet-gate';

/**
 * "No wallet yet" over HTTP (task MONEY-13): a signed-in person with no
 * wallet gets the same answer from every wallet and payment route, and never
 * a 500.
 *
 * The routes are not listed by hand: they are every route MoneyModule
 * mounts that runs the wallet gate (wallet-gate-coverage.spec.ts holds that
 * set to the contract), so a route served later is tried here as it lands.
 * Each is sent what a careless or hostile client might send (no body, a
 * wrong body, a PIN, an id that is not a UUID), because the gate must
 * answer before any of it is looked at.
 *
 * The real MoneyModule, a real database, real RS256 tokens checked against
 * the mock WAWU ID's JWKS (WAWU_ID_JWKS_URL), and the real MONEY-06 client
 * talking to the local Fintava stand-in, which must see nothing for a
 * person without a wallet.
 */

const KEY = 'live_test_gate_0123456789FAKEKEY';

const NOT_OPEN_BODY = {
  statusCode: 409,
  message: NO_WALLET_MESSAGE,
  data: null,
  reason: { code: 'wallet_not_open', message: NO_WALLET_MESSAGE },
};

const OPENING_BODY = {
  statusCode: 409,
  message: WALLET_OPENING_MESSAGE,
  data: null,
  reason: { code: 'wallet_opening', message: WALLET_OPENING_MESSAGE },
};

function mintToken(sub: string): string {
  const privateKey = readFileSync(
    join(__dirname, '../../../../mock-wawu-id/private.pem'),
    'utf8',
  );
  return jwt.sign(
    {
      sub,
      email: `gate-${sub}@test.wawu.dev`,
      phone: '+2348000009997',
      firstName: 'Gate',
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

class CapturingLogger implements LoggerService {
  lines: string[] = [];
  private push(level: string, args: unknown[]) {
    this.lines.push(
      `${level} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`,
    );
  }
  log(...a: unknown[]) {
    this.push('log', a);
  }
  error(...a: unknown[]) {
    this.push('error', a);
  }
  warn(...a: unknown[]) {
    this.push('warn', a);
  }
  debug() {}
  verbose() {}
  fatal(...a: unknown[]) {
    this.push('fatal', a);
  }
}

type GatedRoute = { method: string; path: string };

/** Every route of MoneyModule's controllers that runs the wallet gate. */
function gatedRoutes(): GatedRoute[] {
  const routes: GatedRoute[] = [];
  const controllers = (Reflect.getMetadata(
    MODULE_METADATA.CONTROLLERS,
    MoneyModule,
  ) ?? []) as Array<{ prototype: object }>;
  for (const controller of controllers) {
    const base = String(Reflect.getMetadata(PATH_METADATA, controller) ?? '');
    const proto = controller.prototype as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(proto)) {
      const handler = proto[name];
      if (name === 'constructor' || typeof handler !== 'function') continue;
      const path = Reflect.getMetadata(PATH_METADATA, handler) as
        string | undefined;
      if (path === undefined) continue;
      const guards = [
        ...((Reflect.getMetadata(GUARDS_METADATA, controller) ??
          []) as unknown[]),
        ...((Reflect.getMetadata(GUARDS_METADATA, handler) ?? []) as unknown[]),
      ];
      if (!guards.includes(WalletGateGuard)) continue;
      const method =
        RequestMethod[
          Reflect.getMetadata(METHOD_METADATA, handler) as number
        ].toLowerCase();
      routes.push({
        method,
        path: `/api/hub/${[base, path].join('/').replace(/\/+/g, '/')}`,
      });
    }
  }
  return routes;
}

/** What a client might send: nothing, junk, a PIN, a path id that is not a UUID. */
const SHAPES: Array<{
  name: string;
  body?: unknown;
  pin?: string;
  id: string;
}> = [
  { name: 'nothing', id: randomUUID() },
  {
    name: 'a wrong body and a PIN',
    body: { pin: 'abcd', pinConfirmation: 12, amountKobo: -1, extra: true },
    pin: '1234',
    id: randomUUID(),
  },
  { name: 'a malformed PIN and an id that is not a UUID', pin: '12', id: 'x' },
];

describe('No wallet yet: every wallet route answers the same (MONEY-13) over HTTP', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const double = new FintavaDouble();
  const logger = new CapturingLogger();
  const users: string[] = [];
  const legacyRefs: string[] = [];
  const previous: Record<string, string | undefined> = {};
  const routes = gatedRoutes();

  type Person = { id: string; auth: string };

  function newPerson(): Person {
    const id = randomUUID();
    users.push(id);
    return { id, auth: `Bearer ${mintToken(id)}` };
  }

  const hex = () => randomBytes(32).toString('hex');
  const phone = () =>
    `+23480${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;

  /** A person part-way through Open your wallet: BVN and NIN checked (KYC-01). */
  async function identityChecked(): Promise<Person> {
    const p = newPerson();
    await prisma.walletIdentity.create({
      data: {
        wawuUserId: p.id,
        bvnHash: hex(),
        bvnLast4: '0001',
        bvnVerifiedAt: new Date(),
        ninHash: hex(),
        ninLast4: '0002',
        verifiedPhone: phone(),
      },
    });
    return p;
  }

  /** A person whose opening (MONEY-12) is in this state, with no wallet row. */
  async function withOpening(
    state: string,
    failure: string | null = null,
  ): Promise<Person> {
    const p = await identityChecked();
    await prisma.fintavaWalletOpening.create({
      data: {
        wawuUserId: p.id,
        state,
        failure,
        bvnHash: hex(),
        bvnVerifiedAt: new Date(),
        phone: phone(),
      },
    });
    return p;
  }

  /**
   * An existing web creator: a Flutterwave wallet (`CreatorWallet`), and a
   * PIN set before MONEY-13 gated the PIN routes. Still no Fintava wallet.
   */
  async function existingWebCreator(pin: string): Promise<Person> {
    const p = newPerson();
    const ref = `PSA${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    legacyRefs.push(ref);
    await prisma.creatorWallet.create({
      data: {
        wawuUserId: p.id,
        accountReference: ref,
        barterId: `barter-${randomUUID()}`,
        nuban: '1234509876',
        bankName: 'Flutterwave MFB',
      },
    });
    await prisma.transactionPin.create({
      data: {
        wawuUserId: p.id,
        pinHash: await argon2.hash(pin, { type: argon2.argon2id }),
      },
    });
    return p;
  }

  /** A person whose Fintava wallet is on record (as MONEY-12 stores it). */
  async function withWallet(): Promise<Person & { walletId: string }> {
    const p = newPerson();
    const walletId = randomUUID();
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId: p.id,
        customerId: randomUUID(),
        walletId,
        accountNumber: `13${String(Date.now()).slice(-6)}${String(users.length).padStart(2, '0')}`,
        accountName: 'gate tester',
      },
    });
    return { ...p, walletId };
  }

  function send(
    route: GatedRoute,
    auth: string,
    shape: (typeof SHAPES)[number],
  ) {
    const path = route.path.replace(/:[A-Za-z]+/g, shape.id);
    const agent = request(app.getHttpServer());
    let req =
      route.method === 'get'
        ? agent.get(path)
        : route.method === 'post'
          ? agent.post(path)
          : route.method === 'put'
            ? agent.put(path)
            : route.method === 'delete'
              ? agent.delete(path)
              : agent.patch(path);
    req = req.set('Authorization', auth);
    if (shape.pin !== undefined) req = req.set('X-Transaction-Pin', shape.pin);
    if (shape.body !== undefined && route.method !== 'get') {
      req = req.send(shape.body as object);
    }
    return req;
  }

  type Answer = { request: string; status: number; body: unknown };

  /** Every gated route, sent every shape, as this person: each answer with the request that got it. */
  async function everyRoute(p: Person): Promise<Answer[]> {
    const answers: Answer[] = [];
    for (const route of routes) {
      for (const shape of SHAPES) {
        const res = await send(route, p.auth, shape);
        answers.push({
          request: `${route.method} ${route.path} (${shape.name})`,
          status: res.status,
          body: res.body as unknown,
        });
      }
    }
    return answers;
  }

  function expectAll(answers: Answer[], body: object) {
    expect(answers).toHaveLength(routes.length * SHAPES.length);
    expect(answers).toEqual(
      answers.map((a) => ({ request: a.request, status: 409, body })),
    );
  }

  async function walletState(p: Person): Promise<WalletView['state']> {
    const res = await request(app.getHttpServer())
      .get('/api/hub/money/wallet')
      .set('Authorization', p.auth)
      .expect(200);
    return (res.body as { data: WalletView }).data.state;
  }

  beforeAll(async () => {
    await double.start();
    const env: Record<string, string> = {
      FINTAVA_BASE_URL: double.baseUrl,
      FINTAVA_API_KEY: KEY,
      FINTAVA_TIMEOUT_MS: '2000',
    };
    for (const [k, v] of Object.entries(env)) {
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
    // One server for the whole file (FIX-02): the concurrency test below
    // sends requests at once.
    await app.listen(0, '127.0.0.1');
    prisma = moduleRef.get(PrismaService);
  });

  beforeEach(() => double.reset());

  afterAll(async () => {
    const where = { wawuUserId: { in: users } };
    await prisma.transactionPin.deleteMany({ where });
    await prisma.fintavaWallet.deleteMany({ where });
    await prisma.fintavaWalletOpening.deleteMany({ where });
    await prisma.walletIdentity.deleteMany({ where });
    await prisma.creatorWallet.deleteMany({
      where: { accountReference: { in: legacyRefs } },
    });
    await app.close();
    await double.stop();
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('tries every gated route: the PIN routes, the balance, the PIN reset and biometric approval (MONEY-14), the history (MONEY-15), beneficiaries and the payout account (WALLET-14), the fee quote (WALLET-15)', () => {
    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      'delete /api/hub/money/beneficiaries/:id',
      'delete /api/hub/money/device',
      'get /api/hub/money/beneficiaries',
      'get /api/hub/money/device',
      'get /api/hub/money/fees/quote',
      'get /api/hub/money/payout-account',
      'get /api/hub/money/pin',
      'get /api/hub/money/transactions',
      'get /api/hub/money/transactions/:id',
      'get /api/hub/money/transactions/summary',
      'get /api/hub/money/wallet/balance',
      'post /api/hub/money/approval/verify',
      'post /api/hub/money/beneficiaries',
      'post /api/hub/money/device/challenge',
      'post /api/hub/money/pin',
      'post /api/hub/money/pin/reset',
      'post /api/hub/money/pin/reset/confirm',
      'post /api/hub/money/pin/verify',
      'put /api/hub/money/device',
      'put /api/hub/money/payout-account',
      'put /api/hub/money/pin',
    ]);
  });

  describe('no wallet: 409 wallet_not_open, the same body everywhere', () => {
    const cases: Array<[string, () => Promise<Person>]> = [
      ['a new user, nothing stored', () => Promise.resolve(newPerson())],
      ['a user whose BVN and NIN passed, no opening yet', identityChecked],
      [
        'a user whose last opening failed (the next one may try again)',
        () => withOpening('failed', 'lookup_unavailable'),
      ],
      [
        "a user whose opening stopped: the phone's Fintava customer has another BVN",
        () => withOpening('conflict', 'phone_held_by_other_identity'),
      ],
      [
        "a user whose opening stopped: the phone's Fintava customer has no readable BVN",
        () => withOpening('conflict', 'phone_holder_bvn_unreadable'),
      ],
    ];
    for (const [who, make] of cases) {
      it(`${who}: every route, every request shape; GET /money/wallet reads not_open; Fintava is not asked`, async () => {
        const p = await make();
        expectAll(await everyRoute(p), NOT_OPEN_BODY);
        expect(await walletState(p)).toBe('not_open');
        expect(double.seen).toHaveLength(0);
      });
    }

    it('an existing web creator with a Flutterwave wallet and an old PIN: no wallet, and five wrong PINs use up no try', async () => {
      const p = await existingWebCreator('4826');
      expectAll(await everyRoute(p), NOT_OPEN_BODY);
      for (let i = 0; i < PIN_MAX_TRIES; i += 1) {
        const res = await request(app.getHttpServer())
          .post('/api/hub/money/pin/verify')
          .set('Authorization', p.auth)
          .set('X-Transaction-Pin', '0000');
        expect({ status: res.status, body: res.body as unknown }).toEqual({
          status: 409,
          body: NOT_OPEN_BODY,
        });
      }
      const pin = await prisma.transactionPin.findUnique({
        where: { wawuUserId: p.id },
      });
      expect(pin).toMatchObject({ failedTries: 0, lockedUntil: null });
      // The old PIN is left as it was: nothing set, changed or cleared.
      expect(await argon2.verify(pin!.pinHash, '4826')).toBe(true);
      expect(await walletState(p)).toBe('not_open');
      expect(double.seen).toHaveLength(0);
    });

    it('nothing is set or changed by a refused request', async () => {
      const p = newPerson();
      const set = await request(app.getHttpServer())
        .post('/api/hub/money/pin')
        .set('Authorization', p.auth)
        .send({ pin: '4826', pinConfirmation: '4826' });
      expect(set.status).toBe(409);
      expect(
        await prisma.transactionPin.findUnique({ where: { wawuUserId: p.id } }),
      ).toBeNull();
    });

    it('30 requests at once across the routes: all 409, no 500, no reset', async () => {
      const p = newPerson();
      const sends: Array<Promise<Response>> = [];
      for (let i = 0; i < 30; i += 1) {
        sends.push(
          Promise.resolve(
            send(routes[i % routes.length], p.auth, SHAPES[i % SHAPES.length]),
          ),
        );
      }
      const answers = await Promise.all(sends);
      expect(answers.map((r) => r.status)).toEqual(answers.map(() => 409));
      expect(new Set(answers.map((r) => r.text)).size).toBe(1);
      expect(answers[0].body).toEqual(NOT_OPEN_BODY);
    });
  });

  describe('still being opened: 409 wallet_opening, the same body everywhere', () => {
    const cases: Array<[string, () => Promise<Person>]> = [
      ['the create is in flight', () => withOpening('opening')],
      ["the create's answer was lost", () => withOpening('unknown')],
      [
        'the account found is held for review',
        () => withOpening('conflict', 'held_by_other_account'),
      ],
      [
        'the opening is recorded, the wallet row not yet visible',
        () => withOpening('open'),
      ],
    ];
    for (const [when, make] of cases) {
      it(`${when}: every route, every request shape; GET /money/wallet reads opening; Fintava is not asked`, async () => {
        const p = await make();
        expectAll(await everyRoute(p), OPENING_BODY);
        expect(await walletState(p)).toBe('opening');
        expect(double.seen).toHaveLength(0);
      });
    }
  });

  describe('an open wallet passes the gate', () => {
    it('the PIN can be set, read and checked, and the balance is asked of Fintava', async () => {
      const p = await withWallet();
      const agent = () => request(app.getHttpServer());
      await agent()
        .post('/api/hub/money/pin')
        .set('Authorization', p.auth)
        .send({ pin: '4826', pinConfirmation: '4826' })
        .expect(201);
      const state = await agent()
        .get('/api/hub/money/pin')
        .set('Authorization', p.auth)
        .expect(200);
      expect((state.body as { data: { isSet: boolean } }).data.isSet).toBe(
        true,
      );
      await agent()
        .post('/api/hub/money/pin/verify')
        .set('Authorization', p.auth)
        .set('X-Transaction-Pin', '4826')
        .expect(200);
      // A wrong PIN is now the PIN's own refusal, with a try used.
      const wrong = await agent()
        .post('/api/hub/money/pin/verify')
        .set('Authorization', p.auth)
        .set('X-Transaction-Pin', '0000')
        .expect(403);
      expect(wrong.body).toMatchObject({
        reason: { code: 'pin_incorrect', triesLeft: PIN_MAX_TRIES - 1 },
      });

      double.on('GET', `/customer/wallet/balance/${p.walletId}`, {
        status: 200,
        body: {
          ...WALLET_BALANCE,
          data: {
            ...WALLET_BALANCE.data,
            balance: { bookedBalance: 75, availableBalance: 75 },
          },
        },
      });
      const balance = await agent()
        .get('/api/hub/money/wallet/balance')
        .set('Authorization', p.auth)
        .expect(200);
      expect(balance.body).toMatchObject({ data: { availableKobo: 7500 } });
      expect(double.seen.map((s) => s.path)).toEqual([
        `/customer/wallet/balance/${p.walletId}`,
      ]);
      expect(await walletState(p)).toBe('open');
    });
  });

  it('no token is 401 on every gated route (the token, before the wallet)', async () => {
    for (const route of routes) {
      const res = await send(route, '', SHAPES[0]);
      expect({ route: route.path, status: res.status }).toEqual({
        route: route.path,
        status: 401,
      });
    }
  });

  it('a refusal writes no log line and carries no PIN', () => {
    const joined = logger.lines.join('\n');
    expect(joined).not.toMatch(/wallet_not_open|wallet_opening/);
    expect(joined).not.toContain('4826');
    expect(joined).not.toMatch(/\b500\b/);
  });
});
