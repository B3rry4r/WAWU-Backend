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
import { NOTIFICATION_CATEGORY } from '../../notification/notification-event';
import { WALLET_PROVIDER } from '../../wallet-provider/wallet-provider.interface';
import { NuvionClient } from '../nuvion-client';
import { NuvionWalletProvider } from '../nuvion-wallet-provider';
import { signNuvionDelivery } from '../webhook/nuvion-signature';
import { NuvionWebhookDispatcher } from '../webhook/nuvion-webhook-dispatcher.service';
import { NuvionWebhookModule } from '../webhook/nuvion-webhook.module';

/**
 * WALLET-40 (owner answer 31, 17 Oct 2026; BACKEND_GAPS G-823) on a real
 * database: when Nuvion makes a person's account number active, they get ONE
 * "Your account number is ready" notice, however Nuvion's deliveries repeat,
 * race or arrive out of order, and none when no wallet is recorded. Nuvion's
 * signed deliveries go to the real receiver and the real dispatcher, with
 * NUV-04's stand-in behind the real adapter (as nuvion-accounts.contract.spec.ts).
 * Nothing here reaches a Nuvion, Fintava or wawuafrica.com host.
 */

jest.setTimeout(120_000);

const RUN = `w40n-${randomUUID().slice(0, 8)}`;
const SECRET = 'whsec_w40_ready_notice_0123456789abcdef';
const HOOK = '/api/hub/webhooks/nuvion';
const TITLE = 'Your account number is ready';
const BODY = 'Tap to see it in your wallet.';

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

describe('WALLET-40: the account number is ready (Nuvion)', () => {
  const wawuId = new WawuIdDouble();
  const standin = new NuvionStandin();
  const nuv = new NuvionAccountsStandin(standin);
  let guard: OutboundGuard;
  let moduleRef: TestingModule;
  let app: INestApplication;
  let prisma: PrismaService;
  let dispatcher: NuvionWebhookDispatcher;
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
        'nv_test_sk_W40readyKEY000000000000000',
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

  const notices = (p: Person) =>
    prisma.notification.findMany({
      where: { userWawuId: p.id, kind: 'wallet_ready' },
    });

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
  // The notice
  // ---------------------------------------------------------------------

  describe('the number going active tells the person once', () => {
    it('says nothing while the number is pending, then one notice in plain words when it is active', async () => {
      const { p, detailsId } = await pending();
      // The approval, the account and pending details: not news yet.
      expect(await notices(p)).toEqual([]);
      const d = nuv.details.get(detailsId)!;
      const waiting = await deliverAndDispatch('account_details.created', {
        account_details: { ...d },
      });
      expect(waiting.processingStatus).toBe('processed');
      expect(await notices(p)).toEqual([]);

      const number = nuban();
      nuv.activate(detailsId, number);
      const active = await deliverAndDispatch(
        'account_details.updated',
        detailsUpdated(detailsId),
      );
      expect(active.processingStatus).toBe('processed');

      const found = await notices(p);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        userWawuId: p.id,
        kind: 'wallet_ready',
        title: TITLE,
        body: BODY,
        tone: 'success',
        read: false,
        amount: null,
        creditsCount: null,
        actionLabel: null,
        actionHref: null,
        imageUrl: null,
        campaignId: null,
      });
      // The lock screen shows these words: no number, no name, no bank, no dash.
      const words = `${found[0].title} ${found[0].body}`;
      expect(words).not.toContain(number);
      expect(words).not.toMatch(/\d{4,}/);
      expect(words).not.toMatch(new RegExp('[\\u2014\\u2013]'));
      expect(words).not.toContain('Ada');
      expect(words).not.toContain('Nuvion');
      // The wallet row and the notice were written together.
      expect(
        await prisma.fintavaWallet.findUniqueOrThrow({
          where: { wawuUserId: p.id },
        }),
      ).toMatchObject({ accountNumber: number, provider: 'nuvion' });
      // The list files it under Money.
      expect(NOTIFICATION_CATEGORY.wallet_ready).toBe('money');
    });

    it('a repeated delivery (the same event posted again, a second event for the same details, details.created after updated) adds no second notice', async () => {
      const { p, detailsId } = await pending();
      nuv.activate(detailsId, nuban());
      const first = await deliver(
        'account_details.updated',
        detailsUpdated(detailsId),
      );
      expect((await dispatch(first)).processingStatus).toBe('processed');
      expect(await notices(p)).toHaveLength(1);

      // Nuvion posts the very same event again (the receiver keeps one row).
      await deliver(
        'account_details.updated',
        detailsUpdated(detailsId),
        first,
      );
      await dispatch(first);
      // A new event for the same details, twice over.
      for (let i = 0; i < 2; i += 1) {
        const again = await deliverAndDispatch(
          'account_details.updated',
          detailsUpdated(detailsId),
        );
        expect(again.processingStatus).toBe('processed');
      }
      // And account_details.created for details that are by now active.
      const created = await deliverAndDispatch('account_details.created', {
        account_details: { ...nuv.details.get(detailsId)! },
      });
      expect(created.processingStatus).toBe('processed');
      expect(await notices(p)).toHaveLength(1);
      expect(
        await prisma.fintavaWallet.count({ where: { wawuUserId: p.id } }),
      ).toBe(1);
    });

    it('eight deliveries of the active number handled at the same time (two servers and more) make one wallet and one notice', async () => {
      const { p, detailsId } = await pending();
      nuv.activate(detailsId, nuban());
      const ids: string[] = [];
      for (let i = 0; i < 8; i += 1) {
        ids.push(
          await deliver(
            i % 2 === 0 ? 'account_details.updated' : 'account_details.created',
            i % 2 === 0
              ? detailsUpdated(detailsId)
              : { account_details: { ...nuv.details.get(detailsId)! } },
          ),
        );
      }
      for (const id of ids) {
        await prisma.nuvionWebhookEvent.updateMany({
          where: { eventId: id },
          data: { nextAttemptAt: null },
        });
      }
      const rows = await Promise.all(ids.map((id) => row(id)));
      await Promise.all(rows.map((r) => dispatcher.dispatch(r.id)));
      expect(await notices(p)).toHaveLength(1);
      expect(
        await prisma.fintavaWallet.count({ where: { wawuUserId: p.id } }),
      ).toBe(1);
      // Every one of them ended well, none was kept for review.
      const after = await Promise.all(ids.map((id) => row(id)));
      expect(after.map((r) => r.processingStatus)).not.toContain('failed');
    });

    it('out of order: the active details arrive before the account, and the account after them still adds one notice only', async () => {
      const p = await approved();
      const account = nuv.addAccount(p.entityId);
      // Nuvion made the details already; their event comes first.
      const detailsId = standinId('01DET');
      nuv.details.set(detailsId, {
        id: detailsId,
        entity_id: p.entityId,
        account_id: account.id,
        issuer: { code: '090999', name: 'Nuvion MFB' },
        status: 'active',
        asset_type: 'fiat',
        beneficiary_name: 'Ada Lovelace',
        currency: 'NGN',
        account_number: nuban(),
        deleted: 0,
        created: Date.now(),
        updated: Date.now(),
      });
      const early = await deliverAndDispatch(
        'account_details.updated',
        detailsUpdated(detailsId),
      );
      expect(early.processingStatus).toBe('processed');
      expect(await notices(p)).toHaveLength(1);

      const late = await deliverAndDispatch(
        'accounts.created',
        accountCreated(account),
      );
      expect(late.processingStatus).toBe('processed');
      expect(await notices(p)).toHaveLength(1);
    });

    it('accounts.created that finds the details already active is the delivery that tells the person, once', async () => {
      const p = await approved();
      const account = nuv.addAccount(p.entityId);
      const detailsId = standinId('01DET');
      nuv.details.set(detailsId, {
        id: detailsId,
        entity_id: p.entityId,
        account_id: account.id,
        issuer: { code: '090999', name: 'Nuvion MFB' },
        status: 'active',
        asset_type: 'fiat',
        beneficiary_name: 'Ada Lovelace',
        currency: 'NGN',
        account_number: nuban(),
        deleted: 0,
        created: Date.now(),
        updated: Date.now(),
      });
      const r = await deliverAndDispatch(
        'accounts.created',
        accountCreated(account),
      );
      expect(r.processingStatus).toBe('processed');
      expect(await notices(p)).toHaveLength(1);
      await deliverAndDispatch(
        'account_details.updated',
        detailsUpdated(detailsId),
      );
      expect(await notices(p)).toHaveLength(1);
    });

    it('each person is told about their own wallet only', async () => {
      const a = await pending();
      const b = await pending();
      nuv.activate(a.detailsId, nuban());
      await deliverAndDispatch(
        'account_details.updated',
        detailsUpdated(a.detailsId),
      );
      expect(await notices(a.p)).toHaveLength(1);
      expect(await notices(b.p)).toEqual([]);
      nuv.activate(b.detailsId, nuban());
      await deliverAndDispatch(
        'account_details.updated',
        detailsUpdated(b.detailsId),
      );
      expect(await notices(b.p)).toHaveLength(1);
      expect(await notices(a.p)).toHaveLength(1);
    });
  });

  describe('no wallet, no notice', () => {
    it('details that are not this person, a person who already holds another wallet, and an opening that never got a number tell nobody', async () => {
      const a = await pending();
      const b = await pending();
      nuv.activate(a.detailsId, nuban());
      // A's details named with B's entity: a stop, nothing stored.
      const stopped = await deliverAndDispatch('account_details.updated', {
        ...detailsUpdated(a.detailsId),
        entity_id: b.p.entityId,
      });
      expect(stopped.processingStatus).toBe('pending');
      expect(await notices(a.p)).toEqual([]);
      expect(await notices(b.p)).toEqual([]);

      // A person who already has a wallet from elsewhere: a stop (review).
      const held = await pending();
      await prisma.fintavaWallet.create({
        data: {
          wawuUserId: held.p.id,
          customerId: `${RUN}-cust-${randomBytes(4).toString('hex')}`,
          walletId: `${RUN}-wal-${randomBytes(4).toString('hex')}`,
          accountNumber: nuban(),
          provider: 'fintava',
        },
      });
      nuv.activate(held.detailsId, nuban());
      const r = await deliverAndDispatch(
        'account_details.updated',
        detailsUpdated(held.detailsId),
      );
      expect(r.processingStatus).toBe('failed');
      expect(await notices(held.p)).toEqual([]);

      // An opening whose check was refused never gets an account at all.
      const refused = await approved();
      await prisma.nuvionEntity.update({
        where: { wawuUserId: refused.id },
        data: { status: 'rejected' },
      });
      await prisma.fintavaWalletOpening.update({
        where: { wawuUserId: refused.id },
        data: { state: 'failed', failure: 'rejected' },
      });
      expect(await notices(refused)).toEqual([]);
      expect(
        await prisma.fintavaWallet.count({ where: { wawuUserId: refused.id } }),
      ).toBe(0);
    });
  });
});
