import { randomBytes, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import {
  type INestApplication,
  type LoggerService,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import {
  NuvionAccountsStandin,
  type StandinAccount,
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
import { MoneyModule } from '../../money/money.module';
import { WALLET_PROVIDER } from '../../wallet-provider/wallet-provider.interface';
import { NuvionClient } from '../nuvion-client';
import { NuvionWalletProvider } from '../nuvion-wallet-provider';
import { signNuvionDelivery } from '../webhook/nuvion-signature';
import { NuvionWebhookDispatcher } from '../webhook/nuvion-webhook-dispatcher.service';
import { NuvionWebhookModule } from '../webhook/nuvion-webhook.module';
import { NuvionReconcileHandler } from '../handlers/reconcile.handler';

/**
 * NUVION-FIX 9.1 and 9.2 (Nuvion's answers, 27 Oct 2026): account details are made later (5 to 30 minutes) and Nuvion stops
 * retrying a delivery after 15, so a lost `account_details.updated` must not leave "on its way" forever: the sweep re-reads
 * details still requested or pending after 5 minutes, and a create response is read back before it is recorded. Real database,
 * the real receiver, dispatcher, adapter and sweep, with NUV-04's stand-in behind them. Nothing reaches a Nuvion, Fintava or
 * wawuafrica.com host.
 */

jest.setTimeout(120_000);

const RUN = `nvfx-${randomUUID().slice(0, 8)}`;
const SECRET = 'whsec_nvfix_details_0123456789abcdef';
const HOOK = '/api/hub/webhooks/nuvion';

class QuietLogger implements LoggerService {
  log() {}
  error() {}
  warn() {}
  debug() {}
  verbose() {}
  fatal() {}
}

let seq = 0;
function nuban(): string {
  seq += 1;
  return `8${String(Date.now()).slice(-6)}${String(seq).padStart(3, '0')}`;
}

interface Person {
  id: string;
  entityId: string;
}

describe('NUVION-FIX: account details are read again, and a create answer is read back', () => {
  const wawuId = new WawuIdDouble();
  const standin = new NuvionStandin();
  const nuv = new NuvionAccountsStandin(standin);
  let guard: OutboundGuard;
  let moduleRef: TestingModule;
  let app: INestApplication;
  let prisma: PrismaService;
  let dispatcher: NuvionWebhookDispatcher;
  let reconcile: NuvionReconcileHandler;
  const saved: Record<string, string | undefined> = {};
  const people: string[] = [];

  const ENV: Record<string, string> = {
    WALLET_PROVIDER: 'nuvion',
    NUVION_WEBHOOK_SECRET: SECRET,
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
    const provider = new NuvionWalletProvider(
      new NuvionClient(
        standin.settings(),
        'nv_test_sk_NVFIXdetailsKEY00000000000',
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
    reconcile = moduleRef.get(NuvionReconcileHandler, { strict: false });
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.notification.deleteMany({
        where: { userWawuId: { in: people } },
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

  /** A person Nuvion has approved, as NUV-02 leaves them. */
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
    return { id, entityId };
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
    id: string = eventId(),
  ): Promise<string> {
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
    return id;
  }

  const row = (id: string) =>
    prisma.nuvionWebhookEvent.findUniqueOrThrow({ where: { eventId: id } });

  /** Hands one stored delivery to its handlers now (the 30 s sweep's step). */
  async function dispatch(id: string) {
    const r = await row(id);
    await prisma.nuvionWebhookEvent.update({
      where: { id: r.id },
      data: { nextAttemptAt: null },
    });
    await dispatcher.dispatch(r.id);
    return row(id);
  }

  const deliverAndDispatch = async (event: string, data: unknown) =>
    dispatch(await deliver(event, data));

  const entity = (p: Person) =>
    prisma.nuvionEntity.findUniqueOrThrow({ where: { wawuUserId: p.id } });

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
  });

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

  /** Brings a person to pending details; answers their account and details id. */
  async function pending(): Promise<{
    p: Person;
    account: StandinAccount;
    detailsId: string;
  }> {
    const p = await approved();
    const account = nuv.addAccount(p.entityId);
    const r = await deliverAndDispatch(
      'accounts.created',
      accountCreated(account),
    );
    expect(r.processingStatus).toBe('processed');
    return { p, account, detailsId: (await entity(p)).accountDetailsId! };
  }

  // ---------------------------------------------------------------------
  // 9.1 The sweep
  // ---------------------------------------------------------------------

  const wallet = (p: Person) =>
    prisma.fintavaWallet.findUnique({ where: { wawuUserId: p.id } });
  /** Makes the row look as if it had been waiting this long. */
  const aged = (p: Person, minutes: number) =>
    prisma.$executeRaw`UPDATE "NuvionEntity" SET "updatedAt" = now() - (${minutes} * interval '1 minute') WHERE "wawuUserId" = ${p.id}`;
  const posts = () =>
    standin.seen.filter(
      (r) => r.method === 'POST' && r.path === '/account-details',
    ).length;

  describe('9.1: details still pending after 5 minutes are read again', () => {
    it('a lost account_details.updated is found by the sweep: the number is recorded once and the person is told once', async () => {
      const { p, detailsId } = await pending();
      expect((await entity(p)).accountDetailsStatus).toBe('pending');
      // Nuvion makes the number active, and its delivery never arrives.
      const number = nuban();
      nuv.activate(detailsId, number);

      // Young: left alone.
      await aged(p, 2);
      await reconcile.rereadAccountDetails(new Date());
      expect(await wallet(p)).toBeNull();
      expect((await entity(p)).accountDetailsStatus).toBe('pending');

      await aged(p, 6);
      const first = await reconcile.rereadAccountDetails(new Date());
      expect(first?.recorded).toBeGreaterThanOrEqual(1);
      expect(await entity(p)).toMatchObject({
        accountDetailsStatus: 'active',
        accountNumber: number,
      });
      expect(await wallet(p)).toMatchObject({ accountNumber: number });
      const found = await prisma.notification.findMany({
        where: { userWawuId: p.id, kind: 'wallet_ready' },
      });
      expect(found).toHaveLength(1);

      // Again, and a late real delivery after it: nothing changes, nothing more is sent.
      await aged(p, 30);
      await reconcile.rereadAccountDetails(new Date());
      await deliverAndDispatch(
        'account_details.updated',
        detailsUpdated(detailsId),
      );
      expect(
        await prisma.notification.count({
          where: { userWawuId: p.id, kind: 'wallet_ready' },
        }),
      ).toBe(1);
    });

    it('details still pending at Nuvion stay pending, are read again next time, and are not requested again', async () => {
      const { p } = await pending();
      const before = posts();
      await aged(p, 10);
      const r = await reconcile.rereadAccountDetails(new Date());
      expect(r?.checked).toBeGreaterThanOrEqual(1);
      expect((await entity(p)).accountDetailsStatus).toBe('pending');
      expect(await wallet(p)).toBeNull();
      await reconcile.rereadAccountDetails(new Date());
      expect(posts()).toBe(before);
    });

    it('a request whose answer was lost (status requested, no id kept) is found by listing and adopted, never sent again', async () => {
      const p = await approved();
      const account = nuv.addAccount(p.entityId);
      await prisma.nuvionEntity.update({
        where: { wawuUserId: p.id },
        data: {
          accountId: account.id,
          currency: 'NGN',
          accountDetailsStatus: 'requested',
        },
      });
      // Nuvion did make the details.
      nuv.details.set('01DETSWEEP00000000000000A', {
        id: '01DETSWEEP00000000000000A',
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
      const before = posts();
      await aged(p, 8);
      await reconcile.rereadAccountDetails(new Date());
      expect(await entity(p)).toMatchObject({
        accountDetailsId: '01DETSWEEP00000000000000A',
        accountDetailsStatus: 'pending',
      });
      expect(posts()).toBe(before);
    });

    it('a request Nuvion lists nothing for, past the resend window, is asked again by the sweep: it lists first, claims, and makes no account', async () => {
      // WALK4-FIX patch round 1, LEAD RULING: this assertion pinned NUVION-FIX 9.1's "the sweep reads, it does not ask". A request that
      // died with an unknown outcome (timeout, 5xx, no connection) leaves a `requested` claim and no details; if nothing re-asked,
      // the account would be stranded. The sweep now takes a `requested` row with no details id once it is past the resend window.
      const p = await approved();
      const account = nuv.addAccount(p.entityId);
      await prisma.nuvionEntity.update({
        where: { wawuUserId: p.id },
        data: {
          accountId: account.id,
          currency: 'NGN',
          accountDetailsStatus: 'requested',
        },
      });
      const before = posts();
      await aged(p, 8);
      await reconcile.rereadAccountDetails(new Date());
      expect(posts()).toBe(before + 1);
      expect(await entity(p)).toMatchObject({
        accountDetailsStatus: 'pending',
      });
      expect((await entity(p)).accountDetailsId).not.toBeNull();
      // Again: the details exist now, so nothing is asked twice.
      await aged(p, 30);
      await reconcile.rereadAccountDetails(new Date());
      expect(posts()).toBe(before + 1);
    });

    it("the whole sweep (the 15 minute clock's pass) does it too", async () => {
      const { p, detailsId } = await pending();
      nuv.activate(detailsId, nuban());
      await aged(p, 9);
      const report = await reconcile.sweep(new Date());
      expect(report).not.toBeNull();
      expect(await wallet(p)).not.toBeNull();
    });
  });

  // ---------------------------------------------------------------------
  // 9.2 Read back before recording
  // ---------------------------------------------------------------------

  describe('9.2: a create answer is read back before it is recorded', () => {
    /** The account's details list is empty (as Nuvion has none yet), then the POST answers with `claim`. */
    function createAnswers(
      p: Person,
      account: StandinAccount,
      claim: (real: string) => Record<string, unknown>,
      makeReal: boolean,
    ) {
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
        const real = standinId('01DET');
        if (makeReal) {
          nuv.details.set(real, {
            id: real,
            entity_id: p.entityId,
            account_id: account.id,
            issuer: { name: 'NUV', short_name: 'NUV', code: 'NUV' },
            status: 'pending',
            asset_type: 'fiat',
            beneficiary_name: 'Ada Lovelace',
            currency: 'NGN',
            deleted: 0,
            created: Date.now(),
            updated: Date.now(),
          });
        }
        return {
          status: 201,
          body: {
            status: 'success',
            message: 'Account detail created successfully',
            data: { account_details: claim(real) },
          },
        };
      });
    }

    it('an answer that says active while the record says pending records pending: no number, no wallet, no notice', async () => {
      const p = await approved();
      const account = nuv.addAccount(p.entityId);
      createAnswers(
        p,
        account,
        (real) => ({
          id: real,
          entity_id: p.entityId,
          account_id: account.id,
          status: 'active',
          account_number: '9999999999',
          issuer: {
            name: 'Nuvion MFB',
            code: '090999',
            scheme: 'cbn_bank_code',
          },
          beneficiary_name: 'Ada Lovelace',
          currency: 'NGN',
          deleted: 0,
        }),
        true,
      );
      const id = await deliver('accounts.created', accountCreated(account));
      const r = await dispatch(id);
      expect(r.processingStatus).toBe('processed');
      expect(await entity(p)).toMatchObject({
        accountDetailsStatus: 'pending',
        accountNumber: null,
      });
      expect((await entity(p)).accountDetailsId).not.toBeNull();
      expect(await wallet(p)).toBeNull();
      expect(
        await prisma.notification.count({
          where: { userWawuId: p.id, kind: 'wallet_ready' },
        }),
      ).toBe(0);
      const read = standin.seen.filter(
        (q) =>
          q.method === 'GET' &&
          /^\/account-details\/[A-Za-z0-9]+$/.test(q.path),
      );
      expect(read.length).toBeGreaterThan(0);
    });

    it('an answer that cannot be read back records nothing: the claim stays and the delivery waits', async () => {
      const p = await approved();
      const account = nuv.addAccount(p.entityId);
      createAnswers(
        p,
        account,
        (real) => ({
          id: real,
          entity_id: p.entityId,
          account_id: account.id,
          status: 'active',
          account_number: '9999999998',
          issuer: {
            name: 'Nuvion MFB',
            code: '090999',
            scheme: 'cbn_bank_code',
          },
          beneficiary_name: 'Ada Lovelace',
          currency: 'NGN',
          deleted: 0,
        }),
        false,
      );
      const id = await deliver('accounts.created', accountCreated(account));
      const r = await dispatch(id);
      expect(r.processingStatus).toBe('pending');
      expect(await entity(p)).toMatchObject({
        accountDetailsId: null,
        accountDetailsStatus: 'requested',
        accountNumber: null,
      });
      expect(await wallet(p)).toBeNull();
    });
  });
});
