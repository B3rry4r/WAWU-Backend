import { randomUUID } from 'node:crypto';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import * as argon2 from 'argon2';
import request from 'supertest';
import type { App } from 'supertest/types';
import { WawuIdClient } from '../../src/common/auth/wawu-id.client';
import { AccountPurgeService } from '../../src/account-purge/account-purge.service';
import { EventCallOffRefundService } from '../../src/event-ticketing/wallet/event-call-off-refund.service';
import { EventHostErasureService } from '../../src/event-ticketing/wallet/event-host-erasure.service';
import { WawuJwtStrategy } from '../../src/common/auth/wawu-jwt.strategy';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../src/common/interceptors/response.interceptor';
import { PrismaModule } from '../../src/common/prisma/prisma.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { EventTicketingModule } from '../../src/event-ticketing/event-ticketing.module';
import { EventWalletOrdersModule } from '../../src/event-ticketing/wallet/event-wallet-orders.module';
import { HUB_APP_OPTIONS } from '../../src/hub-app-options';
import { WalletHoldService } from '../../src/money/holds/wallet-hold.service';
import { MoneyModule } from '../../src/money/money.module';
import { WalletPaymentService } from '../../src/money/payments/wallet-payment.service';
import { FintavaDouble, MERCHANT_ACCOUNT } from '../fintava/fintava-double';
import { mintToken, QuietLogger } from '../payments/poll-helpers';
import { installFintava, PIN, Wallets } from '../plans/tier-purchase-harness';

/**
 * EVENTS-07's stand-ins: the real Hub modules for money and event ticketing, a
 * real database, real RS256 tokens for the stand-in WAWU ID, and the real
 * Fintava client over a socket to FintavaDouble with the tier harness's small
 * book of wallets behind it. No provider is called.
 */

export { PIN };

export interface Person {
  id: string;
  auth: string;
  walletId: string;
  accountNumber: string;
}

export interface TierSeed {
  name: string;
  priceNaira: number;
  quantity: number;
  tier?: 'regular' | 'vip' | 'early_bird' | 'group' | 'free';
  salesStartAt?: Date;
  salesEndAt?: Date;
}

export interface SeededEvent {
  id: string;
  hostId: string;
  tiers: Array<{ id: string; name: string; priceNaira: number }>;
}

export interface EventHarness {
  app: INestApplication<App>;
  prisma: PrismaService;
  payments: WalletPaymentService;
  holds: WalletHoldService;
  purge: AccountPurgeService;
  erasure: EventHostErasureService;
  callOff: EventCallOffRefundService;
  double: FintavaDouble;
  wallets: Wallets;
  logger: QuietLogger;
  users: string[];
  buyer(kobo: number): Promise<Person>;
  walletless(): Person;
  event(opts: {
    tiers: TierSeed[];
    status?: 'published' | 'pending' | 'cancelled';
    startsInDays?: number;
    hostId?: string;
  }): Promise<SeededEvent>;
  /** Runs the payment sweep as if `ms` more had passed since the last call. */
  sweepLater(ms?: number): ReturnType<WalletPaymentService['sweep']>;
  close(): Promise<void>;
}

export async function bootEventApp(
  tag: string,
  extraEnv: Record<string, string> = {},
): Promise<EventHarness> {
  const cheapPinHash = await argon2.hash(PIN, {
    type: argon2.argon2id,
    timeCost: 1,
    memoryCost: 1024,
    parallelism: 1,
  });
  const double = new FintavaDouble();
  await double.start();
  const logger = new QuietLogger();
  const wallets = new Wallets();
  const previous: Record<string, string | undefined> = {};
  const env: Record<string, string> = {
    FINTAVA_BASE_URL: double.baseUrl,
    FINTAVA_API_KEY: `live_test_${tag}_0123456789FAKEKEY`,
    FINTAVA_TIMEOUT_MS: '120000',
    FINTAVA_MONEY_TIMEOUT_MS: '120000',
    FINTAVA_CHECK_TIMEOUT_MS: '120000',
    FEE_QUOTE_KEY: `${tag}-test-fee-quote-key-0123456789abcdef0123`,
    MERCHANT_MAX_PER_TXN_KOBO: '1000000000',
    PIN_LOCK_MINUTES: '',
    IDEMPOTENCY_KEY_HOURS: '',
    ...extraEnv,
  };
  for (const [k, v] of Object.entries(env)) {
    previous[k] = process.env[k];
    process.env[k] = v;
  }
  installFintava(double, wallets);
  wallets.kobo.set(MERCHANT_ACCOUNT, 5_000_000_000);
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      PassportModule.register({ defaultStrategy: 'wawu-jwt' }),
      PrismaModule,
      MoneyModule,
      EventTicketingModule,
      EventWalletOrdersModule,
    ],
    providers: [WawuJwtStrategy, WawuIdClient],
  })
    .setLogger(logger)
    .compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>({
    ...HUB_APP_OPTIONS,
    logger,
  });
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
  const prisma = moduleRef.get(PrismaService);
  const payments = moduleRef.get(WalletPaymentService);
  const users: string[] = [];
  const events: string[] = [];
  let accountSeq = 0;
  let clock = Date.now();

  return {
    app,
    prisma,
    payments,
    holds: moduleRef.get(WalletHoldService),
    purge: moduleRef.get(AccountPurgeService, { strict: false }),
    erasure: moduleRef.get(EventHostErasureService, { strict: false }),
    callOff: moduleRef.get(EventCallOffRefundService, { strict: false }),
    double,
    wallets,
    logger,
    users,
    async buyer(kobo) {
      const id = randomUUID();
      users.push(id);
      accountSeq += 1;
      const accountNumber = `42${String(Date.now()).slice(-6)}${String(accountSeq).padStart(2, '0')}`;
      const walletId = randomUUID();
      await prisma.fintavaWallet.create({
        data: {
          wawuUserId: id,
          customerId: randomUUID(),
          walletId,
          accountNumber,
        },
      });
      wallets.kobo.set(accountNumber, kobo);
      wallets.byId.set(walletId, accountNumber);
      await prisma.transactionPin.create({
        data: { wawuUserId: id, pinHash: cheapPinHash },
      });
      return {
        id,
        auth: `Bearer ${mintToken(id, tag)}`,
        walletId,
        accountNumber,
      };
    },
    walletless() {
      const id = randomUUID();
      users.push(id);
      return {
        id,
        auth: `Bearer ${mintToken(id, tag)}`,
        walletId: '',
        accountNumber: '',
      };
    },
    async event(opts) {
      const hostId = opts.hostId ?? randomUUID();
      users.push(hostId);
      const created = await prisma.event.create({
        data: {
          hostWawuId: hostId,
          name: 'WAWU Creators Summit',
          description: 'A day for creators.',
          hostOrg: 'WAWU',
          format: 'in_person',
          type: 'summit',
          startsAt: new Date(
            Date.now() + (opts.startsInDays ?? 10) * 24 * 60 * 60 * 1000,
          ),
          location: 'Lagos',
          status: opts.status ?? 'published',
          cancelledAt: opts.status === 'cancelled' ? new Date() : null,
          ticketTypes: {
            create: opts.tiers.map((t) => ({
              tier: t.tier ?? (t.priceNaira === 0 ? 'free' : 'regular'),
              name: t.name,
              priceNaira: t.priceNaira,
              quantity: t.quantity,
              salesStartAt: t.salesStartAt ?? null,
              salesEndAt: t.salesEndAt ?? null,
            })),
          },
        },
        include: { ticketTypes: true },
      });
      events.push(created.id);
      return {
        id: created.id,
        hostId,
        tiers: opts.tiers.map((t) => {
          const row = created.ticketTypes.find((x) => x.name === t.name)!;
          return { id: row.id, name: row.name, priceNaira: row.priceNaira };
        }),
      };
    },
    sweepLater(ms = 2 * 60_000) {
      clock = Math.max(clock, Date.now()) + ms;
      return payments.sweep(new Date(clock));
    },
    async close() {
      const rows = await prisma.walletPayment.findMany({
        where: { payerWawuUserId: { in: users } },
        select: { customerReference: true },
      });
      const holds = await prisma.walletHold.findMany({
        where: { payerWawuUserId: { in: users } },
        select: { customerReference: true },
      });
      await prisma.fintavaLedgerEntry.deleteMany({
        where: {
          customerReference: {
            in: [
              ...rows.map((r) => r.customerReference),
              ...holds.flatMap((h) =>
                h.customerReference ? [h.customerReference] : [],
              ),
            ],
          },
        },
      });
      await prisma.walletHold.deleteMany({
        where: { payerWawuUserId: { in: users } },
      });
      await prisma.walletPayment.deleteMany({
        where: { payerWawuUserId: { in: users } },
      });
      await prisma.event.deleteMany({ where: { id: { in: events } } });
      await prisma.moneyIdempotencyKey.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.transactionPin.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.fintavaWallet.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await app.close();
      await double.stop();
      for (const [k, v] of Object.entries(previous)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

/** The routes, as the app calls them. */
export const api = (h: EventHarness) => ({
  create: (
    p: Person,
    eventId: string,
    body: Record<string, unknown>,
    key?: string,
  ) => {
    const req = request(h.app.getHttpServer())
      .post(`/api/hub/events/${eventId}/orders/wallet`)
      .set('Authorization', p.auth);
    if (key !== undefined) req.set('Idempotency-Key', key);
    return req.send(body);
  },
  quote: (p: Person, id: string) =>
    request(h.app.getHttpServer())
      .get(`/api/hub/events/orders/wallet/${id}/quote`)
      .set('Authorization', p.auth),
  pay: (
    p: Person,
    body: Record<string, unknown>,
    opts: { key?: string; pin?: string | null } = {},
  ) => {
    const req = request(h.app.getHttpServer())
      .post('/api/hub/events/orders/wallet/pay')
      .set('Authorization', p.auth)
      .set('Idempotency-Key', opts.key ?? randomUUID());
    if (opts.pin !== null) req.set('X-Transaction-Pin', opts.pin ?? PIN);
    return req.send(body);
  },
  read: (p: Person, id: string) =>
    request(h.app.getHttpServer())
      .get(`/api/hub/events/orders/wallet/${id}`)
      .set('Authorization', p.auth),
});
