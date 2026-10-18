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
  standinId,
} from '../../../test/nuvion/accounts-standin';
import { NuvionStandin } from '../../../test/nuvion/nuvion-standin';
import {
  guardOutbound,
  type OutboundGuard,
} from '../../../test/nuvion/outbound-guard';
import { NuvionPayoutsStandin } from '../../../test/nuvion/payouts-standin';
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
import { nuvionWalletId } from '../areas/accounts';
import { PrismaNuvionBookStore } from '../areas/book-store';
import { NuvionClient } from '../nuvion-client';
import { NuvionWalletProvider, nuvionAreas } from '../nuvion-wallet-provider';
import { signNuvionDelivery } from '../webhook/nuvion-signature';
import {
  NUVION_DISPATCH,
  NuvionWebhookDispatcher,
} from '../webhook/nuvion-webhook-dispatcher.service';
import { NuvionWebhookModule } from '../webhook/nuvion-webhook.module';

/**
 * FIX-86 on the Nuvion stand-in: a burst of bank sends (a payday, an
 * event's ticket sales) each settle at the stand-in, each `outflows.completed`
 * is posted to the real receiver and stored, and ONE sweep of the real
 * dispatcher hands every one of them to the NUV-06 handler, so the ledger
 * matches the stand-in after one tick instead of after one tick per 20.
 *
 * Nothing here reaches a Nuvion, Fintava or wawuafrica.com host: every
 * connection but loopback is refused (outbound-guard.ts).
 */

jest.setTimeout(180_000);

const BURST = 120;
const RUN = `fix86b-${randomUUID().slice(0, 8)}`;
const SECRET = 'whsec_fix86_burst_0123456789abcdef';
const HOOK = '/api/hub/webhooks/nuvion';
const NUMBER = '0690000031';
const HOLDER = 'Chidinma Okafor';

class QuietLogger implements LoggerService {
  log() {}
  error() {}
  warn() {}
  debug() {}
  verbose() {}
  fatal() {}
}

describe('FIX-86: a burst of settled sends is all in the ledger after one sweep', () => {
  const wawuId = new WawuIdDouble();
  const standin = new NuvionStandin();
  const nuv = new NuvionAccountsStandin(standin);
  const pay = new NuvionPayoutsStandin(standin, nuv);
  let guard: OutboundGuard;
  let moduleRef: TestingModule;
  let app: INestApplication;
  let prisma: PrismaService;
  let dispatcher: NuvionWebhookDispatcher;
  let provider: NuvionWalletProvider;
  const saved: Record<string, string | undefined> = {};
  const userId = randomUUID();

  beforeAll(async () => {
    guard = guardOutbound();
    await wawuId.start();
    await standin.start();
    nuv.install();
    pay.install();
    pay.addAccountAtBank('044', NUMBER, HOLDER);
    const env: Record<string, string> = {
      WALLET_PROVIDER: 'nuvion',
      NUVION_WEBHOOK_SECRET: SECRET,
      WAWU_ID_JWKS_URL: wawuId.jwksUrl,
      WAWU_ID_BASE_URL: wawuId.baseUrl,
    };
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    const client = new NuvionClient(
      standin.settings({ operationalAccountId: pay.operationalAccountId }),
      'nv_test_sk_FIX86burstKEY000000000000',
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
        factory: (db: PrismaService) => {
          provider = new NuvionWalletProvider(
            client,
            nuvionAreas(client, { bookStore: new PrismaNuvionBookStore(db) }),
          );
          return provider;
        },
        inject: [PrismaService],
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
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.fintavaLedgerEntry.deleteMany({
        where: {
          OR: [
            { wawuUserId: userId },
            { customerReference: { startsWith: RUN } },
          ],
        },
      });
      await prisma.fintavaWallet.deleteMany({ where: { wawuUserId: userId } });
      await prisma.nuvionEntity.deleteMany({ where: { wawuUserId: userId } });
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

  it(`${BURST} settled sends: one sweep, every one processed, the ledger equals the stand-in`, async () => {
    const entityId = standinId('01ENT');
    const account = nuv.addAccount(entityId, {
      balance: {
        available: 900_000_000,
        current: 900_000_000,
        overdraft_used: 0,
      },
    });
    await prisma.nuvionEntity.create({
      data: {
        wawuUserId: userId,
        entityId,
        status: 'approved',
        accountId: account.id,
      },
    });
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId: userId,
        customerId: entityId,
        walletId: nuvionWalletId(entityId, account.id),
        accountNumber: `7${String(Date.now()).slice(-9)}`,
        accountName: 'Ada Lovelace',
        provider: 'nuvion',
      },
    });

    const sent: { reference: string; id: string }[] = [];
    for (let i = 0; i < BURST; i += 1) {
      const reference = `${RUN}-${randomBytes(5).toString('hex')}`;
      const receipt = await provider.bankTransfer({
        from: { kind: 'customer', customerId: entityId },
        accountNumber: NUMBER,
        accountName: HOLDER,
        bankCode: '044',
        amountKobo: 250_000n,
        reference,
        narration: 'Thanks for the lesson',
      });
      const id = receipt.transactionId!;
      pay.settle(id, 'successful');
      const ts = new Date().toISOString();
      const raw = JSON.stringify({
        event: 'outflows.completed',
        data: pay.delivery(id),
      });
      const res = await request(app.getHttpServer() as Server)
        .post(HOOK)
        .set('Content-Type', 'application/json')
        .set('x-nuvion-event-id', `${RUN}-${i}`)
        .set('x-nuvion-event-timestamp', ts)
        .set(
          'x-nuvion-event-signature',
          signNuvionDelivery(SECRET, ts, Buffer.from(raw)),
        )
        .send(raw);
      expect(res.status).toBe(200);
      sent.push({ reference, id });
    }
    expect(BURST).toBeGreaterThan(NUVION_DISPATCH.batch * 2);

    const started = Date.now();
    await dispatcher.sweep();
    expect(Date.now() - started).toBeLessThan(NUVION_DISPATCH.budgetMs);

    const stored = await prisma.nuvionWebhookEvent.findMany({
      where: { eventId: { startsWith: RUN } },
      select: { processingStatus: true },
    });
    expect(stored).toHaveLength(BURST);
    expect(
      stored.filter((r) => r.processingStatus === 'processed'),
    ).toHaveLength(BURST);
    const rows = await prisma.fintavaLedgerEntry.findMany({
      where: { customerReference: { startsWith: RUN } },
    });
    expect(rows).toHaveLength(BURST);
    expect(
      rows.every((r) => r.status === 'completed' && r.direction === 'out'),
    ).toBe(true);
    expect(new Set(rows.map((r) => r.customerReference))).toEqual(
      new Set(sent.map((s) => s.reference)),
    );
    expect(guard.violations).toEqual([]);
  });
});
