import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { PassportModule } from '@nestjs/passport';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { NuvionAccountsStandin } from '../../../../test/nuvion/accounts-standin';
import { NuvionAddMoneyStandin } from '../../../../test/nuvion/add-money-standin';
import { NuvionBookStandin } from '../../../../test/nuvion/book-standin';
import { NuvionStandin } from '../../../../test/nuvion/nuvion-standin';
import {
  guardOutbound,
  type OutboundGuard,
} from '../../../../test/nuvion/outbound-guard';
import { WawuIdDouble } from '../../../../test/nuvion/wawu-id-double';
import {
  mintToken,
  PIN,
  QuietLogger,
} from '../../../../test/transfers/harness';
import { AdminRole } from '../../../../generated/prisma/enums';
import { AccountPurgeService } from '../../../account-purge/account-purge.service';
import { AdminTokenService } from '../../../admin/auth/admin-token.service';
import { WawuIdClient } from '../../../common/auth/wawu-id.client';
import { WawuJwtStrategy } from '../../../common/auth/wawu-jwt.strategy';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { PlanSettingsService } from '../../../plan-settings/plan-settings.service';
import { HUB_APP_OPTIONS } from '../../../hub-app-options';
import { nuvionWalletId } from '../../../nuvion/areas/accounts';
import { NuvionBookArea } from '../../../nuvion/areas/book';
import { PrismaNuvionBookStore } from '../../../nuvion/areas/book-store';
import { NuvionAccountsHandler } from '../../../nuvion/handlers/accounts.handler';
import { NuvionAddMoneyHandler } from '../../../nuvion/handlers/add-money.handler';
import { NuvionClient } from '../../../nuvion/nuvion-client';
import { signNuvionDelivery } from '../../../nuvion/webhook/nuvion-signature';
import { NuvionWebhookDispatcher } from '../../../nuvion/webhook/nuvion-webhook-dispatcher.service';
import { NuvionWebhookModule } from '../../../nuvion/webhook/nuvion-webhook.module';
import {
  NuvionWalletProvider,
  nuvionAreas,
} from '../../../nuvion/nuvion-wallet-provider';
import { WALLET_PROVIDER } from '../../../wallet-provider/wallet-provider.interface';
import { MoneyModule } from '../../money.module';
import {
  ADD_MONEY_CARD_SETTING,
  ADD_MONEY_USSD_SETTING,
  AddMoneyService,
  REFUSAL_MEMORY_MS,
  ussdNumber,
} from '../add-money.service';
import type { AddMoneyView, AdminAddMoneyView } from '../add-money-view.type';

/**
 * Adding money by card, Apple Pay, USSD and the bank checkout (WALLET-25,
 * WALLET-26; R-84, R-10, R-42). The REAL Nuvion adapter and add-money area over
 * Nuvion's stand-in (a socket, `test/nuvion/add-money-standin.ts`, shaped by
 * the docs and by the dev answers in DEV-RESULTS); nothing here reaches a
 * Nuvion, Fintava or wawuafrica.com host.
 */

const BASE = '/api/hub/money/add-money';
const ADMIN = '/api/hub/admin/money/add-money';
const CARD_FEE = 75;
const WAWU_FEE = 50;
const AMOUNT = 1_000_000;
const CHARGE = AMOUNT + CARD_FEE + WAWU_FEE;
const START = 5_000_000;
const { publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

jest.setTimeout(120_000);

let numberSeq = 0;
const nuban = () =>
  `7${String(Date.now()).slice(-6)}${String((numberSeq += 1)).padStart(3, '0')}`;

// What a 2048-bit key makes of a card: 256 bytes (the Hub checks the length against the key it gave the phone).
const ENCRYPTED = Buffer.alloc(256, 7).toString('base64');
const HOOK = '/api/hub/webhooks/nuvion';
const SECRET = 'whsec_wallet25_fix1_0123456789abcdef';
const cardBody = (over: Record<string, unknown> = {}) => ({
  rail: 'card',
  amountKobo: AMOUNT,
  chargeKobo: CHARGE,
  card: {
    encrypted: ENCRYPTED,
    billing: { line1: '1 Test Street', city: 'Lagos', state: 'Lagos' },
  },
  ...over,
});

describe('Add money by card, Apple Pay, USSD and the bank checkout (WALLET-25, WALLET-26)', () => {
  const standin = new NuvionStandin();
  const wawuId = new WawuIdDouble();
  const accounts = new NuvionAccountsStandin(standin);
  const book = new NuvionBookStandin(standin, accounts);
  const nuv = new NuvionAddMoneyStandin(standin, accounts);
  const logger = new QuietLogger();
  let guard: OutboundGuard;
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let moduleRef: TestingModule;
  let service: AddMoneyService;
  let dispatcher: NuvionWebhookDispatcher;
  let fintavaCounter: Server;
  const users: string[] = [];
  const adminIds: string[] = [];
  const admin: Partial<Record<AdminRole, string>> = {};
  const previous: Record<string, string | undefined> = {};

  interface Person {
    id: string;
    auth: string;
    entityId: string;
    accountId: string;
    accountNumber: string;
  }

  async function person(): Promise<Person> {
    const id = randomUUID();
    users.push(id);
    const accountNumber = nuban();
    const account = book.openPerson(START, accountNumber);
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId: id,
        customerId: account.entity_id,
        walletId: nuvionWalletId(account.entity_id, account.id),
        accountNumber,
        accountName: `Add Money ${accountNumber}`,
        provider: 'nuvion',
      },
    });
    await prisma.nuvionEntity.create({
      data: {
        wawuUserId: id,
        entityId: account.entity_id,
        accountId: account.id,
        nuvionBan: account.nuvion_ban,
        accountNumber,
        status: 'approved',
        currency: 'NGN',
      },
    });
    await prisma.userProfile.create({
      data: {
        wawuUserId: id,
        accountType: 'user',
        handle: `am-${id.slice(0, 8)}`,
      },
    });
    const auth = `Bearer ${mintToken(id)}`;
    const set = await request(app.getHttpServer())
      .post('/api/hub/money/pin')
      .set('Authorization', auth)
      .send({ pin: PIN, pinConfirmation: PIN });
    expect(set.status).toBe(201);
    return {
      id,
      auth,
      entityId: account.entity_id,
      accountId: account.id,
      accountNumber,
    };
  }

  let evt = 0;
  /** Posts a signed delivery to the real receiver, as Nuvion's server would; answers its row. */
  async function post(event: string, payload: unknown) {
    evt += 1;
    const id = `w25-fix1-${Date.now().toString(36)}-${evt}`;
    const ts = new Date().toISOString();
    const raw = JSON.stringify({ event, data: payload });
    await request(app.getHttpServer())
      .post(HOOK)
      .set('Content-Type', 'application/json')
      .set('x-nuvion-event-id', id)
      .set('x-nuvion-event-timestamp', ts)
      .set(
        'x-nuvion-event-signature',
        signNuvionDelivery(SECRET, ts, Buffer.from(raw)),
      )
      .send(raw)
      .expect(200);
    return prisma.nuvionWebhookEvent.findUniqueOrThrow({
      where: { eventId: id },
    });
  }
  const stored = (id: string) =>
    prisma.nuvionWebhookEvent.findUniqueOrThrow({ where: { id } });
  /** The dispatcher's own sweep (every 30 seconds in the app): it takes every delivery that is due. */
  const sweepNow = () => dispatcher.sweep();

  const start = (p: Person, payload: object, key: string = randomUUID()) =>
    request(app.getHttpServer())
      .post(BASE)
      .set('Authorization', p.auth)
      .set('Idempotency-Key', key)
      .set('X-Transaction-Pin', PIN)
      .send(payload);
  const get = (p: Person, path: string) =>
    request(app.getHttpServer())
      .get(`${BASE}${path}`)
      .set('Authorization', p.auth);
  const adminReq = (role: AdminRole) => ({
    get: (path: string) =>
      request(app.getHttpServer())
        .get(`${ADMIN}${path}`)
        .set('Authorization', `Bearer ${admin[role]}`),
    post: (path: string, body: object = {}) =>
      request(app.getHttpServer())
        .post(`${ADMIN}${path}`)
        .set('Authorization', `Bearer ${admin[role]}`)
        .send(body),
  });
  interface Rail {
    rail: string;
    available: boolean;
    reason: string | null;
    hosted: boolean;
  }
  interface Options {
    rails: Rail[];
    cardPublicKey: string | null;
    limits: Record<string, number | null>;
  }
  interface Refusal {
    reason: { code: string; message: string };
  }
  const refusal = (res: request.Response) => (res.body as Refusal).reason;
  const data = <T>(res: request.Response) => (res.body as { data: T }).data;
  const view = (res: request.Response) =>
    (res.body as { data: AddMoneyView }).data;
  const row = (id: string) =>
    prisma.addMoneySession.findUniqueOrThrow({ where: { id } });
  const available = (p: Person) => book.availableOf(p.accountId);

  /** One `inflows.completed` delivery for the person's inflow, through NUV-04's handler (which calls the add-money hook). */
  const deliver = (
    p: Person,
    inflow: Record<string, unknown>,
    event = 'inflows.completed',
  ) =>
    new NuvionAccountsHandler(prisma, moduleRef.get(ModuleRef)).handle({
      id: randomUUID(),
      eventId: randomUUID(),
      event,
      resourceId: inflow.id as string,
      entityId: p.entityId,
      data: inflow,
      receivedAt: new Date(),
      attempts: 1,
    });
  const ledgerRows = (reference: string) =>
    prisma.fintavaLedgerEntry.findMany({
      where: { customerReference: reference, direction: 'in' },
    });

  beforeAll(async () => {
    guard = guardOutbound();
    fintavaCounter = createServer((_req, res) => {
      res.statusCode = 503;
      res.end('{}');
    });
    await new Promise<void>((r) =>
      fintavaCounter.listen(0, '127.0.0.1', () => r()),
    );
    const port = (fintavaCounter.address() as AddressInfo).port;
    await standin.start();
    await wawuId.start();
    accounts.install();
    book.install();
    nuv.install();
    book.fundOperational(50_000_000);
    book.feeKobo = () => 0;
    const env: Record<string, string> = {
      FINTAVA_BASE_URL: `http://127.0.0.1:${port}`,
      FINTAVA_API_KEY: 'live_test_wallet25_adapter_0123456789FAKEKEY',
      FEE_QUOTE_KEY: 'wallet25-fee-quote-key-0123456789abcdef01',
      NUVION_FEE_BOOK_TRANSFER: '0',
      NUVION_FEE_BANK_PAYOUT: '0',
      NUVION_FEE_INFLOW: '0',
      ADD_MONEY_FEE_CARD: String(CARD_FEE),
      ADD_MONEY_FEE_USSD: '0',
      ADD_MONEY_WAWU_FEE: String(WAWU_FEE),
      ADD_MONEY_MIN_KOBO: '10000',
      ADD_MONEY_MAX_KOBO: '20000000',
      ADD_MONEY_DAILY_MAX_KOBO: '1500000',
      NUVION_WEBHOOK_SECRET: SECRET,
      NUVION_ENCRYPTION_PUBLIC_KEY: publicKey.replace(/\n/g, '\\n'),
      ADD_MONEY_RETURN_URL:
        'https://hub.test.example/api/hub/money/add-money/return',
      ADD_MONEY_USSD_CHANNEL: 'NG-MTN-C2B',
      ADMIN_JWT_SECRET: 'wallet25-admin-access-secret-0123456789abcdef',
      ADMIN_JWT_REFRESH_SECRET:
        'wallet25-admin-refresh-secret-0123456789abcdef',
      WAWU_ID_JWKS_URL: wawuId.jwksUrl,
      WAWU_ID_BASE_URL: wawuId.baseUrl,
      PIN_LOCK_MINUTES: '',
      IDEMPOTENCY_KEY_HOURS: '',
      PAYMENT_REVIEW_AFTER_HOURS: '',
    };
    for (const [k, v] of Object.entries(env)) {
      previous[k] = process.env[k];
      process.env[k] = v;
    }
    const client = new NuvionClient(
      standin.settings({
        operationalAccountId: book.operational.id,
        moneyTimeoutMs: 2_000,
        readTimeoutMs: 2_000,
      }),
      'nv_test_sk_Wallet25adapterKEY00000000000000',
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
      .useFactory({
        inject: [PrismaService],
        factory: (db: PrismaService) =>
          new NuvionWalletProvider(client, {
            ...nuvionAreas(client),
            book: new NuvionBookArea(
              client,
              client.settings,
              new PrismaNuvionBookStore(db),
              {
                settleStepsMs: [],
              },
            ),
          }),
      })
      .setLogger(logger)
      .compile();
    app = moduleRef.createNestApplication({ ...HUB_APP_OPTIONS, logger });
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
    // NUVION-FIX 1.1: the two switches read 0 by default (naira cannot be added by card or USSD at Nuvion), so this suite, which
    // exercises the rails against the stand-in, switches them on the way an admin would.
    for (const key of [ADD_MONEY_CARD_SETTING, ADD_MONEY_USSD_SETTING]) {
      await prisma.planSetting.upsert({
        where: { key },
        create: { key, value: 1 },
        update: { value: 1 },
      });
    }
    await moduleRef.get(PlanSettingsService, { strict: false }).refresh();
    service = moduleRef.get(AddMoneyService);
    dispatcher = moduleRef.get(NuvionWebhookDispatcher);
    const issuer = moduleRef.get(AdminTokenService);
    for (const role of [
      AdminRole.superadmin,
      AdminRole.finance,
      AdminRole.support,
    ]) {
      const id = randomUUID();
      adminIds.push(id);
      const a = await prisma.adminUser.create({
        data: {
          id,
          email: `w25-${role}-${id}@admin.test.wawu.dev`,
          passwordHash: 'x',
          name: `W25 ${role}`,
          role,
        },
      });
      admin[role] = issuer.issuePair(a).accessToken;
    }
  });

  afterAll(async () => {
    if (prisma) {
      const sessions = await prisma.addMoneySession.findMany({
        where: { wawuUserId: { in: users } },
        select: { id: true, reference: true },
      });
      const refs = sessions.flatMap((s) => [
        s.reference,
        `${s.reference}-wawufee`,
      ]);
      const kept = await prisma.addMoneySession.findMany({
        where: { reference: { startsWith: 'wawu-add-purge-' } },
        select: { id: true },
      });
      await prisma.addMoneyAudit.deleteMany({
        where: { sessionId: { in: kept.map((k) => k.id) } },
      });
      await prisma.addMoneySession.deleteMany({
        where: { id: { in: kept.map((k) => k.id) } },
      });
      await prisma.addMoneyAudit.deleteMany({
        where: { sessionId: { in: sessions.map((s) => s.id) } },
      });
      await prisma.fintavaLedgerEntry.deleteMany({
        where: {
          OR: [
            { customerReference: { in: refs } },
            { wawuUserId: { in: users } },
          ],
        },
      });
      await prisma.addMoneySession.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.nuvionBookTransfer.deleteMany({
        where: { reference: { in: refs } },
      });
      await prisma.moneyIdempotencyKey.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.transactionPin.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.userProfile.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.nuvionEntity.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.fintavaWallet.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.adminUser.deleteMany({ where: { id: { in: adminIds } } });
    }
    if (prisma) {
      await prisma.planSetting.deleteMany({
        where: {
          key: { in: [ADD_MONEY_CARD_SETTING, ADD_MONEY_USSD_SETTING] },
        },
      });
    }
    if (app) await app.close();
    await standin.stop();
    await wawuId.stop();
    await new Promise<void>((r) => fintavaCounter.close(() => r()));
    guard.restore();
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  afterEach(() => {
    if (process.env.W25_DEBUG)
      console.log(logger.lines.slice(-6).join('\n').slice(0, 1500));
  });

  beforeEach(() => {
    // What a refusal taught the service lives for 15 minutes: each test starts without it.
    (service as unknown as { refused: Map<string, unknown> }).refused.clear();
    nuv.cardMode = 'frictionless';
    nuv.refuseNaira = false;
    nuv.suspended = false;
    nuv.cardFee = CARD_FEE;
    book.mode = 'successful';
  });

  it('lists the ways, says why one cannot be used, and gives the phone the public key only for a card that can be taken', async () => {
    const me = await person();
    const res = await get(me, '/options').expect(200);
    const o = data<Options>(res);
    const by = (r: string) => o.rails.find((x) => x.rail === r)!;
    expect(by('card')).toMatchObject({
      available: true,
      reason: null,
      hosted: false,
    });
    expect(by('apple_pay')).toMatchObject({ available: true, hosted: true });
    expect(by('ussd')).toMatchObject({ available: true });
    // NUVION-FIX 1.3: Nuvion takes no naira by open banking, so the bank checkout is never offered, and the reason is plain.
    expect(by('open_banking')).toMatchObject({
      available: false,
      hosted: true,
    });
    expect(by('open_banking').reason).toBe('This is not available.');
    expect(o.cardPublicKey).toContain('BEGIN PUBLIC KEY');
    expect(o.limits).toEqual({
      minKobo: 10000,
      maxKobo: 20000000,
      dailyMaxKobo: 1_500_000,
    });
    expect(JSON.stringify(o)).not.toMatch(/—/);
  });

  it("quotes the amount plus Nuvion's charge plus WAWU's (R-10), both from config", async () => {
    const me = await person();
    const q = await get(me, `/quote?rail=card&amountKobo=${AMOUNT}`).expect(
      200,
    );
    expect(data<object>(q)).toMatchObject({
      rail: 'card',
      amountKobo: AMOUNT,
      providerFeeKobo: CARD_FEE,
      wawuFeeKobo: WAWU_FEE,
      feeKobo: CARD_FEE + WAWU_FEE,
      chargeKobo: CHARGE,
    });
    const off = await get(
      me,
      `/quote?rail=open_banking&amountKobo=${AMOUNT}`,
    ).expect(409);
    expect(refusal(off).code).toBe('add_money_unavailable');
  });

  it('a card that goes through is paid once, is NOT credited by the charge, and is credited exactly once by the settled inflow (webhook twice, sweep)', async () => {
    const me = await person();
    const before = available(me);
    const res = await start(me, cardBody()).expect(201);
    const v = view(res);
    expect(v).toMatchObject({
      rail: 'card',
      status: 'processing',
      amountKobo: AMOUNT,
      chargeKobo: CHARGE,
      cardLast4: '1111',
    });
    expect(v.message).toMatch(/Paid/);
    // Nuvion was asked for the whole charge, on the person's own account, under our reference.
    const intent = [...nuv.intents.values()].find(
      (i) => i.amount === CHARGE && i.account_id === me.accountId,
    );
    expect(intent).toMatchObject({
      amount: CHARGE,
      currency: 'NGN',
      account_id: me.accountId,
      status: 'completed',
    });
    // The card reached Nuvion encrypted, and the Hub keeps none of it.
    const stored = JSON.stringify(await row(v.id), (_k, x: unknown) =>
      typeof x === 'bigint' ? x.toString() : x,
    );
    expect(stored).not.toContain(ENCRYPTED);
    expect(stored).not.toMatch(/4111/);
    // Nothing is credited by the charge itself.
    const s = await row(v.id);
    expect(await ledgerRows(s.reference)).toHaveLength(0);
    expect(s.status).toBe('processing');

    // The card inflow is pending at Nuvion until it settles: the handler waits.
    const pending = nuv.inflowFor(s.reference, 'pending');
    expect((await deliver(me, pending)).outcome).toBe('wait');
    expect(await ledgerRows(s.reference)).toHaveLength(0);

    // Settled: credited once. A second delivery and a sweep replay land on the same row.
    const settled = nuv.inflowFor(s.reference, 'successful');
    expect(available(me)).toBe(before + CHARGE - CARD_FEE);
    const first = await deliver(me, settled);
    expect(first).toMatchObject({ outcome: 'done' });
    expect(first.note).toMatch(/credited once/);
    await deliver(me, settled);
    await deliver(me, settled, 'inflows.completed');
    const rows = await ledgerRows(s.reference);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].amountKobo)).toBe(CHARGE - CARD_FEE);
    expect(Number(rows[0].totalKobo)).toBe(CHARGE);
    expect(rows[0].category).toBe('top_up');
    const done = await row(v.id);
    expect(done.status).toBe('settled');
    expect(done.ledgerEntryId).toBe(rows[0].id);
    // WAWU's fee moved from the wallet to WAWU, once, under its own reference.
    if (!done.feeCollectedAt) {
      await service.collectWawuFee(v.id);
    }
    expect((await row(v.id)).feeCollectedAt).not.toBeNull();
    expect(book.byReference(`${s.reference}-wawufee`)).toHaveLength(1);
    expect(available(me)).toBe(before + CHARGE - CARD_FEE - WAWU_FEE);
    const after = await get(me, `/${v.id}`).expect(200);
    expect(view(after)).toMatchObject({
      status: 'settled',
      message: 'The money is in your wallet.',
    });
  });

  it('the same Idempotency-Key answers the first result again and charges once; another body under it is refused', async () => {
    const me = await person();
    const key = randomUUID();
    const a = await start(me, cardBody(), key).expect(201);
    const intentsBefore = nuv.intents.size;
    const b = await start(me, cardBody(), key).expect(201);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(view(b).id).toBe(view(a).id);
    expect(nuv.intents.size).toBe(intentsBefore);
    const c = await start(me, cardBody({ amountKobo: AMOUNT + 100 }), key);
    expect(c.status).toBe(409);
    expect(refusal(c).code).toBe('idempotency_key_reused');
  });

  it('refuses before the PIN and changes nothing: a changed total, below the minimum, above the maximum', async () => {
    const me = await person();
    const wrongPin = (payload: object) =>
      request(app.getHttpServer())
        .post(BASE)
        .set('Authorization', me.auth)
        .set('Idempotency-Key', randomUUID())
        .set('X-Transaction-Pin', '0000')
        .send(payload);
    const changed = await wrongPin(cardBody({ chargeKobo: CHARGE + 1 }));
    expect(changed.status).toBe(409);
    expect(refusal(changed).code).toBe('quote_changed');
    const low = await wrongPin(
      cardBody({ amountKobo: 5000, chargeKobo: 5125 }),
    );
    expect(low.status).toBe(422);
    expect(refusal(low).code).toBe('below_minimum');
    const high = await wrongPin(
      cardBody({ amountKobo: 30_000_000, chargeKobo: 30_000_125 }),
    );
    expect(high.status).toBe(403);
    expect(refusal(high).code).toBe('limit_reached');
    expect(
      await prisma.addMoneySession.count({ where: { wawuUserId: me.id } }),
    ).toBe(0);
    // None of those used a PIN try: the right PIN still works.
    await start(me, cardBody()).expect(201);
  });

  it('3-D Secure and Apple Pay are hosted pages: awaiting_user with a checkout address; a decline at the bank ends it with plain words and no credit', async () => {
    const me = await person();
    nuv.cardMode = 'threeds';
    const res = await start(me, cardBody()).expect(201);
    const v = view(res);
    expect(v.status).toBe('awaiting_user');
    expect(v.checkoutUrl).toMatch(/^https:\/\/app\.nuvion\.test\/sessions\//);
    const s = await row(v.id);
    // Nuvion says the payment failed (webhook), the Hub asks Nuvion, and the attempt ends.
    const intent = nuv.intents.get(s.providerRef!)!;
    intent.status = 'failed';
    Object.assign(intent.intent_action!, { status: 'failed' });
    Object.assign(intent.intent_action!, {
      status_reason: 'User cancelled payment session',
    });
    const handler = new NuvionAddMoneyHandler(moduleRef.get(ModuleRef));
    const out = await handler.handle({
      id: randomUUID(),
      eventId: randomUUID(),
      event: 'payment_intent.failed',
      resourceId: intent.id,
      entityId: me.entityId,
      data: { id: intent.id, reference: s.reference, status: 'failed' },
      receivedAt: new Date(),
      attempts: 1,
    });
    expect(out.outcome).toBe('done');
    const ended = await row(v.id);
    expect(ended.status).toBe('failed');
    expect(view(await get(me, `/${v.id}`).expect(200)).failureMessage).toMatch(
      /Nothing was added to your wallet\./,
    );
    expect(await ledgerRows(s.reference)).toHaveLength(0);

    const pay = await start(me, {
      rail: 'apple_pay',
      amountKobo: AMOUNT,
      chargeKobo: CHARGE,
    }).expect(201);
    expect(view(pay)).toMatchObject({
      rail: 'apple_pay',
      status: 'awaiting_user',
    });
    expect(view(pay).checkoutUrl).toMatch(/^https:/);
  });

  it('a declined card and a card Nuvion cannot read each end with their own plain words, nothing charged, no open intent left', async () => {
    const me = await person();
    nuv.cardMode = 'decline';
    const declined = view(await start(me, cardBody()).expect(201));
    expect(declined.status).toBe('failed');
    expect(declined.failureMessage).toMatch(/did not go through/);
    nuv.cardMode = 'bad_card';
    const bad = view(await start(me, cardBody()).expect(201));
    expect(bad).toMatchObject({ status: 'failed' });
    expect(bad.failureMessage).toMatch(/Check the details/);
    const open = [...nuv.intents.values()].filter(
      (i) => i.status === 'requires_action',
    );
    expect(open).toHaveLength(0);
  });

  it('where Nuvion has not switched naira on (dev today) the attempt says so plainly, the way is shown as not available, and it is tried again later', async () => {
    const me = await person();
    nuv.refuseNaira = true;
    const card = view(await start(me, cardBody()).expect(201));
    expect(card).toMatchObject({ status: 'failed' });
    // NUVION-FIX 1.4: no promise that it will appear.
    expect(card.failureMessage).toBe('This is not available.');
    const ussd = view(
      await start(me, {
        rail: 'ussd',
        amountKobo: AMOUNT,
        chargeKobo: AMOUNT + WAWU_FEE,
      }).expect(201),
    );
    expect(ussd.status).toBe('failed');
    expect(ussd.failureMessage).toBe(
      'This is not available right now. Nothing was charged. Try again later.',
    );
    const o = { data: data<Options>(await get(me, '/options').expect(200)) };
    const by = (r: string) => o.data.rails.find((x) => x.rail === r)!;
    expect(by('card')).toMatchObject({
      available: false,
      reason: card.failureMessage,
    });
    expect(by('ussd')).toMatchObject({ available: false });
    // Told so up front: the next try is refused before anything is sent.
    const again = await get(me, `/quote?rail=card&amountKobo=${AMOUNT}`).expect(
      409,
    );
    expect(refusal(again).code).toBe('add_money_unavailable');
    // After the memory has run out it is asked again.
    jest.useFakeTimers({
      now: Date.now() + REFUSAL_MEMORY_MS + 1000,
      doNotFake: [
        'setTimeout',
        'setInterval',
        'setImmediate',
        'nextTick',
        'queueMicrotask',
      ],
    });
    try {
      expect(service.railProblem('card')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
    nuv.refuseNaira = false;
    expect(
      service.options(Date.now() + REFUSAL_MEMORY_MS + 1000).rails[0].available,
    ).toBe(true);
  });

  it('NUVION-FIX 1.2: where Nuvion says an acquiring route is suspended the attempt says so, the rail is hidden and remembered as refused', async () => {
    const me = await person();
    nuv.suspended = true;
    const card = view(await start(me, cardBody()).expect(201));
    expect(card).toMatchObject({
      status: 'failed',
      failureMessage: 'This is not available.',
    });
    expect(await row(card.id)).toMatchObject({ failureCode: 'not_supported' });
    // Not an outage: no "could not reach", and nothing was left open at Nuvion.
    expect(JSON.stringify(card)).not.toMatch(/could not reach/);
    expect(
      [...nuv.intents.values()].filter((i) => i.status === 'requires_action'),
    ).toHaveLength(0);
    const o = data<Options>(await get(me, '/options').expect(200));
    const by = (r: string) => o.rails.find((x) => x.rail === r)!;
    for (const rail of ['card', 'apple_pay']) {
      expect(by(rail)).toMatchObject({
        available: false,
        reason: 'This is not available.',
      });
    }
    expect(o.cardPublicKey).toBeNull();
    const again = await get(me, `/quote?rail=card&amountKobo=${AMOUNT}`).expect(
      409,
    );
    expect(refusal(again)).toMatchObject({
      code: 'add_money_unavailable',
      message: 'This is not available.',
    });
    // The USSD prompt is refused the same way (Nuvion words it as a refusal of the service).
    const ussd = view(
      await start(me, {
        rail: 'ussd',
        amountKobo: AMOUNT,
        chargeKobo: AMOUNT + WAWU_FEE,
      }).expect(201),
    );
    expect(ussd).toMatchObject({
      status: 'failed',
      failureMessage: 'This is not available.',
    });
    expect(
      data<Options>(await get(me, '/options').expect(200)).rails.find(
        (x) => x.rail === 'ussd',
      ),
    ).toMatchObject({ available: false, reason: 'This is not available.' });
  });

  it('NUVION-FIX 5.1: a paid card waits 8 days for its inflow before a person is asked to look (card settlements take 6 days), and says so', async () => {
    const me = await person();
    const v = view(await start(me, cardBody()).expect(201));
    expect(v.status).toBe('processing');
    expect(v.message).toContain(
      'Card payments reach your wallet in about 6 days.',
    );
    const day = 24 * 60 * 60_000;
    await service.sweep(new Date(Date.now() + 4 * day));
    await service.sweep(new Date(Date.now() + 7 * day));
    expect((await row(v.id)).reviewNote).toBeNull();
    await service.sweep(new Date(Date.now() + 9 * day));
    expect((await row(v.id)).reviewNote).toBe(
      'paid at Nuvion, no inflow after 8 days',
    );
  });

  it('USSD asks Nuvion for a mobile money prompt on the phone and the person answers it; a failed prompt ends with plain words', async () => {
    const me = await person();
    // Nuvion lists only Tanzanian and Kenyan mobile money channels and takes no naira by it; the channel is a setting that must
    // start NG- (NUVION-FIX 1.3), and the phone is the person's own.
    const res = await start(me, {
      rail: 'ussd',
      amountKobo: AMOUNT,
      chargeKobo: AMOUNT + WAWU_FEE,
      ussd: { msisdn: '08012345678' },
    }).expect(201);
    const v = view(res);
    expect(v.status).toBe('awaiting_user');
    expect(v.message).toMatch(/Check your phone/);
    const s = await row(v.id);
    const session = nuv.sessions.get(s.providerRef!)!;
    expect(session.meta).toEqual({
      msisdn: '2348012345678',
      channel: 'NG-MTN-C2B',
    });
    expect(session.funding_type).toBe('momo');
    nuv.setSessionStatus(s.reference, 'failed', 'payment_failed');
    const handler = new NuvionAddMoneyHandler(moduleRef.get(ModuleRef));
    await handler.handle({
      id: randomUUID(),
      eventId: randomUUID(),
      event: 'funding_sessions.updated',
      resourceId: session.id,
      entityId: me.entityId,
      data: { id: session.id, unique_reference: s.reference, status: 'failed' },
      receivedAt: new Date(),
      attempts: 1,
    });
    expect((await row(v.id)).status).toBe('failed');
    expect(ussdNumber('+234 801 234 5678')).toBe('2348012345678');
    expect(ussdNumber('12')).toBeNull();
  });

  it('a payment that is not one of ours is left to the recorder; a wrong amount or a missing session is never credited', async () => {
    const me = await person();
    const v = view(await start(me, cardBody()).expect(201));
    const s = await row(v.id);
    const short = nuv.inflowFor(s.reference, 'successful', {
      amount: CHARGE - 1,
    });
    const out = await deliver(me, short);
    expect(out.outcome).toBe('failed');
    expect(out.note).toMatch(/nothing credited/);
    expect(await ledgerRows(s.reference)).toHaveLength(0);
    expect((await row(v.id)).reviewNote).toBe('amount differs');
    const other = nuv.inflowFor(s.reference, 'pending');
    other.unique_reference = 'someone-elses-card';
    const stranger = await deliver(me, other);
    expect(stranger.outcome).toBe('failed');
    expect(stranger.note).toMatch(/not money in by bank transfer/);
  });

  it('admin: lists, freezes (a frozen attempt that is paid is kept for review, not credited), unfreezes, and every act leaves an audit row; support may not', async () => {
    const me = await person();
    const v = view(await start(me, cardBody()).expect(201));
    const s = await row(v.id);
    await adminReq(AdminRole.support).get('').expect(403);
    const list = await adminReq(AdminRole.finance)
      .get(`?wawuUserId=${me.id}`)
      .expect(200);
    expect(
      data<{ items: AdminAddMoneyView[] }>(list).items.map((x) => x.id),
    ).toContain(v.id);
    const frozen = await adminReq(AdminRole.finance)
      .post(`/${v.id}/freeze`, { reason: 'checking the card owner' })
      .expect(200);
    expect(data<AdminAddMoneyView>(frozen).frozen).toBe(true);
    // The settled inflow arrives while it is frozen, through the real receiver and dispatcher: held, not failed.
    const delivery = await post(
      'inflows.completed',
      nuv.inflowFor(s.reference, 'successful'),
    );
    await sweepNow();
    const waiting = await stored(delivery.id);
    expect(waiting.processingStatus).toBe('pending');
    expect(waiting.note).toMatch(/held/);
    expect(await ledgerRows(s.reference)).toHaveLength(0);
    expect((await row(v.id)).reviewNote).toMatch(/held until it is unfrozen/);
    // Unfreezing makes the held delivery due at once; the dispatcher credits it once.
    await adminReq(AdminRole.superadmin)
      .post(`/${v.id}/unfreeze`, {})
      .expect(200);
    expect((await stored(delivery.id)).nextAttemptAt).toBeNull();
    await sweepNow();
    await sweepNow();
    expect((await stored(delivery.id)).processingStatus).toBe('processed');
    const credited = await ledgerRows(s.reference);
    expect(credited).toHaveLength(1);
    const after = await row(v.id);
    expect(after.status).toBe('settled');
    expect(after.reviewNote).toBeNull();
    const detail = await adminReq(AdminRole.finance)
      .get(`/${v.id}`)
      .expect(200);
    const audits = data<AdminAddMoneyView>(detail).audits as {
      action: string;
      reason: string | null;
    }[];
    expect(audits.map((a) => a.action).sort()).toEqual(['freeze', 'unfreeze']);
    expect(audits.find((a) => a.action === 'freeze')!.reason).toBe(
      'checking the card owner',
    );
    // A credited attempt cannot be frozen or cancelled any more.
    await adminReq(AdminRole.finance).post(`/${v.id}/freeze`, {}).expect(409);
    await adminReq(AdminRole.finance).post(`/${v.id}/cancel`, {}).expect(409);
  });

  it('admin and person cancel an open hosted attempt (the intent is cancelled at Nuvion); a paid one cannot be cancelled', async () => {
    const me = await person();
    nuv.cardMode = 'threeds';
    const a = view(await start(me, cardBody()).expect(201));
    const cancelled = await request(app.getHttpServer())
      .post(`${BASE}/${a.id}/cancel`)
      .set('Authorization', me.auth)
      .expect(200);
    expect(view(cancelled).status).toBe('cancelled');
    const b = view(
      await start(me, {
        rail: 'apple_pay',
        amountKobo: AMOUNT,
        chargeKobo: CHARGE,
      }).expect(201),
    );
    const byAdmin = await adminReq(AdminRole.finance)
      .post(`/${b.id}/cancel`, { reason: 'asked by the person' })
      .expect(200);
    expect(data<AdminAddMoneyView>(byAdmin).status).toBe('cancelled');
    expect(data<AdminAddMoneyView>(byAdmin).audits[0]).toMatchObject({
      action: 'cancel',
      toStatus: 'cancelled',
    });
    nuv.cardMode = 'frictionless';
    const paid = view(await start(me, cardBody()).expect(201));
    const res = await request(app.getHttpServer())
      .post(`${BASE}/${paid.id}/cancel`)
      .set('Authorization', me.auth);
    expect(res.status).toBe(409);
    expect(refusal(res).code).toBe('add_money_unavailable');
  });

  it("a card that is not the key's own length is a plain 400 before the PIN: a short text, plain base64 and a card in the clear never pass", async () => {
    const me = await person();
    const wrongPin = (card: object) =>
      request(app.getHttpServer())
        .post(BASE)
        .set('Authorization', me.auth)
        .set('Idempotency-Key', randomUUID())
        .set('X-Transaction-Pin', '0000')
        .send(cardBody({ card }));
    const billing = { line1: '1 Test Street', city: 'Lagos', state: 'Lagos' };
    for (const encrypted of [
      Buffer.from('4111111111111111').toString('base64').padEnd(60, 'A'),
      Buffer.alloc(255, 7).toString('base64'),
      Buffer.alloc(257, 7).toString('base64'),
      'A'.repeat(344),
    ]) {
      const res = await wrongPin({ encrypted, billing });
      expect(res.status).toBe(400);
    }
    expect(
      await prisma.addMoneySession.count({ where: { wawuUserId: me.id } }),
    ).toBe(0);
    // The right length with the right PIN goes through: none of those used a PIN try.
    await start(me, cardBody()).expect(201);
  });

  it("two taps at once cannot both pass the day's limit: one attempt is written, the other is refused", async () => {
    const me = await person();
    const results = await Promise.all([
      start(me, cardBody()),
      start(me, cardBody()),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 403]);
    expect(refusal(results.find((r) => r.status === 403)!).code).toBe(
      'limit_reached',
    );
    expect(
      await prisma.addMoneySession.count({ where: { wawuUserId: me.id } }),
    ).toBe(1);
  });

  it('the hosted ways come first when they can be used, then the card, then USSD, then every way that cannot be used', async () => {
    const me = await person();
    const order = (res: request.Response) =>
      data<Options>(res).rails.map(
        (r) => `${r.rail}:${r.available ? 'on' : 'off'}`,
      );
    // open banking is off here (its charge is not set): hosted Apple Pay leads, the card follows, USSD after, the unusable last.
    expect(order(await get(me, '/options').expect(200))).toEqual([
      'apple_pay:on',
      'card:on',
      'ussd:on',
      'open_banking:off',
    ]);
  });

  it('deleting the account keeps the attempt as a financial record without the person (anonymised), with its amounts, reference, ledger link and audit rows', async () => {
    const me = await person();
    const id = randomUUID();
    await prisma.addMoneySession.create({
      data: {
        id,
        wawuUserId: me.id,
        rail: 'card',
        amountKobo: 1_000_000n,
        chargeKobo: 1_000_125n,
        providerFeeKobo: 75n,
        wawuFeeKobo: 50n,
        status: 'settled',
        reference: `wawu-add-purge-${id}`,
        providerRef: 'PIPURGE1',
        cardLast4: '1111',
        ledgerEntryId: 'ledger-row-1',
        creditedAt: new Date(),
      },
    });
    await prisma.addMoneyAudit.create({
      data: {
        sessionId: id,
        action: 'freeze',
        fromStatus: 'processing',
        toStatus: 'processing',
        actedByAdminId: 'admin-1',
        actedByAdminEmail: 'finance@admin.test.wawu.dev',
        actedByAdminRole: AdminRole.finance,
      },
    });
    const report = await new AccountPurgeService(prisma).purge(me.id);
    expect(report.failed).not.toContain('AddMoneySession.wawuUserId');
    expect(report.deleted['AddMoneySession.wawuUserId (anonymised)']).toBe(1);
    const kept = await prisma.addMoneySession.findUniqueOrThrow({
      where: { id },
    });
    expect(kept.wawuUserId).toBeNull();
    expect(kept).toMatchObject({
      status: 'settled',
      amountKobo: 1_000_000n,
      wawuFeeKobo: 50n,
      reference: `wawu-add-purge-${id}`,
      ledgerEntryId: 'ledger-row-1',
    });
    expect(await prisma.addMoneyAudit.count({ where: { sessionId: id } })).toBe(
      1,
    );
  });

  it('the plan setting switches a product off without a deploy (card and Apple Pay, not USSD); the return page holds no payment data', async () => {
    const me = await person();
    const settings = moduleRef.get(PlanSettingsService, { strict: false });
    await prisma.planSetting.upsert({
      where: { key: 'money.add_money_card_on' },
      create: { key: 'money.add_money_card_on', value: 0 },
      update: { value: 0 },
    });
    await settings.refresh();
    try {
      const off = await get(me, `/quote?rail=card&amountKobo=${AMOUNT}`).expect(
        409,
      );
      expect(refusal(off)).toMatchObject({
        code: 'add_money_unavailable',
        message: 'This is switched off for now.',
      });
      const o = { data: data<Options>(await get(me, '/options').expect(200)) };
      expect(o.data.cardPublicKey).toBeNull();
      expect(o.data.rails.find((r) => r.rail === 'ussd')!.available).toBe(true);
      const blocked = await start(me, cardBody());
      expect(blocked.status).toBe(409);
    } finally {
      // Back to on (the suite's own setting; the default is off since NUVION-FIX 1.1).
      await prisma.planSetting.upsert({
        where: { key: 'money.add_money_card_on' },
        create: { key: 'money.add_money_card_on', value: 1 },
        update: { value: 1 },
      });
      await settings.refresh();
    }
    await get(me, `/quote?rail=card&amountKobo=${AMOUNT}`).expect(200);
    const page = await request(app.getHttpServer())
      .get(`${BASE}/return?id=${randomUUID()}`)
      .expect(200);
    expect(page.text).toContain('wawu://add-money/status?id=');
    expect(page.text).not.toMatch(/4111|token/i);
    const evil = await request(app.getHttpServer())
      .get(`${BASE}/return?id="><script>x</script>`)
      .expect(200);
    expect(evil.text).not.toContain('<script>x');
  });
});
