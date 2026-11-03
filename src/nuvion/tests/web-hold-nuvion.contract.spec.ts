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

/**
 * WEB-HOLD (R-126): the moment Nuvion makes a person's account number active and the wallet row is written, every piece held
 * for that person goes live, once, in the same transaction. A pending piece nobody approved, a rejected piece and another
 * person's held piece are left alone. Same set-up as wallet-ready-notice.contract.spec.ts: Nuvion's signed deliveries reach
 * the real receiver and dispatcher with the stand-in behind the real adapter. Nothing here reaches a Nuvion or wawuafrica.com host.
 */

jest.setTimeout(120_000);

const RUN = `whold-${randomUUID().slice(0, 8)}`;
const SECRET = 'whsec_whold_0123456789abcdef';
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

describe('WEB-HOLD: pieces held for a wallet go live when it is recorded (Nuvion)', () => {
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
        'nv_test_sk_WholdKEY0000000000000000000',
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
      await prisma.contentPiece.deleteMany({
        where: { creatorWawuId: { in: people } },
      });
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

  const piece = (creator: string, extra: Record<string, unknown>) =>
    prisma.contentPiece.create({
      data: {
        slug: `whold-${randomUUID()}`,
        creatorWawuId: creator,
        contentType: 'video',
        title: 'WEB-HOLD nuvion',
        description: 'spec',
        category: 'business_entrepreneurship',
        accessType: 'free',
        price: 0,
        previewAssetUrl: 'x',
        fullAssetUrl: 'x',
        status: 'pending',
        ...extra,
      } as never,
    });

  it('a Nuvion wallet recorded releases the held pieces once and touches nothing else', async () => {
    const { p, detailsId } = await pending();
    const other = await approved();
    const held = await piece(p.id, {
      uploadedVia: 'site',
      heldForWalletAt: new Date(),
    });
    const waitingReview = await piece(p.id, { uploadedVia: 'site' });
    const rejected = await piece(p.id, {
      uploadedVia: 'site',
      status: 'rejected',
    });
    const othersHeld = await piece(other.id, {
      uploadedVia: 'site',
      heldForWalletAt: new Date(),
    });
    const state = async (id: string) =>
      prisma.contentPiece.findUniqueOrThrow({ where: { id } });

    // Not active yet: nothing moves.
    expect((await state(held.id)).status).toBe('pending');

    nuv.activate(detailsId, nuban());
    const active = await deliverAndDispatch(
      'account_details.updated',
      detailsUpdated(detailsId),
    );
    expect(active.processingStatus).toBe('processed');

    expect(await state(held.id)).toMatchObject({
      status: 'live',
      heldForWalletAt: null,
    });
    expect((await state(waitingReview.id)).status).toBe('pending');
    expect((await state(rejected.id)).status).toBe('rejected');
    expect(await state(othersHeld.id)).toMatchObject({ status: 'pending' });
    expect((await state(othersHeld.id)).heldForWalletAt).not.toBeNull();

    // The same delivery again changes nothing.
    await dispatch(
      await deliver('account_details.updated', detailsUpdated(detailsId)),
    );
    expect((await state(held.id)).status).toBe('live');
  });
});
