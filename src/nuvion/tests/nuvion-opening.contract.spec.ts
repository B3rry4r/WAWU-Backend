import { createHash, randomInt, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import {
  ConsoleLogger,
  type INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { ModuleRef } from '@nestjs/core';
import { PassportModule } from '@nestjs/passport';
import { Test, type TestingModule } from '@nestjs/testing';
import * as jwt from 'jsonwebtoken';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import {
  envelope,
  errorBody,
  NuvionStandin,
  type StandinAnswer,
  type StandinRequest,
} from '../../../test/nuvion/nuvion-standin';
import {
  guardOutbound,
  type OutboundGuard,
} from '../../../test/nuvion/outbound-guard';
import { WawuIdDouble } from '../../../test/nuvion/wawu-id-double';
import { WawuIdClient } from '../../common/auth/wawu-id.client';
import { WawuJwtStrategy } from '../../common/auth/wawu-jwt.strategy';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { MoneyErrorReason } from '../../money/dto/money-error.dto';
import { MoneyModule } from '../../money/money.module';
import { NotificationModule } from '../../notification/notification.module';
import type { WalletView } from '../../money/money-view.type';
import { IdentityHasher } from '../../money/identity/identity-config';
import { REVIEW_REASONS } from '../../money/opening/review-stage';
import { WalletOpeningService } from '../../money/opening/wallet-opening.service';
import {
  UNDER_REVIEW_MESSAGE,
  WalletProviderError,
  walletProviderErrorToHttp,
} from '../../wallet-provider/wallet-provider-error';
import { WALLET_PROVIDER } from '../../wallet-provider/wallet-provider.interface';
import { NuvionOpeningHandler } from '../handlers/opening.handler';
import { NuvionClient } from '../nuvion-client';
import { NuvionWalletProvider } from '../nuvion-wallet-provider';
import { NuvionWebhookDispatcher } from '../webhook/nuvion-webhook-dispatcher.service';
import { NuvionWebhookModule } from '../webhook/nuvion-webhook.module';

/**
 * NUV-02: opening a wallet on Nuvion, over HTTP, against a real database,
 * real RS256 tokens (the WAWU ID stand-in's JWKS), and the real Nuvion
 * client and adapter talking over a socket to a stateful stand-in built on
 * NUV-01's (test/nuvion/nuvion-standin.ts) from the docs' own examples:
 * `POST /individual-entities` and `PATCH /individual-entities/{id}`
 * answer `{ address, entity, person, identification }` with each identity
 * number masked (api-reference__entities.md), `GET /entities/{id}` the same
 * entity, `GET /entities` a cursor page (the dashboard's call), and
 * `GET /accounts` / `POST /accounts` the account examples
 * (api-reference__accounts.md). Nothing leaves this machine (the outbound
 * guard), and every log line written during the file is captured: the last
 * tests prove no BVN, NIN or ID number reached a log, an answer or a column.
 *
 * Every Nuvion timeout is 1.5 s; a "late" answer comes 2 s after the
 * request: Nuvion made the thing and the client never heard.
 */

jest.setTimeout(60_000);

const TIMEOUT_MS = 1_500;
const LATE_MS = 2_000;
const RESEND_SAFETY_MS = 2_000;
const HASH_KEY = 'nuv02-test-opening-hash-key-0123456789abcdef';

const ENV: Record<string, string | undefined> = {
  WALLET_PROVIDER: 'nuvion',
  NUVION_BASE_URL: 'https://api.nuvion.dev',
  NUVION_API_KEY: 'nv_test_sk_NUV02openingKEY000000000000',
  NUVION_WEBHOOK_SECRET: 'whsec_nuv02_opening_0123456789',
  NUVION_OPERATIONAL_ACCOUNT_ID: '01HXYZOPERATIONAL000000001',
  IDENTITY_HASH_KEY: HASH_KEY,
  FINTAVA_BASE_URL: '',
  FINTAVA_API_KEY: '',
};

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
/** Every BVN, NIN and ID number sent in this file, for the final scans. */
const secrets: string[] = [];

function digits(n: number): string {
  let out = String(randomInt(1, 10));
  while (out.length < n) out += String(randomInt(0, 10));
  return out;
}

type Body = Record<string, unknown> & {
  bvn: string;
  nin: string;
  idNumber: string;
  firstName: string;
  lastName: string;
};
type Person = {
  id: string;
  auth: string;
  phone: string;
  email: string;
  body: Body;
};
type Envelope<T> = {
  statusCode: number;
  message: string;
  data: T | null;
  reason?: MoneyErrorReason;
};

/** One entity as the stand-in holds it. */
type Held = {
  id: string;
  personId: string;
  status: string;
  name: string;
  phone: string;
  email: string;
  bvnLast4: string;
  ninLast4: string;
  idLast4: string;
  created: number;
  /** Nuvion's own `updated` (Unix ms): moves when the entity is written. */
  updated: number;
  bvnStatus: string;
  ninStatus: string;
  documentStatus: string;
  addressProofStatus: string;
  extra: Record<string, unknown>;
};
type HeldAccount = {
  id: string;
  entity_id: string;
  type: string;
  currency: string;
  nuvion_ban: string;
  created: number;
};

describe('NUV-02: opening a wallet on Nuvion', () => {
  const logger = new ConsoleLogger({
    logLevels: ['log', 'error', 'warn', 'debug', 'verbose', 'fatal'],
  });
  const standin = new NuvionStandin();
  const wawuId = new WawuIdDouble();
  let guard: OutboundGuard;
  let app: INestApplication<App>;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let handler: NuvionOpeningHandler;
  const users: string[] = [];
  const previous: Record<string, string | undefined> = {};

  let entities: Held[] = [];
  let accounts: HeldAccount[] = [];
  let createMode:
    | 'ok'
    | 'late'
    | 'made_then_500'
    | 'nothing_then_500'
    | { refuse: string; message?: string } = 'ok';
  /** Milliseconds a good create answer is held back (inside the timeout). */
  let createDelayMs = 0;
  let listMode: 'ok' | 'endless' | { refuse: string } = 'ok';
  let accountMode: 'ok' | 'late' | 'already_exists' | { refuse: string } = 'ok';

  const ms = () => Date.now();
  const masked = (last4: string) => `***${last4}`;
  const entityJson = (e: Held) => ({
    id: e.id,
    type: 'individual',
    status: e.status,
    name: e.name,
    is_root: false,
    parent_entity: '01HXYZ1234ABCDEFGHJKMNPQRS',
    person_id: e.personId,
    creation_context: 'api',
    risk_level: 'medium',
    created: e.created,
    updated: e.updated,
    ...e.extra,
  });
  const full = (e: Held) => ({
    entity: entityJson(e),
    person: {
      id: e.personId,
      first_name: e.name.split(' ')[0],
      last_name: e.name.split(' ')[1],
      email: e.email,
      nationality: 'NG',
      gender: 'f',
      is_pep: false,
      status: 'approved',
      phonenumber: e.phone,
    },
    identification: {
      id: `${e.id.slice(0, 20)}IDENT0`,
      person_id: e.personId,
      verification_status: e.status === 'approved' ? 'approved' : 'pending',
      document: {
        type: 'international_passport',
        number: masked(e.idLast4),
        verification_status: e.documentStatus,
      },
      proof_of_address: {
        type: 'utility_bill',
        verification_status: e.addressProofStatus,
      },
      identity_numbers: [
        {
          type: 'BVN',
          value: masked(e.bvnLast4),
          verification_status: e.bvnStatus,
        },
        {
          type: 'NIN',
          value: masked(e.ninLast4),
          verification_status: e.ninStatus,
        },
      ],
    },
  });
  const ulid = (p: string) =>
    `${p}${randomUUID().replace(/-/g, '').toUpperCase()}`.slice(0, 26);

  function makeEntity(b: Record<string, unknown>): Held {
    const person = b.person as Record<string, string>;
    const id = (b.identification as { document: { number: string } }).document;
    const e: Held = {
      id: ulid('01ENT'),
      personId: ulid('01PER'),
      status: 'incomplete',
      name: String(b.name),
      phone: person.phonenumber,
      email: person.email,
      bvnLast4: String(person.bvn).slice(-4),
      ninLast4: String(person.nin).slice(-4),
      idLast4: id.number.slice(-4),
      created: ms(),
      updated: ms(),
      bvnStatus: 'pending',
      ninStatus: 'pending',
      documentStatus: 'pending',
      addressProofStatus: 'pending',
      extra: {},
    };
    entities.push(e);
    return e;
  }

  function installNuvion(): void {
    standin.on('POST', '/individual-entities', (req): StandinAnswer => {
      const mode = createMode;
      if (typeof mode === 'object') {
        return {
          status: 422,
          body: errorBody(mode.refuse, mode.message ?? 'Refused.'),
        };
      }
      if (mode === 'nothing_then_500') {
        return { status: 500, body: errorBody('error_system_internal_error') };
      }
      const e = makeEntity(req.body as Record<string, unknown>);
      if (mode === 'late') {
        return { status: 201, body: envelope(full(e)), delayMs: LATE_MS };
      }
      if (mode === 'made_then_500') {
        return { status: 500, body: errorBody('error_system_internal_error') };
      }
      return {
        status: 201,
        body: envelope(full(e), 'Individual entity created successfully'),
        ...(createDelayMs > 0 ? { delayMs: createDelayMs } : {}),
      };
    });
    standin.on('PATCH', /^\/individual-entities\/[^/]+$/, (req) => {
      const e = entities.find((x) => x.id === req.path.split('/')[2]);
      if (!e)
        return { status: 404, body: errorBody('error_resource_not_found') };
      const person = (req.body as { person?: Record<string, string> }).person;
      if (person?.bvn) e.bvnLast4 = person.bvn.slice(-4);
      if (person?.nin) e.ninLast4 = person.nin.slice(-4);
      e.updated = Math.max(ms(), e.updated + 1);
      return {
        status: 200,
        body: envelope(full(e), 'Individual entity updated successfully'),
      };
    });
    standin.on('GET', /^\/entities\/[^/]+$/, (req) => {
      const e = entities.find((x) => x.id === req.path.split('/')[2]);
      return e
        ? {
            status: 200,
            body: envelope(full(e), 'Entity retrieved successfully'),
          }
        : { status: 404, body: errorBody('error_resource_not_found') };
    });
    standin.on('GET', '/entities', (req) => {
      if (typeof listMode === 'object') {
        return {
          status: 404,
          body: errorBody(listMode.refuse, 'API endpoint does not exist'),
        };
      }
      if (listMode === 'endless') {
        // Always one more page, each with a new cursor: longer than read.
        const n = Number(String(req.query.cursor ?? 'c0').slice(1)) + 1;
        return {
          status: 200,
          body: envelope({
            data: [],
            meta: {
              pagination: {
                order: 'asc',
                has_next: true,
                limit: 100,
                has_previous: false,
                next_cursor: `c${n}`,
                previous_cursor: null,
              },
            },
          }),
        };
      }
      const rows = entities
        .filter((e) => !req.query.name || e.name === req.query.name)
        .map(entityJson);
      return {
        status: 200,
        body: envelope({
          data: rows,
          meta: {
            pagination: {
              order: 'asc',
              has_next: false,
              limit: 100,
              has_previous: false,
              next_cursor: null,
              previous_cursor: null,
            },
          },
        }),
      };
    });
    standin.on('GET', '/accounts', (req) => {
      const rows = accounts.filter(
        (a) =>
          a.entity_id === req.query.entity_id &&
          (!req.query.currency || a.currency === req.query.currency) &&
          (!req.query.type || a.type === req.query.type),
      );
      return {
        status: 200,
        body: envelope({
          data: rows.map((a) => ({
            ...a,
            balance: { available: 0, current: 0, overdraft_used: 0 },
            deleted: 0,
          })),
          meta: {
            pagination: {
              order: 'asc',
              has_next: false,
              limit: 100,
              has_previous: false,
              next_cursor: null,
              previous_cursor: null,
            },
          },
        }),
      };
    });
    standin.on('POST', '/accounts', (req) => {
      const b = req.body as {
        entity_id: string;
        currency: string;
        type: string;
      };
      const mode = accountMode;
      if (typeof mode === 'object') {
        return { status: 400, body: errorBody(mode.refuse, 'Refused.') };
      }
      if (mode === 'already_exists') {
        return { status: 409, body: errorBody('error_account_already_exists') };
      }
      const a: HeldAccount = {
        id: ulid('01ACC'),
        entity_id: b.entity_id,
        type: b.type,
        currency: b.currency,
        nuvion_ban: `00${digits(8)}`,
        created: ms(),
      };
      accounts.push(a);
      const answer = {
        status: 201,
        body: envelope(
          {
            account: a,
            entity_impact: { entity_id: b.entity_id, total_accounts: 1 },
          },
          'Account created successfully',
        ),
      };
      return mode === 'late' ? { ...answer, delayMs: LATE_MS } : answer;
    });
  }

  // -------------------------------------------------------------------------
  const http = () => request(app.getHttpServer());
  const body = <T>(res: Response): Envelope<T> => {
    answered.push(res.text);
    return res.body as Envelope<T>;
  };

  function mintToken(sub: string, phone: string, email: string | null): string {
    const privateKey = readFileSync(
      join(__dirname, '../../../mock-wawu-id/private.pem'),
      'utf8',
    );
    return jwt.sign(
      {
        sub,
        email,
        phone,
        firstName: 'Ada',
        lastName: 'Opener',
        country: 'Nigeria',
        verificationTier: 'basic',
        trustScore: 0,
        status: 'active',
      },
      privateKey,
      { algorithm: 'RS256', keyid: 'mock-wawu-id-key-1', expiresIn: '15m' },
    );
  }

  function person(
    opts: { phone?: string; email?: string | null; bvn?: string } = {},
  ): Person {
    const id = randomUUID();
    users.push(id);
    const phone = opts.phone ?? `+23480${digits(8)}`;
    const email =
      opts.email === undefined ? `nuv02-${id}@example.com` : opts.email;
    const bvn = opts.bvn ?? digits(11);
    const nin = digits(11);
    const idNumber = `A${digits(8)}`;
    secrets.push(bvn, nin, idNumber);
    const b: Body = {
      bvn,
      nin,
      firstName: 'Ada',
      lastName: `Opener${randomInt(100000, 999999)}`.replace(
        /\d/g,
        (d) => 'abcdefghij'[Number(d)],
      ),
      dateOfBirth: '1991-04-12',
      address: '11 Opebi Road',
      city: 'Ikeja',
      state: 'Lagos',
      postalCode: '100001',
      gender: 'female',
      idType: 'international_passport',
      idNumber,
      idExpiryDate: '2031-01-09',
      proofOfAddressType: 'utility_bill',
    };
    return {
      id,
      auth: `Bearer ${mintToken(id, phone, email)}`,
      phone,
      email: email ?? '',
      body: b,
    };
  }

  const open = (who: Person, payload?: Record<string, unknown>) =>
    http()
      .post('/api/hub/money/wallet/open')
      .set('Authorization', who.auth)
      .send(payload ?? who.body);
  const wallet = async (who: Person) =>
    body<WalletView>(
      await http()
        .get('/api/hub/money/wallet')
        .set('Authorization', who.auth)
        .expect(200),
    ).data!;
  const row = (who: Person) =>
    prisma.fintavaWalletOpening.findUnique({ where: { wawuUserId: who.id } });
  const entityRow = (who: Person) =>
    prisma.nuvionEntity.findUnique({ where: { wawuUserId: who.id } });
  const sent = (method: string, path: string | RegExp) =>
    standin.seen.filter(
      (s) =>
        s.method === method &&
        (typeof path === 'string' ? s.path === path : path.test(s.path)),
    );
  const creates = () => sent('POST', '/individual-entities');
  const age = (who: Person, msAgo: number) =>
    prisma.fintavaWalletOpening.update({
      where: { wawuUserId: who.id },
      data: { attemptStartedAt: new Date(Date.now() - msAgo), checkedAt: null },
    });
  const sleep = (t: number) => new Promise((r) => setTimeout(r, t));
  /** One `entities.*` delivery, as the dispatcher hands it to the handler. */
  const delivery = (e: Held, event = 'entities.updated') => ({
    id: randomUUID(),
    eventId: ulid('01EVT'),
    event,
    resourceId: e.id,
    entityId: null,
    data: entityJson(e),
    receivedAt: new Date(),
    attempts: 1,
  });

  beforeAll(async () => {
    capture(process.stdout, 'write');
    capture(process.stderr, 'write');
    for (const m of ['log', 'info', 'warn', 'error', 'debug', 'trace'])
      capture(console, m);
    guard = guardOutbound();
    await standin.start();
    await wawuId.start();
    ENV.WAWU_ID_JWKS_URL = wawuId.jwksUrl;
    ENV.WAWU_ID_BASE_URL = wawuId.baseUrl;
    for (const [k, v] of Object.entries(ENV)) {
      previous[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    const provider = new NuvionWalletProvider(
      new NuvionClient(
        standin.settings({
          readTimeoutMs: TIMEOUT_MS,
          moneyTimeoutMs: TIMEOUT_MS,
          checkTimeoutMs: TIMEOUT_MS,
          resendSafetyMs: RESEND_SAFETY_MS,
        }),
        ENV.NUVION_API_KEY!,
      ),
    );
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PassportModule.register({ defaultStrategy: 'wawu-jwt' }),
        PrismaModule,
        MoneyModule,
        NotificationModule,
        NuvionWebhookModule,
      ],
      providers: [WawuJwtStrategy, WawuIdClient],
    })
      .overrideProvider(WALLET_PROVIDER)
      .useValue(provider)
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
    handler = moduleRef.get(NuvionOpeningHandler);
  });

  beforeEach(() => {
    standin.reset();
    entities = [];
    accounts = [];
    createMode = 'ok';
    createDelayMs = 0;
    listMode = 'ok';
    accountMode = 'ok';
    installNuvion();
  });

  afterAll(async () => {
    if (prisma) {
      const where = { wawuUserId: { in: users } };
      await prisma.fintavaWalletOpening.deleteMany({ where });
      await prisma.nuvionEntity.deleteMany({ where });
      await prisma.bvnCheckAttempt.deleteMany({ where });
      await prisma.notification.deleteMany({
        where: { userWawuId: { in: users } },
      });
      await prisma.nuvionWebhookEvent.deleteMany({
        where: { event: { startsWith: 'entities.' } },
      });
    }
    if (app) await app.close();
    await standin.stop();
    await wawuId.stop();
    guard.restore();
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const restore of restores.reverse()) restore();
  });

  // -------------------------------------------------------------------------
  describe('a person with BVN, NIN, date of birth, address and ID details starts opening', () => {
    it('one child entity is made with what was sent, and GET /money/wallet says the documents are still needed', async () => {
      const who = person();
      const before = await wallet(who);
      expect(before).toMatchObject({
        state: 'not_open',
        openingFlow: 'review',
        review: null,
      });

      const res = await open(who).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const view = body<WalletView>(res).data!;
      expect(view.state).toBe('not_open');
      expect(view.openingFlow).toBe('review');
      expect(view.review).toEqual({
        stage: 'needs_documents',
        reasons: [],
        canResubmit: false,
        decidedAt: null,
      });

      expect(creates()).toHaveLength(1);
      const sentBody = creates()[0].body as Record<string, unknown>;
      // A new entity: no entity_id on the create (the child's id comes back).
      expect(sentBody.entity_id).toBeUndefined();
      expect(sentBody).toEqual({
        name: `Ada ${who.body.lastName}`,
        person: {
          first_name: 'Ada',
          last_name: who.body.lastName,
          date_of_birth: '1991-04-12',
          email: who.email,
          nationality: 'NG',
          gender: 'f',
          phonenumber: who.phone,
          bvn: who.body.bvn,
          nin: who.body.nin,
        },
        address: {
          line_1: '11 Opebi Road',
          city: 'Ikeja',
          state: 'Lagos',
          postal_code: '100001',
          country_code: 'NG',
        },
        identification: {
          document: {
            type: 'international_passport',
            number: who.body.idNumber,
            expiry_date: '2031-01-09',
            issuing_country: 'NG',
          },
          proof_of_address: { type: 'utility_bill' },
        },
      });
      const held = entities[0];
      expect(await entityRow(who)).toMatchObject({
        entityId: held.id,
        personId: held.personId,
        status: 'incomplete',
        bvnStatus: 'pending',
        ninStatus: 'pending',
        documentStatus: 'pending',
        addressProofStatus: 'pending',
        accountId: null,
      });
      expect(await row(who)).toMatchObject({
        state: 'review',
        provider: 'nuvion',
        phone: who.phone,
        attempts: 1,
      });

      // Again: nothing more is sent, the same answer.
      const again = body<WalletView>(await open(who).expect(200)).data!;
      expect(again.review?.stage).toBe('needs_documents');
      expect(creates()).toHaveLength(1);
      // The money routes answer the existing no-wallet code meanwhile.
      const bal = await http()
        .get('/api/hub/money/wallet/balance')
        .set('Authorization', who.auth)
        .expect(409);
      expect(body(bal).reason?.code).toBe('wallet_not_open');
    });

    it('a national ID is sent as the NIN slip (id_subtype NIN), with a middle name and a second address line', async () => {
      const who = person();
      await open(who, {
        ...who.body,
        idType: 'national_id',
        middleName: 'Chi',
        addressLine2: 'Flat 4',
      }).expect(200);
      const b = creates()[0].body as {
        person: Record<string, unknown>;
        address: Record<string, unknown>;
        identification: { document: Record<string, unknown> };
      };
      expect(b.person.middle_name).toBe('Chi');
      expect(b.address.line_2).toBe('Flat 4');
      expect(b.identification.document).toMatchObject({
        type: 'national_id',
        type_specific: { id_subtype: 'NIN' },
      });
    });

    it.each([
      'gender',
      'city',
      'state',
      'postalCode',
      'idType',
      'idNumber',
      'proofOfAddressType',
    ])(
      'without %s: a plain 400 naming it, and nothing is sent',
      async (field) => {
        const who = person();
        const payload = { ...who.body };
        delete payload[field];
        const res = await open(who, payload).expect(400);
        expect(body(res).message).toBe(
          `${field} is required to open this wallet`,
        );
        expect(standin.seen).toEqual([]);
        expect(await row(who)).toBeNull();
      },
    );

    it('a check handle (no BVN check exists here): 400, nothing sent', async () => {
      const who = person();
      const { bvn: _b, nin: _n, ...rest } = who.body;
      void _b;
      void _n;
      const res = await open(who, { ...rest, checkHandle: 'v1.abc' }).expect(
        400,
      );
      expect(body(res).reason).toBeUndefined();
      expect(standin.seen).toEqual([]);
    });

    it('an account with no email: 422 account_not_opened; a phone that is not Nigerian: 422 phone_not_nigerian; nothing sent', async () => {
      const noMail = person({ email: null });
      expect(body(await open(noMail).expect(422)).reason?.code).toBe(
        'account_not_opened',
      );
      const foreign = person({ phone: '+447700900123' });
      expect(body(await open(foreign).expect(422)).reason?.code).toBe(
        'phone_not_nigerian',
      );
      expect(standin.seen).toEqual([]);
    });

    it('a BVN another WAWU account opened with: 409 identity_has_wallet, nothing sent', async () => {
      const first = person();
      await open(first).expect(200);
      const second = person({ bvn: first.body.bvn });
      standin.reset();
      installNuvion();
      const res = await open(second).expect(409);
      expect(body(res).reason?.code).toBe('identity_has_wallet');
      expect(standin.seen).toEqual([]);
    });

    it('Nuvion refuses the details: 422 account_not_opened, the opening failed, and the next tap tries again', async () => {
      const who = person();
      createMode = { refuse: 'error_validation_error' };
      expect(body(await open(who).expect(422)).reason?.code).toBe(
        'account_not_opened',
      );
      expect(await row(who)).toMatchObject({
        state: 'failed',
        failure: 'refused_validation',
      });
      createMode = 'ok';
      await open(who).expect(200);
      expect(creates()).toHaveLength(2);
      expect(entities).toHaveLength(1);
      expect(await row(who)).toMatchObject({ state: 'review', attempts: 2 });
    });

    it('Nuvion says the application is under compliance review: 409 identity_under_review with its reason code; nothing is sent again meanwhile', async () => {
      const who = person();
      createMode = { refuse: 'error_kyc_under_compliance_review' };
      const res = await open(who).expect(409);
      expect(body(res).reason).toEqual({
        code: 'identity_under_review',
        message:
          'Your details are being reviewed. We will let you know when the review is done.',
      });
      expect(await row(who)).toMatchObject({ state: 'unknown' });
      await open(who).expect(200);
      expect(creates()).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  describe('two taps, or a create whose answer is lost, still leave one entity (V8)', () => {
    it('ten taps at once: one create', async () => {
      const who = person();
      createMode = 'late';
      const all = await Promise.all(
        Array.from({ length: 10 }, () => open(who)),
      );
      expect(all.map((r) => r.status)).toEqual(Array(10).fill(200));
      expect(creates()).toHaveLength(1);
      expect(entities).toHaveLength(1);
    });

    it("a lost answer: opening (unknown), nothing resent; Nuvion's entities.created delivery records it for the person", async () => {
      const who = person();
      createMode = 'late';
      const view = body<WalletView>(await open(who).expect(200)).data!;
      expect(view.state).toBe('opening');
      expect(await row(who)).toMatchObject({ state: 'unknown' });
      await sleep(LATE_MS - TIMEOUT_MS + 200);
      // Before the resend window: a tap sends nothing.
      await open(who).expect(200);
      expect(creates()).toHaveLength(1);

      const made = entities[0];
      const result = await handler.handle(delivery(made, 'entities.created'));
      expect(result.outcome).toBe('done');
      // The entity was read back before anything was recorded.
      expect(sent('GET', `/entities/${made.id}`)).toHaveLength(1);
      expect(await entityRow(who)).toMatchObject({
        entityId: made.id,
        status: 'incomplete',
      });
      expect(await row(who)).toMatchObject({ state: 'review' });
      expect((await wallet(who)).review?.stage).toBe('needs_documents');
      expect(creates()).toHaveLength(1);
    });

    it('a lost answer and no delivery: past the window the next tap looks at Nuvion first, finds it, and makes none', async () => {
      const who = person();
      createMode = 'late';
      await open(who).expect(200);
      await sleep(LATE_MS - TIMEOUT_MS + 200);
      createMode = 'ok';
      await age(who, TIMEOUT_MS + RESEND_SAFETY_MS + 1_000);
      await open(who).expect(200);
      expect(creates()).toHaveLength(1);
      expect(sent('GET', '/entities')).toHaveLength(1);
      expect(sent('GET', '/entities')[0].query.name).toBe(
        `Ada ${who.body.lastName}`,
      );
      expect(await entityRow(who)).toMatchObject({ entityId: entities[0].id });
      expect(await row(who)).toMatchObject({ state: 'review', attempts: 2 });
    });

    it('the sweep settles a lost answer from the recorded entity, and never makes one itself', async () => {
      const who = person();
      createMode = 'made_then_500';
      await open(who).expect(200);
      expect(await row(who)).toMatchObject({ state: 'unknown' });
      const service = moduleRef.get(WalletOpeningService);
      await service.sweep();
      expect(await row(who)).toMatchObject({ state: 'unknown' });
      await handler.handle(delivery(entities[0], 'entities.created'));
      await prisma.fintavaWalletOpening.update({
        where: { wawuUserId: who.id },
        data: { state: 'unknown', checkedAt: null },
      });
      await service.sweep();
      expect(await row(who)).toMatchObject({ state: 'review' });
      expect(creates()).toHaveLength(1);
    });

    it("nothing was made: past the window the tap proves it on Nuvion's list and makes exactly one", async () => {
      const who = person();
      createMode = 'nothing_then_500';
      await open(who).expect(200);
      expect(entities).toHaveLength(0);
      createMode = 'ok';
      await age(who, TIMEOUT_MS + RESEND_SAFETY_MS + 1_000);
      await open(who).expect(200);
      expect(creates()).toHaveLength(2);
      expect(entities).toHaveLength(1);
      expect(await row(who)).toMatchObject({ state: 'review' });
    });

    it("Nuvion's list cannot be read (refused): nothing is made, the opening waits", async () => {
      const who = person();
      createMode = 'nothing_then_500';
      await open(who).expect(200);
      listMode = { refuse: 'error_endpoint_not_found' };
      createMode = 'ok';
      await age(who, TIMEOUT_MS + RESEND_SAFETY_MS + 1_000);
      const view = body<WalletView>(await open(who).expect(200)).data!;
      expect(view.state).toBe('opening');
      expect(creates()).toHaveLength(1);
      expect(await row(who)).toMatchObject({ state: 'unknown' });
    });

    it('an entity of someone else (another phone) is never adopted', async () => {
      const who = person();
      createMode = 'nothing_then_500';
      await open(who).expect(200);
      const stranger = makeEntity({
        name: 'Chidi Stranger',
        person: {
          phonenumber: `+23481${digits(8)}`,
          email: 'x@example.com',
          bvn: digits(11),
          nin: digits(11),
        },
        identification: { document: { number: `A${digits(8)}` } },
      });
      expect(
        (await handler.handle(delivery(stranger, 'entities.created'))).note,
      ).toBe('not an opening of ours; left alone');
      expect(await entityRow(who)).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe('an approved delivery, read back first, opens exactly one NGN checking account (V8)', () => {
    async function approved(): Promise<{ who: Person; e: Held }> {
      const who = person();
      await open(who).expect(200);
      const e = entities[entities.length - 1];
      e.status = 'approved';
      e.bvnStatus =
        e.ninStatus =
        e.documentStatus =
        e.addressProofStatus =
          'approved';
      return { who, e };
    }

    it('read back, recorded, one account; GET /money/wallet: opening, approved, the account number on its way', async () => {
      const { who, e } = await approved();
      standin.reset();
      installNuvion();
      // The delivery says "approved" too, but is never trusted alone.
      const r = await handler.handle(delivery(e));
      expect(r).toEqual({
        outcome: 'done',
        note: 'approved; naira account opened',
      });
      expect(standin.seen.map((s) => `${s.method} ${s.path}`)).toEqual([
        `GET /entities/${e.id}`,
        'GET /accounts',
        'POST /accounts',
      ]);
      expect(standin.seen[0].query).toEqual({ entity_id: e.id });
      expect(sent('POST', '/accounts')[0].body).toEqual({
        entity_id: e.id,
        type: 'checking',
        currency: 'NGN',
        display_name: 'Naira wallet',
      });
      const stored = await entityRow(who);
      expect(stored).toMatchObject({
        status: 'approved',
        accountId: accounts[0].id,
        nuvionBan: accounts[0].nuvion_ban,
        currency: 'NGN',
      });
      expect(stored?.decidedAt).toBeInstanceOf(Date);
      const view = await wallet(who);
      expect(view.state).toBe('opening');
      expect(view.review).toMatchObject({
        stage: 'approved',
        reasons: [],
        canResubmit: false,
      });
      expect(view.account).toBeNull();
      const bal = await http()
        .get('/api/hub/money/wallet/balance')
        .set('Authorization', who.auth)
        .expect(409);
      expect(body(bal).reason?.code).toBe('wallet_opening');
    });

    it('a delivery that says approved for an entity Nuvion still has pending: nothing is opened', async () => {
      const who = person();
      await open(who).expect(200);
      const e = entities[0];
      const d = delivery(e);
      (d.data as { status: string }).status = 'approved';
      await handler.handle(d);
      expect(sent('POST', '/accounts')).toHaveLength(0);
      expect((await wallet(who)).review?.stage).toBe('needs_documents');
    });

    it('replayed and delivered twice at once: one account', async () => {
      const { e } = await approved();
      await Promise.all([
        handler.handle(delivery(e)),
        handler.handle(delivery(e)),
        handler.handle(delivery(e)),
      ]);
      await handler.handle(delivery(e));
      expect(sent('POST', '/accounts')).toHaveLength(1);
      expect(accounts).toHaveLength(1);
    });

    it('a lost account request is never sent again before the window, and after it the list is read first', async () => {
      const { who, e } = await approved();
      accountMode = 'late';
      // Nuvion's list does not show the new account yet.
      let hidden = true;
      standin.on('GET', '/accounts', (req: StandinRequest) => ({
        status: 200,
        body: envelope({
          data: hidden
            ? []
            : accounts.filter((a) => a.entity_id === req.query.entity_id),
          meta: {
            pagination: {
              order: 'asc',
              has_next: false,
              limit: 100,
              has_previous: false,
              next_cursor: null,
              previous_cursor: null,
            },
          },
        }),
      }));
      expect((await handler.handle(delivery(e))).outcome).toBe('wait');
      await sleep(LATE_MS - TIMEOUT_MS + 200);
      expect((await handler.handle(delivery(e))).outcome).toBe('wait');
      expect(sent('POST', '/accounts')).toHaveLength(1);
      await prisma.nuvionEntity.update({
        where: { wawuUserId: who.id },
        data: {
          accountRequestedAt: new Date(
            Date.now() - (TIMEOUT_MS + RESEND_SAFETY_MS + 1_000),
          ),
        },
      });
      accountMode = 'ok';
      hidden = false;
      expect(await handler.handle(delivery(e))).toEqual({
        outcome: 'done',
        note: 'approved; naira account found',
      });
      expect(sent('POST', '/accounts')).toHaveLength(1);
      expect((await entityRow(who))?.accountId).toBe(accounts[0].id);
    });

    it('"account already exists" is adopted from the list, never a blind failure', async () => {
      const { who, e } = await approved();
      accounts.push({
        id: ulid('01ACC'),
        entity_id: e.id,
        type: 'checking',
        currency: 'NGN',
        nuvion_ban: '0010759003',
        created: ms(),
      });
      // The list before the request misses it (as if Nuvion were slow);
      // the request then says it exists, and the list after it shows it.
      let lists = 0;
      standin.on('GET', '/accounts', (req: StandinRequest) => {
        lists += 1;
        const rows =
          lists === 1
            ? []
            : accounts.filter((a) => a.entity_id === req.query.entity_id);
        return {
          status: 200,
          body: envelope({
            data: rows,
            meta: {
              pagination: {
                order: 'asc',
                has_next: false,
                limit: 100,
                has_previous: false,
                next_cursor: null,
                previous_cursor: null,
              },
            },
          }),
        };
      });
      accountMode = 'already_exists';
      expect(await handler.handle(delivery(e))).toEqual({
        outcome: 'done',
        note: 'approved; naira account found',
      });
      expect(sent('POST', '/accounts')).toHaveLength(1);
      expect((await entityRow(who))?.accountId).toBe(accounts[0].id);
    });

    it('a refused account request (nothing made) releases the claim and waits', async () => {
      const { who, e } = await approved();
      accountMode = { refuse: 'error_account_kyc_incomplete' };
      expect((await handler.handle(delivery(e))).outcome).toBe('wait');
      expect((await entityRow(who))?.accountRequestedAt).toBeNull();
      accountMode = 'ok';
      expect((await handler.handle(delivery(e))).note).toBe(
        'approved; naira account opened',
      );
      expect(accounts).toHaveLength(1);
    });

    it('through the dispatcher: a stored entities.updated delivery is handled and processed', async () => {
      const { who, e } = await approved();
      const payload = { event: 'entities.updated', data: entityJson(e) };
      const raw = Buffer.from(JSON.stringify(payload));
      const stored = await prisma.nuvionWebhookEvent.create({
        data: {
          eventId: ulid('01EVT'),
          event: 'entities.updated',
          resourceId: e.id,
          signedAt: new Date().toISOString(),
          bodySha256: createHash('sha256').update(raw).digest('hex'),
          rawBody: raw,
          payload,
        },
      });
      const outcome = await moduleRef
        .get(NuvionWebhookDispatcher)
        .dispatch(stored.id);
      expect(outcome).toBe('processed');
      expect((await entityRow(who))?.accountId).toBe(accounts[0].id);
    });
  });

  // -------------------------------------------------------------------------
  describe('rejected: the reason in plain words and what to fix, and the details may be sent again', () => {
    it('the BVN refused: why and what to fix; corrected details correct the same entity, BVN and NIN sent again', async () => {
      const who = person();
      await open(who).expect(200);
      const e = entities[0];
      e.status = 'rejected';
      e.bvnStatus = 'rejected';
      e.ninStatus = 'approved';
      await handler.handle(delivery(e));
      const view = await wallet(who);
      expect(view.state).toBe('not_open');
      expect(view.review).toEqual({
        stage: 'rejected',
        reasons: [
          {
            code: 'bvn_not_verified',
            message: 'We could not confirm your BVN.',
            fix: 'Check the 11 digits of your BVN and send your details again.',
          },
        ],
        canResubmit: true,
        decidedAt: expect.any(String) as string,
      });
      const bvn = digits(11);
      secrets.push(bvn);
      standin.reset();
      installNuvion();
      const after = body<WalletView>(
        await open(who, { ...who.body, bvn }).expect(200),
      ).data!;
      expect(after.review?.stage).toBe('needs_documents');
      expect(creates()).toHaveLength(0);
      const patch = sent('PATCH', `/individual-entities/${e.id}`);
      expect(patch).toHaveLength(1);
      const p = patch[0].body as {
        entity_id: string;
        person: Record<string, unknown>;
      };
      expect(p.entity_id).toBe(e.id);
      expect(p.person.bvn).toBe(bvn);
      expect(p.person.nin).toBe(who.body.nin);
      expect(await row(who)).toMatchObject({ state: 'review' });
      expect(entities).toHaveLength(1);
    });

    it('the documents refused: their reasons; a correction then sends no BVN or NIN', async () => {
      const who = person();
      await open(who).expect(200);
      const e = entities[0];
      e.status = 'rejected';
      e.documentStatus = 'rejected';
      e.addressProofStatus = 'rejected';
      await handler.handle(delivery(e));
      const codes = (await wallet(who)).review?.reasons.map((r) => r.code);
      expect(codes).toEqual([
        'id_document_not_verified',
        'proof_of_address_not_verified',
      ]);
      standin.reset();
      installNuvion();
      await open(who).expect(200);
      const p = sent('PATCH', /^\/individual-entities\//)[0].body as {
        person: Record<string, unknown>;
      };
      expect(p.person.bvn).toBeUndefined();
      expect(p.person.nin).toBeUndefined();
    });

    it('A14 only when Nuvion\'s words name the phone; a refusal naming nothing reads "details"', async () => {
      const who = person();
      await open(who).expect(200);
      const e = entities[0];
      e.status = 'rejected';
      await handler.handle(delivery(e));
      expect((await wallet(who)).review?.reasons.map((r) => r.code)).toEqual([
        'details_not_verified',
      ]);
      e.extra = {
        rejection_reason: `Phone number +23480${digits(8)} does not match the BVN record`,
      };
      await handler.handle(delivery(e));
      const reasons = (await wallet(who)).review!.reasons;
      expect(reasons.map((r) => r.code)).toEqual(['bvn_phone_mismatch']);
      expect(reasons[0].message).toBe("This isn't the number on your BVN.");
      // Nuvion's words are kept masked, and never answered.
      const stored = await entityRow(who);
      expect(stored?.rejectionReasons[0]).toMatch(/\*{6,}\d{4} does not match/);
      expect(JSON.stringify(await wallet(who))).not.toContain('does not match');
    });

    it.each(['failed', 'suspended'])(
      '%s: stopped, the existing no-wallet answer on money routes, nothing more is sent',
      async (status) => {
        const who = person();
        await open(who).expect(200);
        const e = entities[0];
        e.status = status;
        await handler.handle(delivery(e));
        const view = await wallet(who);
        expect(view.state).toBe('not_open');
        expect(view.review).toMatchObject({
          stage: 'stopped',
          canResubmit: false,
          reasons: [{ code: 'review_stopped' }],
        });
        const bal = await http()
          .get('/api/hub/money/wallet/balance')
          .set('Authorization', who.auth)
          .expect(409);
        expect(body(bal).reason?.code).toBe('wallet_not_open');
        standin.reset();
        installNuvion();
        await open(who).expect(200);
        expect(standin.seen).toEqual([]);
      },
    );
  });

  // -------------------------------------------------------------------------
  // Round 2: the verifier's defects D1 to D7, the unclear U2 and U3, and the
  // mutants that survived (V4, V14, V19).
  // -------------------------------------------------------------------------
  const HELD =
    "We can't use this BVN or phone number for a new wallet. If it's yours, contact support.";
  const newBvn = (): string => {
    const b = digits(11);
    secrets.push(b);
    return b;
  };
  type Words = Partial<
    Pick<
      Held,
      'bvnStatus' | 'ninStatus' | 'documentStatus' | 'addressProofStatus'
    >
  >;
  /** Nuvion changes the entity: its word and its own update time move. */
  const decide = (e: Held, status: string, words: Words = {}): void => {
    e.status = status;
    Object.assign(e, words);
    e.updated = Math.max(ms(), e.updated + 1);
  };
  const fresh = (): void => {
    standin.reset();
    installNuvion();
  };
  const approvedWords: Words = {
    bvnStatus: 'approved',
    ninStatus: 'approved',
    documentStatus: 'approved',
    addressProofStatus: 'approved',
  };
  /** The person opens, Nuvion rejects the entity (the BVN, or only the documents). */
  async function opened(
    x: Person,
    rejectedFor?: 'bvn' | 'documents',
  ): Promise<Held> {
    await open(x).expect(200);
    const e = entities[entities.length - 1];
    if (rejectedFor) {
      decide(
        e,
        'rejected',
        rejectedFor === 'bvn'
          ? { bvnStatus: 'rejected' }
          : { documentStatus: 'rejected' },
      );
      await handler.handle(delivery(e));
      expect((await wallet(x)).review?.stage).toBe('rejected');
    }
    return e;
  }

  describe('round 2, D1 and D4: who holds a BVN, and what Nuvion was told', () => {
    it("X types Y's BVN and Nuvion rejects X: Y's own opening is refused no longer (D1)", async () => {
      const x = person();
      const y = person({ bvn: x.body.bvn });
      await opened(x, 'bvn');
      fresh();
      const res = body<WalletView>(await open(y).expect(200));
      expect(res.data?.review?.stage).toBe('needs_documents');
      expect(creates()).toHaveLength(1);
    });

    it.each([
      ['incomplete', 'documents still needed'],
      ['pending', 'being checked'],
      ['approved', 'approved'],
    ])(
      'while the opening is %s (%s) the BVN is held: one plain answer, nothing sent',
      async (status) => {
        const x = person();
        const y = person({ bvn: x.body.bvn });
        const e = await opened(x);
        if (status !== 'incomplete') {
          decide(
            e,
            status,
            status === 'approved'
              ? approvedWords
              : { bvnStatus: 'pending', ninStatus: 'pending' },
          );
          await handler.handle(delivery(e));
        }
        fresh();
        const res = await open(y).expect(409);
        expect(body(res).reason).toEqual({
          code: 'identity_has_wallet',
          message: HELD,
        });
        expect(standin.seen).toEqual([]);
        // The held opening itself is untouched by the probe.
        expect((await wallet(x)).review?.stage).not.toBe('rejected');
      },
    );

    it('a wallet and a check in progress are refused in exactly the same words (no existence oracle)', async () => {
      const wallet1 = person();
      const e1 = await opened(wallet1);
      decide(e1, 'approved', approvedWords);
      await handler.handle(delivery(e1));
      expect(accounts).toHaveLength(1);
      const checking = person();
      await opened(checking);
      fresh();
      const a = await open(person({ bvn: wallet1.body.bvn })).expect(409);
      const b = await open(person({ bvn: checking.body.bvn })).expect(409);
      expect(body(a).reason).toEqual(body(b).reason);
      expect(body(a).message).toBe(body(b).message);
      expect(JSON.stringify(body(a))).not.toMatch(/wallet already|check/i);
    });

    it('Nuvion refusing the create releases the BVN at once', async () => {
      const x = person();
      const y = person({ bvn: x.body.bvn });
      createMode = { refuse: 'error_validation_error' };
      await open(x).expect(422);
      expect(await row(x)).toMatchObject({ state: 'failed' });
      createMode = 'ok';
      await open(y).expect(200);
      // X may try again with another BVN; the one Y holds is Y's.
      await open(x, { ...x.body, bvn: newBvn() }).expect(200);
      await open(x, { ...x.body, bvn: y.body.bvn }).expect(200);
    });

    it.each(['failed', 'suspended'])(
      'a %s opening at Nuvion releases the BVN at once',
      async (status) => {
        const x = person();
        const y = person({ bvn: x.body.bvn });
        const e = await opened(x);
        decide(e, status);
        await handler.handle(delivery(e));
        expect((await wallet(x)).review?.stage).toBe('stopped');
        fresh();
        await open(y).expect(200);
        expect(creates()).toHaveLength(1);
      },
    );

    it('a document-only rejection and a different BVN typed: Nuvion is sent no number, so the claim stays on the BVN it holds (D4)', async () => {
      const x = person();
      const b0 = x.body.bvn;
      const b1 = newBvn();
      const e = await opened(x, 'documents');
      fresh();
      await open(x, { ...x.body, bvn: b1 }).expect(200);
      const patch = sent('PATCH', `/individual-entities/${e.id}`);
      expect(patch).toHaveLength(1);
      const p = (patch[0].body as { person: Record<string, unknown> }).person;
      expect(p.bvn).toBeUndefined();
      expect(p.nin).toBeUndefined();
      expect((await wallet(x)).review?.stage).toBe('needs_documents');
      fresh();
      // The typed number was never sent, so nobody holds it for X ...
      await open(person({ bvn: b1 })).expect(200);
      // ... and the one Nuvion has is X's again, so it is held against others.
      const res = await open(person({ bvn: b0 })).expect(409);
      expect(body(res).reason?.message).toBe(HELD);
      expect(creates()).toHaveLength(1);
    });

    it('the BVN named as refused and a new one typed: the new number goes to Nuvion in that step, and the claim moves with it', async () => {
      const x = person();
      const b0 = x.body.bvn;
      const b1 = newBvn();
      const e = await opened(x, 'bvn');
      fresh();
      await open(x, { ...x.body, bvn: b1 }).expect(200);
      const p = (
        sent('PATCH', `/individual-entities/${e.id}`)[0].body as {
          person: Record<string, unknown>;
        }
      ).person;
      expect(p.bvn).toBe(b1);
      fresh();
      await open(person({ bvn: b0 })).expect(200);
      const res = await open(person({ bvn: b1 })).expect(409);
      expect(body(res).reason?.message).toBe(HELD);
    });

    it("a correction cannot take a BVN another account holds: the plain answer, nothing sent, and X's own old BVN stays released", async () => {
      const x = person();
      const held = newBvn();
      const holder = person({ bvn: held });
      await open(holder).expect(200);
      await opened(x, 'bvn');
      fresh();
      const res = await open(x, { ...x.body, bvn: held }).expect(409);
      expect(body(res).reason).toEqual({
        code: 'identity_has_wallet',
        message: HELD,
      });
      expect(standin.seen).toEqual([]);
      expect((await wallet(x)).review?.stage).toBe('rejected');
      // X's refused BVN is still free for its real owner.
      await open(person({ bvn: x.body.bvn })).expect(200);
    });

    it('a lost answer retried with another BVN, when Nuvion already has the entity: the claim stays on the BVN Nuvion was sent', async () => {
      const x = person();
      const b0 = x.body.bvn;
      const b1 = newBvn();
      createMode = 'late';
      await open(x).expect(200);
      expect(await row(x)).toMatchObject({ state: 'unknown' });
      await sleep(LATE_MS - TIMEOUT_MS + 200);
      createMode = 'ok';
      await age(x, TIMEOUT_MS + RESEND_SAFETY_MS + 1_000);
      await open(x, { ...x.body, bvn: b1 }).expect(200);
      expect(creates()).toHaveLength(1);
      expect(await row(x)).toMatchObject({ state: 'review' });
      fresh();
      expect(
        body(await open(person({ bvn: b0 })).expect(409)).reason?.code,
      ).toBe('identity_has_wallet');
      await open(person({ bvn: b1 })).expect(200);
    });

    it('a lost answer retried with another BVN, when nothing was made: the create goes out with it and the claim moves to it', async () => {
      const x = person();
      const b0 = x.body.bvn;
      const b1 = newBvn();
      createMode = 'nothing_then_500';
      await open(x).expect(200);
      createMode = 'ok';
      await age(x, TIMEOUT_MS + RESEND_SAFETY_MS + 1_000);
      await open(x, { ...x.body, bvn: b1 }).expect(200);
      expect(creates()).toHaveLength(2);
      expect(
        (creates()[1].body as { person: Record<string, unknown> }).person.bvn,
      ).toBe(b1);
      fresh();
      await open(person({ bvn: b0 })).expect(200);
      expect(
        body(await open(person({ bvn: b1 })).expect(409)).reason?.code,
      ).toBe('identity_has_wallet');
    });

    it("a lost answer retried with a BVN another account holds: nothing is made, X's old claim stands", async () => {
      const x = person();
      const b0 = x.body.bvn;
      const held = newBvn();
      await open(person({ bvn: held })).expect(200);
      createMode = 'nothing_then_500';
      await open(x).expect(200);
      createMode = 'ok';
      await age(x, TIMEOUT_MS + RESEND_SAFETY_MS + 1_000);
      fresh();
      const res = await open(x, { ...x.body, bvn: held }).expect(409);
      expect(body(res).reason?.message).toBe(HELD);
      expect(creates()).toHaveLength(0);
      expect(await row(x)).toMatchObject({ state: 'unknown' });
      expect(
        body(await open(person({ bvn: b0 })).expect(409)).reason?.code,
      ).toBe('identity_has_wallet');
    });

    it('Nuvion approves an entity whose BVN another account has taken since: no account is opened, the person is stopped', async () => {
      const x = person();
      const e = await opened(x, 'bvn');
      const y = person({ bvn: x.body.bvn });
      await open(y).expect(200);
      fresh();
      decide(e, 'approved', approvedWords);
      const r = await handler.handle(delivery(e));
      expect(r.outcome).not.toBe('done');
      expect(sent('POST', '/accounts')).toHaveLength(0);
      expect(accounts).toHaveLength(0);
      const view = await wallet(x);
      expect(view.state).toBe('not_open');
      expect(view.review).toMatchObject({
        stage: 'stopped',
        canResubmit: false,
      });
      // Y's opening is untouched.
      expect((await wallet(y)).review?.stage).toBe('needs_documents');
    });
  });

  // -------------------------------------------------------------------------
  describe('round 2, U2: at most 3 opening attempts a day that name a BVN or NIN', () => {
    const attemptsOf = (who: Person) =>
      prisma.bvnCheckAttempt.count({ where: { wawuUserId: who.id } });

    it('three tries that Nuvion refuses, then a plain 429 with when to come back, and nothing sent', async () => {
      const x = person();
      createMode = { refuse: 'error_validation_error' };
      for (let i = 0; i < 3; i += 1) await open(x).expect(422);
      expect(creates()).toHaveLength(3);
      createMode = 'ok';
      const res = await open(x).expect(429);
      expect(body(res).reason).toMatchObject({
        code: 'identity_checks_exhausted',
        retryAfterSeconds: expect.any(Number) as number,
      });
      expect(body(res).reason?.retryAfterSeconds).toBeGreaterThan(0);
      expect(creates()).toHaveLength(3);
      expect(await attemptsOf(x)).toBe(3);
    });

    it('answers that say the BVN is held count too: three, then the 429 (never a fourth answer about that BVN)', async () => {
      const holder = person();
      await open(holder).expect(200);
      const prober = person({ bvn: holder.body.bvn });
      for (let i = 0; i < 3; i += 1) {
        expect(body(await open(prober).expect(409)).reason?.message).toBe(HELD);
      }
      const res = await open(prober).expect(429);
      expect(body(res).reason?.code).toBe('identity_checks_exhausted');
      expect(await row(prober)).toBeNull();
    });

    it('a burst of probes at once learns the answer at most 3 times', async () => {
      const holder = person();
      await open(holder).expect(200);
      const prober = person({ bvn: holder.body.bvn });
      const all = await Promise.all(
        Array.from({ length: 8 }, () => open(prober)),
      );
      const held = all.filter((r) => r.status === 409).length;
      const over = all.filter((r) => r.status === 429).length;
      expect(held).toBeLessThanOrEqual(3);
      expect(held + over).toBe(8);
      expect(await attemptsOf(prober)).toBeLessThanOrEqual(3);
    });

    it('ten taps at once, and taps while it is being checked, use one try', async () => {
      const x = person();
      createMode = 'late';
      await Promise.all(Array.from({ length: 10 }, () => open(x)));
      await open(x).expect(200);
      await open(x).expect(200);
      expect(await attemptsOf(x)).toBe(1);
    });

    it('requests refused before anything is claimed (a bad body, no email) use none', async () => {
      const x = person();
      for (let i = 0; i < 5; i += 1) {
        await open(x, { ...x.body, gender: undefined }).expect(400);
      }
      const noMail = person({ email: null });
      for (let i = 0; i < 5; i += 1) await open(noMail).expect(422);
      expect(await attemptsOf(x)).toBe(0);
      expect(await attemptsOf(noMail)).toBe(0);
      await open(x).expect(200);
    });

    it('a correction is a try', async () => {
      const x = person();
      await opened(x, 'documents');
      expect(await attemptsOf(x)).toBe(1);
      await open(x).expect(200);
      expect(await attemptsOf(x)).toBe(2);
    });

    it('the tries are the setting BVN_CHECKS_PER_DAY, as the BVN check had', () => {
      const hasher = moduleRef.get(IdentityHasher);
      expect(hasher.checksPerDay).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  describe('round 2, D2: a null is a missing field', () => {
    it.each([
      'gender',
      'city',
      'state',
      'postalCode',
      'idType',
      'idNumber',
      'proofOfAddressType',
    ])(
      '%s: null is the same 400 as leaving it out, and nothing is sent',
      async (field) => {
        const who = person();
        const res = await open(who, { ...who.body, [field]: null }).expect(400);
        expect(body(res).message).toBe(
          `${field} is required to open this wallet`,
        );
        expect(standin.seen).toEqual([]);
        expect(await row(who)).toBeNull();
      },
    );

    it.each(['middleName', 'addressLine2', 'idIssueDate', 'idExpiryDate'])(
      '%s: null is the same as leaving it out (it is optional), and Nuvion gets no such field',
      async (field) => {
        const who = person();
        await open(who, { ...who.body, [field]: null }).expect(200);
        const sentBody = JSON.stringify(creates()[0].body);
        expect(sentBody).not.toContain('null');
        expect(sentBody).not.toContain('middle_name');
        expect(sentBody).not.toContain('line_2');
        expect(sentBody).not.toContain('issue_date');
        if (field === 'idExpiryDate') {
          expect(sentBody).not.toContain('expiry_date');
        }
      },
    );

    it('gender is never guessed: only male and female reach Nuvion', async () => {
      const who = person();
      await open(who, { ...who.body, gender: 'male' }).expect(200);
      expect(
        (creates()[0].body as { person: { gender: string } }).person.gender,
      ).toBe('m');
      for (const bad of [null, 'other', 7, '']) {
        const other = person();
        await open(other, { ...other.body, gender: bad }).expect(400);
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('round 2, D3: a second rejection after a correction is seen', () => {
    it('Nuvion says no again before any pending is read: the person sees the rejection and may send again', async () => {
      const x = person();
      const e = await opened(x, 'bvn');
      const first = (await wallet(x)).review!.decidedAt!;
      fresh();
      await open(x, { ...x.body, bvn: newBvn() }).expect(200);
      expect((await wallet(x)).review?.stage).toBe('needs_documents');
      await sleep(5);
      // The review ran again and refused again; the word never changed.
      decide(e, 'rejected', { bvnStatus: 'rejected' });
      await handler.handle(delivery(e));
      const view = (await wallet(x)).review!;
      expect(view.stage).toBe('rejected');
      expect(view.canResubmit).toBe(true);
      expect(Date.parse(view.decidedAt!)).toBeGreaterThan(Date.parse(first));
    });

    it("the correction's own echo (Nuvion still says rejected, nothing newer) does not bring the rejection back", async () => {
      const x = person();
      const e = await opened(x, 'bvn');
      fresh();
      await open(x, { ...x.body, bvn: newBvn() }).expect(200);
      await handler.handle(delivery(e));
      await handler.handle(delivery(e));
      expect((await wallet(x)).review?.stage).toBe('needs_documents');
    });

    it('the same decision sent again with no correction between changes nothing', async () => {
      const x = person();
      const e = await opened(x, 'bvn');
      const first = (await wallet(x)).review!;
      await sleep(5);
      await handler.handle(delivery(e));
      await handler.handle(delivery(e));
      expect((await wallet(x)).review).toEqual(first);
    });
  });

  // -------------------------------------------------------------------------
  describe('round 2, D5: numbers Nuvion echoes in groups are masked', () => {
    const GROUPED =
      'BVN 2221 0003 123 and NIN 3331-0003-123 and ID 4441.0003.12 do not match';
    const run = /\d(?:[ .-]?\d){4,}/;

    it('before they are stored', async () => {
      const x = person();
      const e = await opened(x);
      e.extra = { rejection_reason: GROUPED };
      decide(e, 'rejected');
      await handler.handle(delivery(e));
      const stored = (await entityRow(x))!.rejectionReasons.join(' | ');
      expect(stored).toContain('do not match');
      expect(stored).not.toMatch(run);
      expect(stored).toContain('3123');
    });

    it('before they are logged (the warning for a refused create)', async () => {
      const x = person();
      createMode = {
        refuse: 'error_validation_error',
        message: `${GROUPED}.`,
      };
      await open(x).expect(422);
      const logs = captured.join('\n');
      expect(logs).toContain('create individual entity');
      expect(logs).not.toMatch(/2221[ .-]0003/);
      expect(logs).not.toMatch(/3331[ .-]0003/);
      expect(logs).not.toMatch(/4441[ .-]0003/);
    });
  });

  // -------------------------------------------------------------------------
  describe('round 2, D6: the person is told once, per decision', () => {
    const notes = (who: Person) =>
      prisma.notification.findMany({
        where: { userWawuId: who.id, kind: 'identity_review' },
        orderBy: { createdAt: 'asc' },
      });
    const clean = (n: { title: string; body: string }) => {
      const text = `${n.title} ${n.body}`;
      expect(text).not.toMatch(/\d{4}/);
      expect(text).not.toMatch(/wallet|withdraw|cash ?out|payout|\u2014/i);
      for (const s of secrets) expect(text.includes(s)).toBe(false);
    };

    it('approved: one notification, however many times the decision arrives', async () => {
      const x = person();
      const e = await opened(x);
      decide(e, 'approved', approvedWords);
      await Promise.all([
        handler.handle(delivery(e)),
        handler.handle(delivery(e)),
        handler.handle(delivery(e)),
      ]);
      await handler.handle(delivery(e));
      const got = await notes(x);
      expect(got).toHaveLength(1);
      expect(got[0]).toMatchObject({
        title: 'Identity check passed',
        body: 'Your identity check passed. Your account is being set up.',
        tone: 'success',
      });
      clean(got[0]);
    });

    it('rejected: one notification that says what to fix, from our own words and never a number', async () => {
      const x = person();
      const e = await opened(x);
      e.extra = {
        rejection_reason: `The BVN ${x.body.bvn} and the NIN ${x.body.nin} were refused`,
      };
      decide(e, 'rejected', { bvnStatus: 'rejected', ninStatus: 'rejected' });
      await handler.handle(delivery(e));
      await handler.handle(delivery(e));
      const got = await notes(x);
      expect(got).toHaveLength(1);
      expect(got[0].tone).toBe('warning');
      expect(got[0].body).toContain(REVIEW_REASONS.bvn_not_verified.fix);
      expect(got[0].body).toContain(REVIEW_REASONS.nin_not_verified.fix);
      clean(got[0]);
    });

    it('a second rejection after a correction is another decision: another notification', async () => {
      const x = person();
      const e = await opened(x, 'bvn');
      expect(await notes(x)).toHaveLength(1);
      fresh();
      await open(x, { ...x.body, bvn: newBvn() }).expect(200);
      await handler.handle(delivery(e));
      expect(await notes(x)).toHaveLength(1);
      await sleep(5);
      decide(e, 'rejected', { bvnStatus: 'rejected' });
      await handler.handle(delivery(e));
      expect(await notes(x)).toHaveLength(2);
    });

    it.each(['failed', 'suspended'])(
      '%s: one notification that says to contact support',
      async (status) => {
        const x = person();
        const e = await opened(x);
        decide(e, status);
        await handler.handle(delivery(e));
        await handler.handle(delivery(e));
        const got = await notes(x);
        expect(got).toHaveLength(1);
        expect(got[0].body).toContain('Contact support');
        clean(got[0]);
      },
    );

    it('nothing is sent for a review that is still going (incomplete, pending)', async () => {
      const x = person();
      const e = await opened(x);
      await handler.handle(delivery(e, 'entities.created'));
      decide(e, 'pending');
      await handler.handle(delivery(e));
      expect(await notes(x)).toHaveLength(0);
    });

    it('a person stopped because their BVN was taken is told once too', async () => {
      const x = person();
      const e = await opened(x, 'bvn');
      await open(person({ bvn: x.body.bvn })).expect(200);
      decide(e, 'approved', approvedWords);
      await handler.handle(delivery(e));
      await handler.handle(delivery(e));
      const got = (await notes(x)).filter((n) =>
        /Contact support/.test(n.body),
      );
      expect(got).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  describe('round 2, U3: the Fintava BVN check is not used under Nuvion', () => {
    it('POST /money/identity/bvn is a permanent refusal with its own code, not "try again"', async () => {
      const who = person();
      const res = await http()
        .post('/api/hub/money/identity/bvn')
        .set('Authorization', who.auth)
        .send({ bvn: who.body.bvn, nin: who.body.nin })
        .expect(409);
      expect(body(res).reason?.code).toBe('step_not_used');
      expect(body(res).reason?.retryAfterSeconds).toBeUndefined();
      expect(standin.seen).toEqual([]);
      expect(
        await prisma.bvnCheckAttempt.count({ where: { wawuUserId: who.id } }),
      ).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('round 2, the mutants that survived', () => {
    it("V4: an entity list longer than the pages read is not 'none made': nothing is created and the opening waits", async () => {
      const x = person();
      createMode = 'nothing_then_500';
      await open(x).expect(200);
      createMode = 'ok';
      listMode = 'endless';
      await age(x, TIMEOUT_MS + RESEND_SAFETY_MS + 1_000);
      const view = body<WalletView>(await open(x).expect(200)).data!;
      expect(view.state).toBe('opening');
      expect(creates()).toHaveLength(1);
      expect(entities).toHaveLength(0);
      expect(sent('GET', '/entities')).toHaveLength(10);
      expect(await row(x)).toMatchObject({ state: 'unknown' });
    });

    it('V14: a create that names an entity the person already holds another of never overwrites it', async () => {
      const x = person();
      createDelayMs = 700;
      const pending = open(x).then((r) => r);
      for (let i = 0; i < 100 && creates().length === 0; i += 1) {
        await sleep(20);
      }
      expect(creates()).toHaveLength(1);
      const other = ulid('01ENT');
      await prisma.nuvionEntity.create({
        data: { wawuUserId: x.id, entityId: other },
      });
      expect((await pending).status).toBe(200);
      expect((await entityRow(x))?.entityId).toBe(other);
      expect(await row(x)).toMatchObject({
        state: 'conflict',
        failure: 'entity_held_by_another_account',
      });
    });

    it('V19: the seam maps the under_review kind to 409 identity_under_review for any route, with the sentence the person is promised', () => {
      for (const e of [
        walletProviderErrorToHttp('under_review'),
        new WalletProviderError({
          kind: 'under_review',
          provider: 'nuvion',
          operation: 'any money route',
        }).toHttpException(),
      ]) {
        expect(e.getStatus()).toBe(409);
        expect(e.getResponse()).toMatchObject({
          reason: {
            code: 'identity_under_review',
            message: UNDER_REVIEW_MESSAGE,
          },
        });
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('rollback safety', () => {
    it('a server that does not run Nuvion leaves an entities delivery pending (wait), asking nothing', async () => {
      // A ModuleRef whose WALLET_PROVIDER is not Nuvion's adapter.
      const fintavaRef = {
        get: () => ({ name: 'fintava' }),
      } as unknown as ModuleRef;
      const isolated = new NuvionOpeningHandler(prisma, fintavaRef);
      const e = { ...entities[0], id: ulid('01ENT') };
      const r = await isolated.handle(delivery(e));
      expect(r.outcome).toBe('wait');
      expect(standin.seen).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  describe('no BVN, NIN or ID number in the clear', () => {
    it('in no log line and no answer', () => {
      expect(secrets.length).toBeGreaterThan(40);
      const logs = captured.join('\n');
      const answers = answered.join('\n');
      for (const s of secrets) {
        expect(logs.includes(s)).toBe(false);
        expect(answers.includes(s)).toBe(false);
      }
    });

    it('in no stored column of any table', async () => {
      const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
        SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`;
      const patterns = secrets.map((s) => `%${s}%`);
      const hits: string[] = [];
      for (const { table_name } of tables) {
        const [r] = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
          `SELECT count(*) AS n FROM "${table_name}" t WHERE row_to_json(t)::text LIKE ANY($1::text[])`,
          patterns,
        );
        if (Number(r.n) > 0) hits.push(table_name);
      }
      expect(hits).toEqual([]);
    });

    it('nothing left this machine', () => {
      expect(guard.violations).toEqual([]);
    });
  });
});
