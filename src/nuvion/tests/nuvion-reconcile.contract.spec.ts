import { randomBytes, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import {
  type INestApplication,
  type LoggerService,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { PassportModule } from '@nestjs/passport';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import {
  NuvionAccountsStandin,
  type StandinAccount,
} from '../../../test/nuvion/accounts-standin';
import { NuvionBookStandin } from '../../../test/nuvion/book-standin';
import { errorBody, NuvionStandin } from '../../../test/nuvion/nuvion-standin';
import {
  guardOutbound,
  type OutboundGuard,
} from '../../../test/nuvion/outbound-guard';
import { NuvionReconcileStandin } from '../../../test/nuvion/reconcile-standin';
import { WawuIdDouble } from '../../../test/nuvion/wawu-id-double';
import { WawuIdClient } from '../../common/auth/wawu-id.client';
import { WawuJwtStrategy } from '../../common/auth/wawu-jwt.strategy';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { HUB_APP_OPTIONS } from '../../hub-app-options';
import { LedgerService } from '../../money/ledger/ledger.service';
import { MoneyModule } from '../../money/money.module';
import { WALLET_PROVIDER } from '../../wallet-provider/wallet-provider.interface';
import { PrismaNuvionBookStore } from '../areas/book-store';
import { NuvionReconcileHandler } from '../handlers/reconcile.handler';
import { NuvionClient } from '../nuvion-client';
import { NuvionWalletProvider, nuvionAreas } from '../nuvion-wallet-provider';
import { signNuvionDelivery } from '../webhook/nuvion-signature';
import { NuvionWebhookDispatcher } from '../webhook/nuvion-webhook-dispatcher.service';
import { NuvionWebhookModule } from '../webhook/nuvion-webhook.module';

/**
 * NUV-08 end to end on a real database: the sweep, the webhook
 * subscription check and the fee check's notice, over Nuvion's stand-in
 * (test/nuvion/reconcile-standin.ts) through the real adapter and client,
 * with the stored deliveries handed to the real NUV-04, NUV-05 and NUV-06
 * handlers by the real dispatcher and the ledger written by the real
 * LedgerService. A late real delivery is posted to the real receiver.
 * Nothing here reaches a Nuvion, Fintava or wawuafrica.com host: every
 * connection but loopback is refused (outbound-guard.ts).
 */

jest.setTimeout(120_000);

const RUN = `nuv08-${randomUUID().slice(0, 8)}`;
const SECRET = 'whsec_nuv08_reconcile_0123456789abcdef';
const HOOK = '/api/hub/webhooks/nuvion';
const KEY = 'nv_test_sk_NUV08contractKEY00000000';

class QuietLogger implements LoggerService {
  log() {}
  error() {}
  warn() {}
  debug() {}
  verbose() {}
  fatal() {}
}

let seq = 0;
const nuban = () =>
  `7${String(Date.now()).slice(-6)}${String((seq += 1)).padStart(3, '0')}`;
/** A transfer id that cannot collide (the stand-in's own pads with zeros). */
const TAG = randomBytes(4).toString('hex').toUpperCase();
const uid = () => `01TRF08${TAG}${String((seq += 1)).padStart(11, '0')}`;

interface Person {
  id: string;
  entityId: string;
  account: StandinAccount;
  number: string;
}

describe('NUV-08: missed deliveries, the webhook subscription and the fee check', () => {
  const wawuId = new WawuIdDouble();
  const standin = new NuvionStandin();
  const accounts = new NuvionAccountsStandin(standin);
  const book = new NuvionBookStandin(standin, accounts);
  const rec = new NuvionReconcileStandin(standin, accounts, book);
  let guard: OutboundGuard;
  let moduleRef: TestingModule;
  let app: INestApplication;
  let prisma: PrismaService;
  let dispatcher: NuvionWebhookDispatcher;
  let handler: NuvionReconcileHandler;
  let ledger: LedgerService;
  let provider: NuvionWalletProvider;
  const saved: Record<string, string | undefined> = {};
  const people: string[] = [];

  const ENV: Record<string, string> = {
    WALLET_PROVIDER: 'nuvion',
    NUVION_WEBHOOK_SECRET: SECRET,
    NUVION_WALLET_BANK_NAME: 'Configured Nuvion Bank',
    NUVION_FEE_BOOK_TRANSFER: '0:1500,500000:2500',
    NUVION_FEE_BANK_PAYOUT: '2500',
    NUVION_FEE_INFLOW: '0',
  };

  beforeAll(async () => {
    guard = guardOutbound();
    await wawuId.start();
    await standin.start();
    accounts.install();
    book.install();
    rec.install();
    Object.assign(ENV, {
      WAWU_ID_JWKS_URL: wawuId.jwksUrl,
      WAWU_ID_BASE_URL: wawuId.baseUrl,
    });
    for (const [k, v] of Object.entries(ENV)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
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
        factory: (db: PrismaService) => {
          const client = new NuvionClient(
            standin.settings({ operationalAccountId: book.operational.id }),
            KEY,
          );
          provider = new NuvionWalletProvider(
            client,
            nuvionAreas(client, { bookStore: new PrismaNuvionBookStore(db) }),
          );
          return provider;
        },
      })
      .setLogger(new QuietLogger())
      .compile();
    app = moduleRef.createNestApplication(HUB_APP_OPTIONS);
    app.useLogger(new QuietLogger());
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
    dispatcher = moduleRef.get(NuvionWebhookDispatcher);
    handler = moduleRef.get(NuvionReconcileHandler, { strict: false });
    ledger = moduleRef.get(LedgerService, { strict: false });
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.nuvionBookTransfer.deleteMany({
        where: { reference: { startsWith: RUN } },
      });
      await prisma.fintavaLedgerEntry.deleteMany({
        where: { wawuUserId: { in: people } },
      });
      await prisma.fintavaLedgerEntry.deleteMany({
        where: { customerReference: { startsWith: `wawu-bank-${RUN}` } },
      });
      await prisma.fintavaWallet.deleteMany({
        where: { wawuUserId: { in: people } },
      });
      await prisma.fintavaWalletOpening.deleteMany({
        where: { wawuUserId: { in: people } },
      });
      await prisma.nuvionEntity.deleteMany({
        where: { wawuUserId: { in: people } },
      });
      await prisma.nuvionWebhookEvent.deleteMany({
        where: {
          OR: [
            { eventId: { startsWith: RUN } },
            { eventId: { startsWith: 'reconcile-' } },
          ],
        },
      });
      await prisma.nuvionReconcileFinding.deleteMany({});
    }
    if (app) await app.close();
    await standin.stop();
    await wawuId.stop();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    guard.restore();
  });

  beforeEach(async () => {
    standin.reset();
    await prisma.nuvionReconcileFinding.deleteMany({});
  });

  afterEach(() => {
    standin.reset();
    expect(guard.violations).toEqual([]);
  });

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  let evt = 0;
  const eventId = () =>
    `${RUN}-${(evt += 1)}-${randomBytes(4).toString('hex')}`;

  /** Posts a signed delivery to the real receiver and answers its stored row. */
  async function deliver(event: string, data: unknown) {
    const id = eventId();
    const ts = new Date().toISOString();
    const raw = JSON.stringify({ event, data });
    const res = await request(app.getHttpServer() as Server)
      .post(HOOK)
      .set('Content-Type', 'application/json')
      .set('x-nuvion-event-id', id)
      .set('x-nuvion-event-timestamp', ts)
      .set(
        'x-nuvion-event-signature',
        signNuvionDelivery(SECRET, ts, Buffer.from(raw)),
      )
      .send(raw);
    expect(res.status).toBe(200);
    return prisma.nuvionWebhookEvent.findUniqueOrThrow({
      where: { eventId: id },
    });
  }

  /** Hands one stored delivery to its handlers now (the 30 s sweep's step). */
  async function dispatch(id: string) {
    await prisma.nuvionWebhookEvent.update({
      where: { id },
      data: { nextAttemptAt: null },
    });
    await dispatcher.dispatch(id);
    return prisma.nuvionWebhookEvent.findUniqueOrThrow({ where: { id } });
  }

  const sweptRow = (transferId: string, event: string) =>
    prisma.nuvionWebhookEvent.findUnique({
      where: { eventId: `reconcile-${transferId}-${event}` },
    });

  const eventsOf = (transferId: string) =>
    prisma.nuvionWebhookEvent.findMany({ where: { resourceId: transferId } });

  /** A person with an active naira account number, as NUV-02 and NUV-04 leave one. */
  async function activePerson(): Promise<Person> {
    const id = randomUUID();
    people.push(id);
    const entityId =
      `01ENT${RUN.replace(/\W/g, '').toUpperCase()}${String((seq += 1)).padStart(6, '0')}`.slice(
        0,
        26,
      );
    await prisma.nuvionEntity.create({
      data: { wawuUserId: id, entityId, status: 'approved' },
    });
    await prisma.fintavaWalletOpening.create({
      data: {
        wawuUserId: id,
        state: 'unknown',
        bvnHash: `${RUN}-${randomBytes(12).toString('hex')}`,
        bvnVerifiedAt: new Date(),
        phone: `+234${nuban()}`,
        provider: 'nuvion',
      },
    });
    const account = accounts.addAccount(entityId, {
      created: Date.now() - 30 * 86_400_000,
    });
    const created = await deliver('accounts.created', {
      account: {
        id: account.id,
        entity_id: entityId,
        type: account.type,
        currency: account.currency,
        display_name: account.display_name,
        balance: { available: 0, current: 0 },
        meta: {},
        created: account.created,
        updated: account.updated,
      },
      entity_impact: {
        entity_id: entityId,
        total_accounts: 1,
        account_type: ['checking'],
        default_account_set: true,
      },
    });
    await dispatch(created.id);
    const detailsId = (
      await prisma.nuvionEntity.findUniqueOrThrow({
        where: { wawuUserId: id },
      })
    ).accountDetailsId!;
    const number = nuban();
    const d = accounts.activate(detailsId, number);
    const active = await deliver('account_details.updated', {
      id: d.id,
      entity_id: d.entity_id,
      account_id: d.account_id,
      account_number: d.account_number,
      issuer: { code: d.issuer.code, name: d.issuer.name },
      status: d.status,
      created: d.created,
      updated: d.updated,
    });
    expect((await dispatch(active.id)).processingStatus).toBe('processed');
    return { id, entityId, account, number };
  }

  const credits = (p: Person) =>
    prisma.fintavaLedgerEntry.findMany({
      where: { wawuUserId: p.id },
      orderBy: { createdAt: 'asc' },
    });

  const longAgo = () => Date.now() - 20 * 60_000;

  // ---------------------------------------------------------------------
  // The sweep
  // ---------------------------------------------------------------------

  describe('the sweep', () => {
    it('an inflow whose delivery never arrived is found and credited once; the late delivery changes nothing (V8)', async () => {
      const p = await activePerson();
      const inflow = accounts.addInflow(p.account, {
        id: uid(),
        amount: 250_000,
        applicable_fee: 0,
        created: longAgo(),
      });
      expect(await credits(p)).toHaveLength(0);

      const first = await handler.sweep(new Date());
      expect(first!.fed).toBeGreaterThanOrEqual(1);
      const stored = await sweptRow(inflow.id, 'inflows.completed');
      expect(stored).toMatchObject({
        processingStatus: 'pending',
        resourceId: inflow.id,
        entityId: p.entityId,
      });
      // Stored, not credited: the handlers decide, after reading it back.
      expect(await credits(p)).toHaveLength(0);

      expect((await dispatch(stored!.id)).processingStatus).toBe('processed');
      const [row] = await credits(p);
      expect(await credits(p)).toHaveLength(1);
      expect(row).toMatchObject({
        direction: 'in',
        status: 'completed',
        amountKobo: 250_000n,
        provider: 'nuvion',
        fintavaTransactionId: inflow.id,
      });

      // A second pass: one stored delivery already names it. Nothing new.
      const second = await handler.sweep(new Date());
      expect(second!.held).toBeGreaterThanOrEqual(1);
      expect(await eventsOf(inflow.id)).toHaveLength(1);

      // The late real delivery arrives: stored as its own row, handled, and
      // the ledger holds the same one row with the same figures.
      const late = await deliver('inflows.completed', inflow);
      expect((await dispatch(late.id)).processingStatus).toBe('processed');
      const after = await credits(p);
      expect(after).toHaveLength(1);
      expect({
        id: after[0].id,
        status: after[0].status,
        amountKobo: after[0].amountKobo,
        feeKobo: after[0].feeKobo,
        source: after[0].source,
        sourceEventId: after[0].sourceEventId,
        discrepancy: after[0].discrepancy,
      }).toEqual({
        id: row.id,
        status: row.status,
        amountKobo: row.amountKobo,
        feeKobo: row.feeKobo,
        source: row.source,
        sourceEventId: row.sourceEventId,
        discrepancy: null,
      });
    });

    it('the late delivery first, then the sweep: still one credit, and no second delivery is made', async () => {
      const p = await activePerson();
      const inflow = accounts.addInflow(p.account, {
        id: uid(),
        amount: 90_000,
        created: longAgo(),
      });
      const real = await deliver('inflows.completed', inflow);
      expect((await dispatch(real.id)).processingStatus).toBe('processed');
      const report = await handler.sweep(new Date());
      expect(report!.held).toBeGreaterThanOrEqual(1);
      expect(await sweptRow(inflow.id, 'inflows.completed')).toBeNull();
      expect(await credits(p)).toHaveLength(1);
    });

    it('a movement Nuvion still shows pending is left for the next pass, then settled once', async () => {
      const p = await activePerson();
      const inflow = accounts.addInflow(p.account, {
        id: uid(),
        amount: 40_000,
        status: 'pending',
        created: longAgo(),
      });
      const first = await handler.sweep(new Date());
      expect(first!.stillPending).toBeGreaterThanOrEqual(1);
      expect(await eventsOf(inflow.id)).toHaveLength(0);
      inflow.status = 'successful';
      await handler.sweep(new Date());
      const stored = await sweptRow(inflow.id, 'inflows.completed');
      expect(stored).not.toBeNull();
      await dispatch(stored!.id);
      expect(await credits(p)).toHaveLength(1);
    });

    it('a bank send whose outcome delivery was lost is settled once', async () => {
      const p = await activePerson();
      const reference = `wawu-bank-${RUN}-${randomBytes(4).toString('hex')}`;
      await ledger.record({
        wallet: {
          kind: 'user',
          wawuUserId: p.id,
          accountNumber: p.number,
        },
        direction: 'out',
        status: 'pending',
        category: 'transfer',
        amountKobo: 120_000,
        feeKobo: 5_000,
        totalKobo: 125_000,
        counterparty: {
          kind: 'bank_account',
          name: null,
          accountNumber: null,
          bankCode: null,
        },
        references: { customerReference: reference },
        source: 'send',
      });
      const send = accounts.addInflow(p.account, {
        id: uid(),
        type: 'outflow',
        payment_type: 'bank-transfer',
        amount: 120_000,
        applicable_fee: 5_000,
        unique_reference: reference,
        created: longAgo(),
      });
      const rows = () =>
        prisma.fintavaLedgerEntry.findMany({
          where: { customerReference: reference },
        });
      expect((await rows())[0].status).toBe('pending');

      await handler.sweep(new Date());
      const stored = await sweptRow(send.id, 'outflows.completed');
      expect(stored).not.toBeNull();
      expect((await dispatch(stored!.id)).processingStatus).toBe('processed');
      expect(await rows()).toHaveLength(1);
      expect((await rows())[0]).toMatchObject({
        status: 'completed',
        amountKobo: 120_000n,
        fintavaTransactionId: send.id,
      });

      // Nothing more to find, and the late delivery changes nothing.
      await handler.sweep(new Date());
      expect(await eventsOf(send.id)).toHaveLength(1);
      const late = await deliver('outflows.completed', send);
      expect((await dispatch(late.id)).processingStatus).toBe('processed');
      expect(await rows()).toHaveLength(1);
      expect((await rows())[0].status).toBe('completed');
    });

    it('a book transfer whose outcome delivery was lost is settled once, found from the pending log', async () => {
      const p = await activePerson();
      book.mode = 'pending';
      p.account.balance = {
        available: 1_000_000,
        current: 1_000_000,
        overdraft_used: 0,
      };
      const reference = `${RUN}-book-${randomBytes(4).toString('hex')}`;
      // Nuvion answers the transfer pending: the adapter says it is not
      // confirmed, and the log holds it (the payment's sweep asks again).
      await expect(
        provider.walletToWallet({
          fromAccountNumber: p.number,
          toAccountNumber: book.operational.nuvion_ban,
          amountKobo: 30_000n,
          reference,
        }),
      ).rejects.toMatchObject({ kind: 'not_confirmed' });
      const logged = () =>
        prisma.nuvionBookTransfer.findUniqueOrThrow({ where: { reference } });
      const before = await logged();
      expect(before.status).toBe('pending');
      const id = before.nuvionId!;

      // Nuvion finishes it; no delivery comes. Two minutes on, the sweep
      // re-reads the pending log row and stores the outcome once.
      book.settle(id, 'successful');
      const later = new Date(Date.now() + 3 * 60_000);
      const first = await handler.sweep(later);
      expect(first!.pendingChecked).toBeGreaterThanOrEqual(1);
      const stored = await sweptRow(id, 'outflows.completed');
      expect(stored).not.toBeNull();
      expect((await dispatch(stored!.id)).processingStatus).toBe('processed');
      expect((await logged()).status).toBe('successful');

      await handler.sweep(later);
      expect(await eventsOf(id)).toHaveLength(1);
      const late = await deliver('outflows.completed', book.byId(id)!);
      expect((await dispatch(late.id)).processingStatus).toBe('processed');
      expect((await logged()).status).toBe('successful');
    });

    it('a statement line that cannot be read back is reported, not only counted', async () => {
      const p = await activePerson();
      const inflow = accounts.addInflow(p.account, {
        id: uid(),
        amount: 10_000,
        created: longAgo(),
      });
      standin.on('GET', `/transfers/${inflow.id}`, {
        status: 404,
        body: errorBody('error_resource_not_found', 'Resource does not exist'),
      });
      const report = await handler.sweep(new Date());
      expect(report!.unreadable).toBeGreaterThanOrEqual(1);
      expect(report!.incomplete.join(' ')).toMatch(
        /could not be read back \(not_found\)/,
      );
      expect(await eventsOf(inflow.id)).toHaveLength(0);
      expect(
        await prisma.nuvionReconcileFinding.findUnique({
          where: {
            kind_subject: { kind: 'sweep_incomplete', subject: 'sweep' },
          },
        }),
      ).toMatchObject({ resolvedAt: null });
      rec.install();
    });

    it('a statement that cannot be read is reported, not taken as "nothing happened"; the next clean pass clears it', async () => {
      standin.next(
        {
          status: 503,
          body: {
            status: 'error',
            message: 'down',
            type: 'error_service_unavailable',
          },
        },
        4,
      );
      const bad = await handler.sweep(new Date());
      expect(bad!.incomplete.length).toBeGreaterThan(0);
      const open = await prisma.nuvionReconcileFinding.findUnique({
        where: { kind_subject: { kind: 'sweep_incomplete', subject: 'sweep' } },
      });
      expect(open).toMatchObject({ resolvedAt: null });
      standin.reset();
      const good = await handler.sweep(new Date());
      expect(good!.incomplete).toEqual([]);
      const cleared = await prisma.nuvionReconcileFinding.findUniqueOrThrow({
        where: { kind_subject: { kind: 'sweep_incomplete', subject: 'sweep' } },
      });
      expect(cleared.resolvedAt).not.toBeNull();
    });
  });

  // ---------------------------------------------------------------------
  // The webhook subscription
  // ---------------------------------------------------------------------

  describe('the webhook subscription', () => {
    const open = (kind: string) =>
      prisma.nuvionReconcileFinding.findMany({
        where: { kind, resolvedAt: null },
      });
    const writes = () =>
      standin.seen.filter(
        (r) => r.path.startsWith('/entity-webhooks') && r.method !== 'GET',
      );

    beforeEach(() => {
      rec.subscriptions.clear();
    });

    it('an active one is left alone; nothing is renewed, rotated or written', async () => {
      rec.addSubscription({ expires_in: 3_600 });
      rec.addSubscription({
        url: 'https://elsewhere.example.test/hooks',
        status: 'inactive',
      });
      expect(await handler.checkSubscription()).toBe('ok');
      expect(await open('subscription_inactive')).toHaveLength(0);
      expect(await open('subscription_missing')).toHaveLength(0);
      expect(writes()).toHaveLength(0);
    });

    it('one that Nuvion has made inactive is reported, then cleared once an active one exists', async () => {
      rec.addSubscription({ status: 'inactive' });
      expect(await handler.checkSubscription()).toBe('inactive');
      const [finding] = await open('subscription_inactive');
      expect(finding).toMatchObject({ subject: 'subscription', seenCount: 1 });
      expect(finding.detail).toMatch(/not active/);
      expect(await handler.checkSubscription()).toBe('inactive');
      expect((await open('subscription_inactive'))[0].seenCount).toBe(2);
      expect(writes()).toHaveLength(0);

      rec.addSubscription();
      expect(await handler.checkSubscription()).toBe('ok');
      expect(await open('subscription_inactive')).toHaveLength(0);
    });

    it('an old inactive one beside an active one is no finding', async () => {
      rec.addSubscription({ status: 'inactive' });
      rec.addSubscription({ status: 'active' });
      expect(await handler.checkSubscription()).toBe('ok');
      expect(await open('subscription_inactive')).toHaveLength(0);
    });

    it('no subscription for our address at all is reported', async () => {
      rec.addSubscription({ url: 'https://elsewhere.example.test/hooks' });
      expect(await handler.checkSubscription()).toBe('missing');
      expect(await open('subscription_missing')).toHaveLength(1);
      rec.addSubscription();
      expect(await handler.checkSubscription()).toBe('ok');
      expect(await open('subscription_missing')).toHaveLength(0);
    });

    it('a list that cannot be read is reported, and clears on the next good read', async () => {
      standin.next(
        {
          status: 503,
          body: {
            status: 'error',
            message: 'down',
            type: 'error_service_unavailable',
          },
        },
        4,
      );
      expect(await handler.checkSubscription()).toBe('unreadable');
      expect(await open('subscription_unreadable')).toHaveLength(1);
      standin.reset();
      rec.addSubscription();
      expect(await handler.checkSubscription()).toBe('ok');
      expect(await open('subscription_unreadable')).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------
  // The fee check
  // ---------------------------------------------------------------------

  describe('the fee check', () => {
    it('says once that it is not available, and calls no fee route', async () => {
      const settingBefore = process.env.NUVION_FEE_BANK_PAYOUT;
      expect(await handler.checkFees()).toEqual({
        available: false,
        reported: true,
      });
      const finding = await prisma.nuvionReconcileFinding.findUniqueOrThrow({
        where: {
          kind_subject: { kind: 'fee_check_unavailable', subject: 'fee-check' },
        },
      });
      expect(finding).toMatchObject({ resolvedAt: null, seenCount: 1 });
      expect(finding.detail).toMatch(/Fee check not available/);
      expect(finding.detail).not.toContain('\u2014');

      // Again: the finding is open, so nothing is reported a second time.
      expect(await handler.checkFees()).toEqual({
        available: false,
        reported: false,
      });
      expect(
        (
          await prisma.nuvionReconcileFinding.findUniqueOrThrow({
            where: { id: finding.id },
          })
        ).seenCount,
      ).toBe(1);
      expect(process.env.NUVION_FEE_BANK_PAYOUT).toBe(settingBefore);
      expect(standin.seen.filter((r) => r.path.includes('fee'))).toHaveLength(
        0,
      );
    });
  });

  // ---------------------------------------------------------------------
  // The clock, and only under Nuvion
  // ---------------------------------------------------------------------

  describe('the minute clock', () => {
    it('sweeps and checks the subscription every NUVION_SWEEP_MINUTES, and says once that the fee check is not available', async () => {
      const fresh = new NuvionReconcileHandler(
        prisma,
        moduleRef.get(ModuleRef),
      );
      rec.subscriptions.clear();
      rec.addSubscription();
      const count = (path: string, method = 'GET') =>
        standin.seen.filter((r) => r.method === method && r.path === path)
          .length;
      const feeFinding = () =>
        prisma.nuvionReconcileFinding.findUnique({
          where: {
            kind_subject: {
              kind: 'fee_check_unavailable',
              subject: 'fee-check',
            },
          },
        });
      const t0 = new Date();
      const subs0 = count('/entity-webhooks');
      await fresh.tick(t0);
      expect(count('/entity-webhooks')).toBe(subs0 + 1);
      expect(await feeFinding()).toMatchObject({
        resolvedAt: null,
        seenCount: 1,
      });

      await fresh.tick(new Date(t0.getTime() + 60_000));
      expect(count('/entity-webhooks')).toBe(subs0 + 1);

      await fresh.tick(new Date(t0.getTime() + 16 * 60_000));
      expect(count('/entity-webhooks')).toBe(subs0 + 2);

      await fresh.tick(new Date(t0.getTime() + 25 * 3_600_000));
      expect(await feeFinding()).toMatchObject({ seenCount: 1 });
      expect(standin.seen.filter((r) => r.path.includes('fee'))).toHaveLength(
        0,
      );
      expect(
        standin.seen.filter(
          (r) => r.path.startsWith('/entity-webhooks') && r.method !== 'GET',
        ),
      ).toHaveLength(0);
    });

    it('does nothing when Nuvion is not the running provider, and calls nothing', async () => {
      const notNuvion = new NuvionReconcileHandler(prisma, {
        get: () => ({ name: 'other', label: 'Other' }),
      } as unknown as ModuleRef);
      const before = standin.seen.length;
      await notNuvion.tick(new Date());
      expect(await notNuvion.sweep()).toBeNull();
      expect(await notNuvion.checkSubscription()).toBeNull();
      expect(await notNuvion.checkFees()).toBeNull();
      expect(standin.seen.length).toBe(before);
    });
  });
});
