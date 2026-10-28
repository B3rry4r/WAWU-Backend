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
import { envelope, errorBody } from '../../../test/nuvion/nuvion-standin';
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
import { NuvionOpeningHandler } from '../handlers/opening.handler';
import { NuvionReconcileHandler } from '../handlers/reconcile.handler';
import type { NuvionDelivery } from '../handlers/nuvion-handler.interface';

/**
 * WALK4-FIX M-1 (money walk 4, 28 Oct 2026): an opened naira account whose details were never requested stayed "on its way"
 * for good when Nuvion's one `accounts.created` delivery was lost. The opening path now requests the details itself, right after
 * it records the account, and the sweep requests them for an account that has none after 5 minutes. Both are idempotent and safe
 * when servers race, and neither makes a second account. Real database, the real receiver, dispatcher, adapter, opening handler
 * and sweep, with NUV-04's stand-in behind them. Nothing reaches a Nuvion, Fintava or wawuafrica.com host.
 */

jest.setTimeout(120_000);

const RUN = `w4fx-${randomUUID().slice(0, 8)}`;
const SECRET = 'whsec_w4fix_details_0123456789abcdef';
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

describe('WALK4-FIX M-1: the account number is asked for by the opening path and by the sweep', () => {
  const wawuId = new WawuIdDouble();
  const standin = new NuvionStandin();
  const nuv = new NuvionAccountsStandin(standin);
  let guard: OutboundGuard;
  let moduleRef: TestingModule;
  let app: INestApplication;
  let prisma: PrismaService;
  let dispatcher: NuvionWebhookDispatcher;
  let reconcile: NuvionReconcileHandler;
  let opening: NuvionOpeningHandler;
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
        'nv_test_sk_W4FIXdetailsKEY000000000000',
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
    opening = moduleRef.get(NuvionOpeningHandler, { strict: false });
    installEntities();
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

  const ULID_TAIL = () => randomBytes(10).toString('hex').toUpperCase();

  /** The entity as Nuvion reads it back: approved, every check approved. */
  function entityBody(entityId: string) {
    return envelope({
      entity: {
        id: entityId,
        type: 'individual',
        status: 'approved',
        created: Date.now() - 60_000,
        updated: Date.now() - 1_000,
      },
      person: {
        id: `01PER${ULID_TAIL()}`.slice(0, 26),
        email: `${RUN}@example.test`,
        phonenumber: '+2348012345678',
      },
      identification: {
        verification_status: 'approved',
        document: { verification_status: 'approved' },
        proof_of_address: { verification_status: 'approved' },
        identity_numbers: [
          {
            type: 'BVN',
            value: '*******1111',
            verification_status: 'approved',
          },
          {
            type: 'NIN',
            value: '*******2222',
            verification_status: 'approved',
          },
        ],
      },
    });
  }

  /** `GET /entities/{id}` and `POST /accounts`, as Nuvion answers an approved person's opening. */
  function installEntities(): void {
    standin.on('GET', /^\/entities\/[^/]+$/, (req) => ({
      status: 200,
      body: entityBody(req.path.split('/')[2]),
    }));
    standin.on('POST', '/accounts', (req) => {
      const b = req.body as { entity_id: string };
      const account = nuv.addAccount(b.entity_id);
      return {
        status: 201,
        body: envelope(
          {
            account,
            entity_impact: { entity_id: b.entity_id, total_accounts: 1 },
          },
          'Account created successfully',
        ),
      };
    });
  }

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

  /** The opening handler's input: an `entities.updated` delivery for the person. */
  const openingDelivery = (p: Person): NuvionDelivery => ({
    id: 'd-w4fix',
    eventId: `${RUN}-open-${randomBytes(4).toString('hex')}`,
    event: 'entities.updated',
    resourceId: p.entityId,
    entityId: p.entityId,
    data: { id: p.entityId, type: 'individual', status: 'approved' },
    receivedAt: new Date(),
    attempts: 1,
  });

  /** Requests the stand-in has seen for this person's entity. */
  const sentFor = (method: string, path: string, p: Person) =>
    standin.seen.filter(
      (r) =>
        r.method === method &&
        r.path === path &&
        ((r.body as { entity_id?: string } | null)?.entity_id === p.entityId ||
          r.query.entity_id === p.entityId),
    );
  const detailPosts = (p: Person) =>
    sentFor('POST', '/account-details', p).length;
  const accountPosts = (p: Person) => sentFor('POST', '/accounts', p).length;

  const wallet = (p: Person) =>
    prisma.fintavaWallet.findUnique({ where: { wawuUserId: p.id } });
  /** Makes the row look as if it had been waiting this long. */
  const aged = (p: Person, minutes: number) =>
    prisma.$executeRaw`UPDATE "NuvionEntity" SET "updatedAt" = now() - (${minutes} * interval '1 minute') WHERE "wawuUserId" = ${p.id}`;

  /** An approved person whose naira account is recorded and whose details were never asked for (the walk's state). */
  async function accountWithoutDetails(): Promise<{
    p: Person;
    account: StandinAccount;
  }> {
    const p = await approved();
    const account = nuv.addAccount(p.entityId);
    await prisma.nuvionEntity.update({
      where: { wawuUserId: p.id },
      data: { accountId: account.id, currency: 'NGN' },
    });
    return { p, account };
  }

  // ---------------------------------------------------------------------
  // M-1 (a): the opening path asks for the details itself
  // ---------------------------------------------------------------------

  describe('the opening path requests the details right after it creates the account', () => {
    it('creates the account once and asks for its details once, with no accounts.created delivery at all', async () => {
      const p = await approved();
      const r = await opening.handle(openingDelivery(p));
      expect(r).toEqual({
        outcome: 'done',
        note: 'approved; naira account opened',
      });
      expect(accountPosts(p)).toBe(1);
      expect(detailPosts(p)).toBe(1);
      const e = await entity(p);
      expect(e.accountId).not.toBeNull();
      expect(e.accountDetailsId).not.toBeNull();
      expect(e.accountDetailsStatus).toBe('pending');
      // Nuvion makes the number later; its one delivery is lost; the sweep reads it.
      nuv.activate(e.accountDetailsId!, nuban());
      await aged(p, 6);
      await reconcile.rereadAccountDetails(new Date());
      expect(await wallet(p)).not.toBeNull();
      expect(
        await prisma.notification.count({
          where: { userWawuId: p.id, kind: 'wallet_ready' },
        }),
      ).toBe(1);
    });

    it('the accounts.created delivery that follows asks for nothing more', async () => {
      const p = await approved();
      await opening.handle(openingDelivery(p));
      const account = [...nuv.accounts.values()].find(
        (a) => a.entity_id === p.entityId,
      )!;
      const r = await deliverAndDispatch(
        'accounts.created',
        accountCreated(account),
      );
      expect(r.processingStatus).toBe('processed');
      expect(detailPosts(p)).toBe(1);
      expect(accountPosts(p)).toBe(1);
    });

    it('a replay, and three deliveries at once: one account, one request for details', async () => {
      const p = await approved();
      await Promise.all([
        opening.handle(openingDelivery(p)),
        opening.handle(openingDelivery(p)),
        opening.handle(openingDelivery(p)),
      ]);
      await opening.handle(openingDelivery(p));
      expect(accountPosts(p)).toBe(1);
      expect(detailPosts(p)).toBe(1);
      expect(
        [...nuv.accounts.values()].filter((a) => a.entity_id === p.entityId),
      ).toHaveLength(1);
    });

    it('race: the opening path and the accounts.created delivery at the same moment ask once', async () => {
      const p = await approved();
      // Nuvion has made the account; its list shows it, and its delivery is on the way.
      const account = nuv.addAccount(p.entityId);
      const id = await deliver('accounts.created', accountCreated(account));
      await Promise.all([opening.handle(openingDelivery(p)), dispatch(id)]);
      // The loser of the claim waits and is tried again; the second look asks for nothing.
      const after = await dispatch(id);
      expect(after.processingStatus).toBe('processed');
      expect(detailPosts(p)).toBe(1);
      expect(accountPosts(p)).toBe(0);
      expect((await entity(p)).accountDetailsId).not.toBeNull();
    });

    it('Nuvion refusing the request does not undo the account or fail the opening: the sweep asks again later', async () => {
      const p = await approved();
      const real = nuv.detailRequests.length;
      standin.on('POST', '/account-details', (req) => {
        nuv.detailRequests.push(req.body);
        return {
          status: 400,
          body: errorBody('error_validation_error', 'Refused.'),
        };
      });
      const r = await opening.handle(openingDelivery(p));
      expect(r.outcome).toBe('done');
      expect((await entity(p)).accountId).not.toBeNull();
      expect((await entity(p)).accountDetailsId).toBeNull();
      expect(nuv.detailRequests.length).toBeGreaterThan(real);
      // Back to the stand-in's own route for the next ask.
      nuv.install();
      installEntities();
      await aged(p, 6);
      const report = await reconcile.rereadAccountDetails(new Date());
      expect(report?.checked).toBeGreaterThanOrEqual(1);
      expect((await entity(p)).accountDetailsId).not.toBeNull();
      expect(accountPosts(p)).toBe(1);
    });
  });

  // ---------------------------------------------------------------------
  // M-1 (b): the sweep asks for details an account has none of
  // ---------------------------------------------------------------------

  describe('the sweep requests the details of an account that has none and is older than 5 minutes', () => {
    it('leaves a young account alone, asks for an older one once, and never again', async () => {
      const { p } = await accountWithoutDetails();
      await aged(p, 2);
      await reconcile.rereadAccountDetails(new Date());
      expect(detailPosts(p)).toBe(0);
      expect((await entity(p)).accountDetailsId).toBeNull();

      await aged(p, 6);
      const first = await reconcile.rereadAccountDetails(new Date());
      expect(first?.requested).toBeGreaterThanOrEqual(1);
      expect(detailPosts(p)).toBe(1);
      expect(await entity(p)).toMatchObject({
        accountDetailsStatus: 'pending',
      });
      expect((await entity(p)).accountDetailsId).not.toBeNull();

      await aged(p, 60);
      await reconcile.rereadAccountDetails(new Date());
      await reconcile.sweep(new Date());
      expect(detailPosts(p)).toBe(1);
    });

    it('never makes an account: nothing is sent to POST /accounts', async () => {
      const { p } = await accountWithoutDetails();
      await aged(p, 10);
      await reconcile.sweep(new Date());
      expect(accountPosts(p)).toBe(0);
      expect(detailPosts(p)).toBe(1);
    });

    it('adopts details Nuvion already holds for the account instead of asking again', async () => {
      const { p, account } = await accountWithoutDetails();
      const made = standinId('01DET');
      nuv.details.set(made, {
        id: made,
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
      await aged(p, 8);
      await reconcile.rereadAccountDetails(new Date());
      expect(detailPosts(p)).toBe(0);
      expect((await entity(p)).accountDetailsId).toBe(made);
    });

    it('finds the number too when the details turn active before the first look: wallet and one notice', async () => {
      const { p, account } = await accountWithoutDetails();
      await aged(p, 8);
      await reconcile.rereadAccountDetails(new Date());
      const e = await entity(p);
      nuv.activate(e.accountDetailsId!, nuban());
      await aged(p, 8);
      await reconcile.rereadAccountDetails(new Date());
      expect(await wallet(p)).not.toBeNull();
      expect(account.id).toBe(e.accountId);
      expect(
        await prisma.notification.count({
          where: { userWawuId: p.id, kind: 'wallet_ready' },
        }),
      ).toBe(1);
    });

    it('race: two sweeps and the accounts.created delivery together ask once', async () => {
      const { p, account } = await accountWithoutDetails();
      await aged(p, 10);
      const id = await deliver('accounts.created', accountCreated(account));
      await Promise.all([
        reconcile.rereadAccountDetails(new Date()),
        reconcile.rereadAccountDetails(new Date()),
        dispatch(id),
      ]);
      await dispatch(id);
      expect(detailPosts(p)).toBe(1);
      expect((await entity(p)).accountDetailsId).not.toBeNull();
    });

    it('a request Nuvion refuses is counted as unread, the claim is let go, and the next sweep asks again', async () => {
      const { p } = await accountWithoutDetails();
      standin.on('POST', '/account-details', (req) => {
        nuv.detailRequests.push(req.body);
        return {
          status: 400,
          body: errorBody('error_validation_error', 'Refused.'),
        };
      });
      await aged(p, 10);
      const first = await reconcile.rereadAccountDetails(new Date());
      expect(first?.unreadable).toBeGreaterThanOrEqual(1);
      expect(await entity(p)).toMatchObject({
        accountDetailsId: null,
        accountDetailsStatus: null,
      });
      nuv.install();
      installEntities();
      await aged(p, 10);
      await reconcile.rereadAccountDetails(new Date());
      expect((await entity(p)).accountDetailsId).not.toBeNull();
    });
  });
});
