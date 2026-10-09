import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { join } from 'node:path';
import {
  type INestApplication,
  type LoggerService,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { PassportModule } from '@nestjs/passport';
import { Test, type TestingModule } from '@nestjs/testing';
import * as jwt from 'jsonwebtoken';
import request from 'supertest';
import {
  NuvionAccountsStandin,
  type StandinAccount,
  type StandinTransfer,
  standinId,
} from '../../../test/nuvion/accounts-standin';
import { NuvionStandin } from '../../../test/nuvion/nuvion-standin';
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
import { HUB_APP_OPTIONS } from '../../hub-app-options';
import { LedgerService } from '../../money/ledger/ledger.service';
import { MoneyModule } from '../../money/money.module';
import type {
  WalletBalanceView,
  WalletView,
} from '../../money/money-view.type';
import {
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import { NuvionAccountsArea, nuvionWalletId } from '../areas/accounts';
import { NuvionAccountsHandler } from '../handlers/accounts.handler';
import { NuvionInflowRecorder } from '../handlers/inflows';
import { NuvionClient } from '../nuvion-client';
import { readNuvionTransfer } from '../nuvion-ledger-delivery';
import { NuvionWalletProvider } from '../nuvion-wallet-provider';
import { signNuvionDelivery } from '../webhook/nuvion-signature';
import { NuvionWebhookDispatcher } from '../webhook/nuvion-webhook-dispatcher.service';
import { NuvionWebhookModule } from '../webhook/nuvion-webhook.module';

/**
 * NUV-04 end to end on a real database: Nuvion's signed deliveries posted to
 * the real receiver (`POST /api/hub/webhooks/nuvion`, NUV-01), handed to the
 * NUV-04 handler by the real dispatcher, Nuvion read back from the stand-in
 * (NUV-01's, with NUV-04's routes: test/nuvion/accounts-standin.ts) through
 * the real Nuvion adapter and client, the ledger written by the real
 * LedgerService, and the person's own routes (`GET /money/wallet`,
 * `GET /money/wallet/balance`) answered by the real MoneyModule with real
 * RS256 tokens checked against a local WAWU ID's JWKS.
 *
 * Nothing here reaches a Nuvion, Fintava or wawuafrica.com host: every
 * connection but loopback is refused (outbound-guard.ts).
 */

jest.setTimeout(120_000);

const RUN = `nuv04-${randomUUID().slice(0, 8)}`;
const SECRET = 'whsec_nuv04_accounts_0123456789abcdef';
const BANK_NAME_SETTING = 'Configured Nuvion Bank';
const BASE = '/api/hub/money';
const HOOK = '/api/hub/webhooks/nuvion';

class QuietLogger implements LoggerService {
  log() {}
  error() {}
  warn() {}
  debug() {}
  verbose() {}
  fatal() {}
}

function mintToken(sub: string): string {
  const privateKey = readFileSync(
    join(__dirname, '../../../mock-wawu-id/private.pem'),
    'utf8',
  );
  return jwt.sign(
    {
      sub,
      email: `nuv04-${sub}@test.wawu.dev`,
      phone: '+2348000009996',
      firstName: 'Nuvion',
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

let seq = 0;
function nuban(): string {
  seq += 1;
  return `8${String(Date.now()).slice(-6)}${String(seq).padStart(3, '0')}`;
}

type Envelope<T> = {
  statusCode: number;
  data: T | null;
  reason?: { code: string };
};

interface Person {
  id: string;
  entityId: string;
  auth: string;
}

describe('NUV-04: the account number, money in by bank transfer, and the balance', () => {
  const wawuId = new WawuIdDouble();
  const standin = new NuvionStandin();
  const nuv = new NuvionAccountsStandin(standin);
  let guard: OutboundGuard;
  let moduleRef: TestingModule;
  let app: INestApplication;
  let prisma: PrismaService;
  let dispatcher: NuvionWebhookDispatcher;
  let provider: NuvionWalletProvider;
  const saved: Record<string, string | undefined> = {};
  const people: string[] = [];

  const ENV: Record<string, string> = {
    WALLET_PROVIDER: 'nuvion',
    NUVION_WEBHOOK_SECRET: SECRET,
    NUVION_WALLET_BANK_NAME: BANK_NAME_SETTING,
  };

  beforeAll(async () => {
    guard = guardOutbound();
    await wawuId.start();
    await standin.start();
    nuv.install();
    Object.assign(ENV, {
      WAWU_ID_JWKS_URL: wawuId.jwksUrl,
      WAWU_ID_BASE_URL: wawuId.baseUrl,
    });
    for (const [k, v] of Object.entries(ENV)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    provider = new NuvionWalletProvider(
      new NuvionClient(
        standin.settings(),
        'nv_test_sk_NUV04accountsKEY00000000000',
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
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.fintavaLedgerEntry.deleteMany({
        where: { wawuUserId: { in: people } },
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
        where: { eventId: { startsWith: RUN } },
      });
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

  afterEach(() => {
    expect(guard.violations).toEqual([]);
  });

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  /** A person Nuvion has approved (NUV-02's part, written as NUV-02 leaves it). */
  async function approved(): Promise<Person> {
    const id = randomUUID();
    people.push(id);
    const entityId = standinId('01ENT');
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
    return { id, entityId, auth: `Bearer ${mintToken(id)}` };
  }

  let evt = 0;
  function eventId(): string {
    evt += 1;
    return `${RUN}-${evt}-${randomBytes(4).toString('hex')}`;
  }

  /** Posts a signed delivery to the real receiver; answers its event id. */
  async function deliver(
    event: string,
    data: unknown,
    opts: { id?: string; timestamp?: string } = {},
  ): Promise<string> {
    const id = opts.id ?? eventId();
    const ts = opts.timestamp ?? new Date().toISOString();
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
    return id;
  }

  async function row(eventIdValue: string) {
    return prisma.nuvionWebhookEvent.findUniqueOrThrow({
      where: { eventId: eventIdValue },
    });
  }

  /** Hands one stored delivery to its handlers now (the 30 s sweep's step). */
  async function dispatch(eventIdValue: string) {
    const r = await row(eventIdValue);
    await prisma.nuvionWebhookEvent.update({
      where: { id: r.id },
      data: { nextAttemptAt: null },
    });
    await dispatcher.dispatch(r.id);
    return row(eventIdValue);
  }

  async function deliverAndDispatch(event: string, data: unknown) {
    return dispatch(await deliver(event, data));
  }

  function get<T>(path: string, auth: string) {
    return request(app.getHttpServer() as Server)
      .get(`${BASE}${path}`)
      .set('Authorization', auth)
      .then((res) => ({
        status: res.status,
        body: res.body as Envelope<T>,
        text: res.text,
      }));
  }

  const wallet = (p: Person) =>
    get<WalletView>('/wallet', p.auth).then((r) => r.body.data!);

  const entity = (p: Person) =>
    prisma.nuvionEntity.findUniqueOrThrow({ where: { wawuUserId: p.id } });

  const credits = (p: Person) =>
    prisma.fintavaLedgerEntry.findMany({
      where: { wawuUserId: p.id },
      orderBy: { createdAt: 'asc' },
    });

  /** accounts.created as webhooks__event-types.md shows it. */
  const accountCreated = (a: StandinAccount) => ({
    account: {
      id: a.id,
      entity_id: a.entity_id,
      type: a.type,
      currency: a.currency,
      display_name: a.display_name,
      balance: { available: 0, current: 0 },
      meta: {},
      created: a.created,
      updated: a.updated,
    },
    entity_impact: {
      entity_id: a.entity_id,
      total_accounts: 1,
      account_type: ['checking'],
      default_account_set: true,
    },
  });

  /** account_details.updated as webhooks__event-types.md shows it (flat). */
  const detailsUpdated = (detailsId: string) => {
    const d = nuv.details.get(detailsId)!;
    return {
      id: d.id,
      entity_id: d.entity_id,
      account_id: d.account_id,
      account_number: d.account_number,
      issuer: { code: d.issuer.code, name: d.issuer.name },
      status: d.status,
      created: d.created,
      updated: d.updated,
    };
  };

  /** Runs the account number's whole path; answers the person, their account and number. */
  async function activePerson(): Promise<{
    p: Person;
    account: StandinAccount;
    number: string;
  }> {
    const p = await approved();
    const account = nuv.addAccount(p.entityId);
    await deliverAndDispatch('accounts.created', accountCreated(account));
    const detailsId = (await entity(p)).accountDetailsId!;
    const number = nuban();
    nuv.activate(detailsId, number);
    const r = await deliverAndDispatch(
      'account_details.updated',
      detailsUpdated(detailsId),
    );
    expect(r.processingStatus).toBe('processed');
    return { p, account, number };
  }

  // ---------------------------------------------------------------------
  // The account number
  // ---------------------------------------------------------------------

  describe('the account number shows only once Nuvion makes it active', () => {
    it('approved: on its way; accounts.created requests the details once; pending shows nothing; active shows the number, holder and bank', async () => {
      const p = await approved();
      let w = await wallet(p);
      expect(w.state).toBe('opening');
      expect(w.account).toBeNull();
      expect(w.accountNumberStatus).toBe('on_its_way');

      const account = nuv.addAccount(p.entityId);
      const before = nuv.detailRequests.length;
      const created = await deliverAndDispatch(
        'accounts.created',
        accountCreated(account),
      );
      expect(created.processingStatus).toBe('processed');
      expect(nuv.detailRequests.length).toBe(before + 1);
      expect(nuv.detailRequests.at(-1)).toEqual({
        account_id: account.id,
        entity_id: p.entityId,
      });
      let e = await entity(p);
      expect(e.accountId).toBe(account.id);
      expect(e.accountDetailsStatus).toBe('pending');
      expect(e.accountNumber).toBeNull();

      // account_details.created, still pending: nothing to show.
      const pendingId = e.accountDetailsId!;
      const d = nuv.details.get(pendingId)!;
      const pending = await deliverAndDispatch('account_details.created', {
        account_details: { ...d },
      });
      expect(pending.processingStatus).toBe('processed');
      w = await wallet(p);
      expect(w.account).toBeNull();
      expect(w.accountNumberStatus).toBe('on_its_way');
      expect(
        await prisma.fintavaWallet.findUnique({ where: { wawuUserId: p.id } }),
      ).toBeNull();

      // Nuvion makes it active; the update is read back, then stored once.
      const number = nuban();
      nuv.activate(pendingId, number);
      const active = await deliverAndDispatch(
        'account_details.updated',
        detailsUpdated(pendingId),
      );
      expect(active.processingStatus).toBe('processed');
      expect(
        standin.seen.some(
          (r) =>
            r.method === 'GET' &&
            r.path === `/account-details/${pendingId}` &&
            r.query.entity_id === p.entityId,
        ),
      ).toBe(true);
      w = await wallet(p);
      expect(w.state).toBe('open');
      expect(w.accountNumberStatus).toBe('active');
      expect(w.account).toMatchObject({
        accountNumber: number,
        accountName: 'Ada Lovelace',
        bankName: 'Nuvion MFB',
        bankCode: '090999',
      });
      e = await entity(p);
      expect(e).toMatchObject({
        accountDetailsStatus: 'active',
        accountNumber: number,
        issuerBankName: 'Nuvion MFB',
        issuerBankCode: '090999',
        currency: 'NGN',
      });
      const stored = await prisma.fintavaWallet.findUniqueOrThrow({
        where: { wawuUserId: p.id },
      });
      expect(stored).toMatchObject({
        customerId: p.entityId,
        walletId: nuvionWalletId(p.entityId, account.id),
        accountNumber: number,
        accountName: 'Ada Lovelace',
        provider: 'nuvion',
      });
      const opening = await prisma.fintavaWalletOpening.findUniqueOrThrow({
        where: { wawuUserId: p.id },
      });
      expect(opening.state).toBe('open');

      // Replays change nothing and request nothing again.
      const n = nuv.detailRequests.length;
      await deliverAndDispatch('accounts.created', accountCreated(account));
      const again = await deliverAndDispatch(
        'account_details.updated',
        detailsUpdated(pendingId),
      );
      expect(again.processingStatus).toBe('processed');
      expect(nuv.detailRequests.length).toBe(n);
      expect(
        await prisma.fintavaWallet.count({ where: { wawuUserId: p.id } }),
      ).toBe(1);
    });

    it('a delivery saying active while Nuvion still says pending shows nothing', async () => {
      const p = await approved();
      const account = nuv.addAccount(p.entityId);
      await deliverAndDispatch('accounts.created', accountCreated(account));
      const detailsId = (await entity(p)).accountDetailsId!;
      const forged = {
        ...detailsUpdated(detailsId),
        status: 'active',
        account_number: nuban(),
      };
      const r = await deliverAndDispatch('account_details.updated', forged);
      expect(r.processingStatus).toBe('processed');
      const w = await wallet(p);
      expect(w.account).toBeNull();
      expect(w.accountNumberStatus).toBe('on_its_way');
    });

    it('two accounts.created at once request the details once', async () => {
      const p = await approved();
      const account = nuv.addAccount(p.entityId);
      const before = nuv.detailRequests.length;
      const ids = await Promise.all([
        deliver('accounts.created', accountCreated(account)),
        deliver('accounts.created', {
          ...accountCreated(account),
          entity_impact: { entity_id: p.entityId, total_accounts: 1 },
        }),
      ]);
      await Promise.all(ids.map((id) => dispatch(id)));
      // A delivery that lost the claim waits; run it again.
      for (const id of ids) {
        if ((await row(id)).processingStatus === 'pending') await dispatch(id);
      }
      expect(nuv.detailRequests.length).toBe(before + 1);
      for (const id of ids) {
        expect((await row(id)).processingStatus).toBe('processed');
      }
      expect((await entity(p)).accountDetailsId).not.toBeNull();
    });

    it('a lost details request is looked for before any second request, then adopted', async () => {
      const p = await approved();
      const account = nuv.addAccount(p.entityId);
      // The handler first lists the account's details (none yet), then
      // sends the request: Nuvion makes the details, but the answer is lost.
      standin.next({
        status: 200,
        body: {
          status: 'success',
          message: 'ok',
          data: {
            data: [],
            meta: { pagination: { has_next: false, next_cursor: null } },
          },
        },
      });
      standin.next(() => {
        nuv.details.set('01DETLOST0000000000000000', {
          id: '01DETLOST0000000000000000',
          entity_id: p.entityId,
          account_id: account.id,
          issuer: { name: 'NUV', code: 'NUV' },
          status: 'pending',
          asset_type: 'fiat',
          beneficiary_name: 'Ada Lovelace',
          currency: 'NGN',
          deleted: 0,
          created: Date.now(),
          updated: Date.now(),
        });
        return { status: 0, hangUp: true };
      });
      const id = await deliver('accounts.created', accountCreated(account));
      const first = await dispatch(id);
      expect(first.processingStatus).toBe('pending');
      expect((await entity(p)).accountDetailsStatus).toBe('requested');
      const posts = standin.seen.filter(
        (r) => r.method === 'POST' && r.path === '/account-details',
      ).length;
      const second = await dispatch(id);
      expect(second.processingStatus).toBe('processed');
      expect(
        standin.seen.filter(
          (r) => r.method === 'POST' && r.path === '/account-details',
        ).length,
      ).toBe(posts);
      expect((await entity(p)).accountDetailsId).toBe(
        '01DETLOST0000000000000000',
      );
    });

    it('the bank is the one Nuvion names for the account; the setting only when Nuvion names none', async () => {
      const p = await approved();
      const account = nuv.addAccount(p.entityId);
      await deliverAndDispatch('accounts.created', accountCreated(account));
      const detailsId = (await entity(p)).accountDetailsId!;
      nuv.activate(detailsId, nuban(), { code: '000000' });
      await deliverAndDispatch(
        'account_details.updated',
        detailsUpdated(detailsId),
      );
      const w = await wallet(p);
      expect(w.account?.bankName).toBe(BANK_NAME_SETTING);
      expect(w.account?.bankCode).toBe('000000');
    });

    it('details that are not this person, account or currency are a stop: nothing stored', async () => {
      const a = await approved();
      const b = await approved();
      const accA = nuv.addAccount(a.entityId);
      await deliverAndDispatch('accounts.created', accountCreated(accA));
      const detailsId = (await entity(a)).accountDetailsId!;
      nuv.activate(detailsId, nuban());
      // A's details named with B's entity: Nuvion does not know them for B.
      const r = await deliverAndDispatch('account_details.updated', {
        ...detailsUpdated(detailsId),
        entity_id: b.entityId,
      });
      expect(r.processingStatus).toBe('pending');
      expect(
        await prisma.fintavaWallet.count({
          where: { wawuUserId: { in: [a.id, b.id] } },
        }),
      ).toBe(0);
      // A second naira account for A: a stop.
      const second = nuv.addAccount(a.entityId);
      const s = await deliverAndDispatch(
        'accounts.created',
        accountCreated(second),
      );
      expect(s.processingStatus).toBe('failed');
      expect((await entity(a)).accountId).toBe(accA.id);
      // A dollar account is not this task's.
      const usd = nuv.addAccount(a.entityId, { currency: 'USD' });
      const u = await deliverAndDispatch(
        'accounts.created',
        accountCreated(usd),
      );
      expect(u.processingStatus).toBe('processed');
      expect((await entity(a)).accountId).toBe(accA.id);
    });
  });

  // ---------------------------------------------------------------------
  // Money in
  // ---------------------------------------------------------------------

  /** inflows.completed's `data` for a stand-in transfer. */
  const inflowData = (t: StandinTransfer) => ({ ...t });

  describe('money in by bank transfer lands in the ledger once', () => {
    it('credited once, after the transfer is read back; a replay and a second delivery are the same row', async () => {
      const { p, account, number } = await activePerson();
      const t = nuv.addInflow(account, {
        amount: 1_234_567,
        applicable_fee: 25,
      });
      const first = await deliverAndDispatch(
        'inflows.completed',
        inflowData(t),
      );
      expect(first.processingStatus).toBe('processed');
      expect(
        standin.seen.some(
          (r) =>
            r.method === 'GET' &&
            r.path === `/transfers/${t.id}` &&
            r.query.entity_id === p.entityId,
        ),
      ).toBe(true);
      let rows = await credits(p);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        direction: 'in',
        status: 'completed',
        category: 'top_up',
        accountNumber: number,
        provider: 'nuvion',
        fintavaTransactionId: t.id,
        fintavaReference: t.unique_reference,
        narration: 'Top up from my bank',
      });
      expect(rows[0].amountKobo).toBe(1_234_567n);
      expect(rows[0].feeKobo).toBe(25n);
      expect(rows[0].totalKobo).toBe(1_234_567n);

      // The same delivery again (same id): stored once by the receiver.
      // Another delivery of the same inflow (new id, new time): one row.
      await deliverAndDispatch('inflows.completed', inflowData(t));
      await deliverAndDispatch('inflows.completed', inflowData(t));
      rows = await credits(p);
      expect(rows).toHaveLength(1);
      expect(rows[0].amountKobo).toBe(1_234_567n);
    });

    it('five deliveries of one inflow handled at once: one row', async () => {
      const { p, account } = await activePerson();
      const t = nuv.addInflow(account, { amount: 50_000 });
      const ids = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          deliver('inflows.completed', inflowData(t), {
            timestamp: new Date(Date.now() - i * 1000).toISOString(),
          }),
        ),
      );
      const stored = await Promise.all(ids.map((id) => row(id)));
      await Promise.all(stored.map((r) => dispatcher.dispatch(r.id)));
      for (const id of ids) {
        expect((await row(id)).processingStatus).toBe('processed');
      }
      const rows = await credits(p);
      expect(rows).toHaveLength(1);
      expect(rows[0].amountKobo).toBe(50_000n);
    });

    it("found by NUV-08's sweep first, then delivered: still one row", async () => {
      const { p, account, number } = await activePerson();
      const t = nuv.addInflow(account, { amount: 77_700 });
      const read = readNuvionTransfer(t);
      if (!read.ok) throw new Error(read.why);
      const sweep = new NuvionInflowRecorder(
        prisma,
        new NuvionAccountsArea(provider.client),
        moduleRef.get(LedgerService, { strict: false }),
        provider.client.settings,
      );
      const found = await sweep.recordInflow(
        read.transfer,
        { wawuUserId: p.id, accountNumber: number },
        'history',
        null,
      );
      expect(found.created).toBe(true);
      const r = await deliverAndDispatch('inflows.completed', inflowData(t));
      expect(r.processingStatus).toBe('processed');
      expect(r.note).toMatch(/already credited/);
      const rows = await credits(p);
      expect(rows).toHaveLength(1);
      expect(rows[0].amountKobo).toBe(77_700n);
    });

    it('two different inflows are two rows', async () => {
      const { p, account } = await activePerson();
      await deliverAndDispatch(
        'inflows.completed',
        inflowData(nuv.addInflow(account, { amount: 100 })),
      );
      await deliverAndDispatch(
        'inflows.completed',
        inflowData(nuv.addInflow(account, { amount: 100 })),
      );
      expect(await credits(p)).toHaveLength(2);
    });
  });

  describe('nothing is credited unless Nuvion says successful and agrees', () => {
    it('Nuvion says processing: waits, nothing; once successful: credited once', async () => {
      const { p, account } = await activePerson();
      const t = nuv.addInflow(account, { status: 'processing' });
      const delivered = { ...inflowData(t), status: 'successful' };
      const id = await deliver('inflows.completed', delivered);
      expect((await dispatch(id)).processingStatus).toBe('pending');
      expect(await credits(p)).toHaveLength(0);
      t.status = 'successful';
      expect((await dispatch(id)).processingStatus).toBe('processed');
      expect(await credits(p)).toHaveLength(1);
    });

    it('Nuvion says failed or reversed: nothing credited', async () => {
      const { p, account } = await activePerson();
      for (const status of ['failed', 'reversed']) {
        const t = nuv.addInflow(account, { status });
        const r = await deliverAndDispatch('inflows.completed', {
          ...inflowData(t),
          status: 'successful',
        });
        expect(r.processingStatus).toBe('processed');
      }
      expect(await credits(p)).toHaveLength(0);
    });

    it('inflows.failed credits nothing; for an inflow already credited it is a stop for review', async () => {
      const { p, account } = await activePerson();
      const t = nuv.addInflow(account, { status: 'failed' });
      const r = await deliverAndDispatch('inflows.failed', inflowData(t));
      expect(r.processingStatus).toBe('processed');
      expect(await credits(p)).toHaveLength(0);

      const ok = nuv.addInflow(account);
      await deliverAndDispatch('inflows.completed', inflowData(ok));
      const late = await deliverAndDispatch('inflows.failed', {
        ...inflowData(ok),
        status: 'failed',
      });
      expect(late.processingStatus).toBe('failed');
      const rows = await credits(p);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('completed');
    });

    it("Nuvion's record differs from the delivery (amount, fee, currency, account): a stop, nothing credited", async () => {
      const { p, account } = await activePerson();
      const cases: Array<[Partial<StandinTransfer>, Partial<StandinTransfer>]> =
        [
          [{ amount: 1000 }, { amount: 100000 }],
          [{ applicable_fee: 10 }, { applicable_fee: 0 }],
          [{ currency: 'USD' }, { currency: 'USD' }],
          [{ currency: 'USD' }, {}],
        ];
      for (const [atNuvion, inDelivery] of cases) {
        const t = nuv.addInflow(account, atNuvion);
        const r = await deliverAndDispatch('inflows.completed', {
          ...inflowData(t),
          ...{ amount: 1000, applicable_fee: 0, currency: 'NGN' },
          ...inDelivery,
        });
        expect(r.processingStatus).toBe('failed');
      }
      expect(await credits(p)).toHaveLength(0);
    });

    it('a book transfer, a fraction of a kobo, or a transfer Nuvion does not know: nothing credited', async () => {
      const { p, account } = await activePerson();
      const book = nuv.addInflow(account, { payment_type: 'book-transfer' });
      expect(
        (await deliverAndDispatch('inflows.completed', inflowData(book)))
          .processingStatus,
      ).toBe('processed');
      const half = nuv.addInflow(account, { amount: 1000.5 });
      expect(
        (await deliverAndDispatch('inflows.completed', inflowData(half)))
          .processingStatus,
      ).toBe('failed');
      const ghost = { ...nuv.addInflow(account), id: standinId('01TRF') };
      expect(
        (await deliverAndDispatch('inflows.completed', ghost)).processingStatus,
      ).toBe('pending');
      expect(await credits(p)).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------
  // The balance
  // ---------------------------------------------------------------------

  describe("the balance is Nuvion's available, never a sum of our rows", () => {
    it("after credits, the balance is Nuvion's available: not the ledger's sum, not current", async () => {
      const { p, account } = await activePerson();
      await deliverAndDispatch(
        'inflows.completed',
        inflowData(nuv.addInflow(account, { amount: 300_000 })),
      );
      await deliverAndDispatch(
        'inflows.completed',
        inflowData(nuv.addInflow(account, { amount: 200_000 })),
      );
      const sum = (await credits(p)).reduce((s, r) => s + r.amountKobo, 0n);
      expect(sum).toBe(500_000n);
      account.balance = {
        available: 480_000,
        current: 530_000,
        overdraft_used: 0,
      };
      const r = await get<WalletBalanceView>('/wallet/balance', p.auth);
      expect(r.status).toBe(200);
      expect(r.body.data!.availableKobo).toBe(480_000);
      // Nuvion's figure moves; the answer moves with it, the rows do not.
      account.balance = { available: 7, current: 7, overdraft_used: 0 };
      expect(
        (await get<WalletBalanceView>('/wallet/balance', p.auth)).body.data!
          .availableKobo,
      ).toBe(7);
      const asked = standin.seen.filter(
        (s) => s.path === `/accounts/${account.id}`,
      );
      expect(asked.length).toBeGreaterThanOrEqual(2);
      expect(asked.every((s) => s.query.entity_id === p.entityId)).toBe(true);
    });

    it('Nuvion unreachable or answering a figure it cannot vouch for: 503, never 0', async () => {
      const { p, account } = await activePerson();
      standin.statusNext(503, {
        status: 'error',
        type: 'error_system_internal_error',
        message: 'x',
      });
      let r = await get<WalletBalanceView>('/wallet/balance', p.auth);
      expect(r.status).toBe(503);
      expect(r.body.reason?.code).toBe('provider_unreachable');
      expect(r.body.data).toBeNull();
      account.currency = 'USD';
      r = await get<WalletBalanceView>('/wallet/balance', p.auth);
      expect(r.status).toBe(503);
      account.currency = 'NGN';
    });
  });

  // ---------------------------------------------------------------------
  // Another person's
  // ---------------------------------------------------------------------

  describe("another person's account number or balance is never returned", () => {
    it("B sees only B's; Nuvion is asked with B's ids only; A's money never lands on B", async () => {
      const a = await activePerson();
      const b = await activePerson();
      a.account.balance = {
        available: 900_000,
        current: 900_000,
        overdraft_used: 0,
      };
      b.account.balance = {
        available: 1_000,
        current: 1_000,
        overdraft_used: 0,
      };
      const wb = await get<WalletView>('/wallet', b.p.auth);
      expect(wb.body.data!.account!.accountNumber).toBe(b.number);
      expect(wb.text).not.toContain(a.number);
      standin.reset();
      const bal = await get<WalletBalanceView>('/wallet/balance', b.p.auth);
      expect(bal.body.data!.availableKobo).toBe(1_000);
      expect(bal.text).not.toContain('900000');
      expect(standin.seen.map((s) => [s.path, s.query.entity_id])).toEqual([
        [`/accounts/${b.account.id}`, b.p.entityId],
      ]);

      // A delivery naming A's account under B's entity: nothing on either.
      const t = nuv.addInflow(a.account);
      const r = await deliverAndDispatch('inflows.completed', {
        ...inflowData(t),
        entity_id: b.p.entityId,
      });
      expect(r.processingStatus).toBe('failed');
      expect(await credits(a.p)).toHaveLength(0);
      expect(await credits(b.p)).toHaveLength(0);

      // Someone with no wallet: the gate's 409, no figure, nothing asked.
      const c = await approved();
      standin.reset();
      const none = await get<WalletBalanceView>('/wallet/balance', c.auth);
      expect(none.status).toBe(409);
      expect(none.body.data).toBeNull();
      expect(standin.seen).toEqual([]);
      const wc = await get<WalletView>('/wallet', c.auth);
      expect(wc.body.data!.account).toBeNull();
    });
  });

  describe('a server switched back to Fintava leaves Nuvion deliveries pending', () => {
    it('waits, sends nothing and writes nothing', async () => {
      const fintavaLike = {
        name: 'fintava',
        label: 'Fintava',
      } as WalletProvider;
      const refs = {
        get: (token: unknown) => {
          if (token === WALLET_PROVIDER) return fintavaLike;
          throw new Error('not here');
        },
      } as unknown as ModuleRef;
      const handler = new NuvionAccountsHandler(prisma, refs);
      standin.reset();
      const r = await handler.handle({
        id: randomUUID(),
        eventId: eventId(),
        event: 'inflows.completed',
        resourceId: null,
        entityId: null,
        data: {},
        receivedAt: new Date(),
        attempts: 1,
      });
      expect(r.outcome).toBe('wait');
      expect(standin.seen).toEqual([]);
    });
  });
});
