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
import type { WalletView } from '../../money/money-view.type';
import { WalletOpeningService } from '../../money/opening/wallet-opening.service';
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
    'ok' | 'late' | 'made_then_500' | 'nothing_then_500' | { refuse: string } =
    'ok';
  let listMode: 'ok' | { refuse: string } = 'ok';
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
    updated: ms(),
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
        return { status: 422, body: errorBody(mode.refuse, 'Refused.') };
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
      };
    });
    standin.on('PATCH', /^\/individual-entities\/[^/]+$/, (req) => {
      const e = entities.find((x) => x.id === req.path.split('/')[2]);
      if (!e)
        return { status: 404, body: errorBody('error_resource_not_found') };
      const person = (req.body as { person?: Record<string, string> }).person;
      if (person?.bvn) e.bvnLast4 = person.bvn.slice(-4);
      if (person?.nin) e.ninLast4 = person.nin.slice(-4);
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
    listMode = 'ok';
    accountMode = 'ok';
    installNuvion();
  });

  afterAll(async () => {
    if (prisma) {
      const where = { wawuUserId: { in: users } };
      await prisma.fintavaWalletOpening.deleteMany({ where });
      await prisma.nuvionEntity.deleteMany({ where });
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
  describe('rollback safety', () => {
    it('a server that does not run Nuvion leaves an entities delivery pending (wait), asking nothing', async () => {
      // A ModuleRef whose WALLET_PROVIDER is not Nuvion's adapter.
      const fintavaRef = {
        get: () => ({ name: 'fintava' }),
      } as unknown as ModuleRef;
      const isolated = new NuvionOpeningHandler(prisma, fintavaRef);
      const e = { ...entities[0], id: ulid('01ENT') } as Held;
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
