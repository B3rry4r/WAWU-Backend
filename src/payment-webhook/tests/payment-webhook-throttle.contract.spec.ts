import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  SkipThrottle,
  ThrottlerGuard,
  ThrottlerModule,
} from '@nestjs/throttler';
import { THROTTLER_SKIP } from '@nestjs/throttler/dist/throttler.constants';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { applyHubHttpSettings, HUB_APP_OPTIONS } from '../../hub-app-options';
import { HUB_THROTTLERS, SKIP_EVERY_HUB_THROTTLER } from '../../hub-throttlers';
import { PaymentWebhookController } from '../payment-webhook.controller';
import { PaymentWebhookModule } from '../payment-webhook.module';

/**
 * OPS-11: no Flutterwave delivery is ever refused by the rate limits.
 *
 * The app is built as src/main.ts and AppModule compose it for this route:
 * the same create options and Express settings (HUB_APP_OPTIONS,
 * applyHubHttpSettings), the same pipe, filter and interceptor, and the
 * app's named throttlers (HUB_THROTTLERS) behind the same global
 * ThrottlerGuard. Every delivery arrives as nginx forwards it, from one
 * Flutterwave address in X-Forwarded-For, so without the skip they all share
 * one bucket.
 *
 * Each delivery is a correctly signed `charge.completed` for a tx_ref no
 * flow owns: the service answers 200 `unmatched` after one receipt insert,
 * with no call to Flutterwave. Every tx_ref carries this run's id, and
 * afterAll deletes the receipts.
 */

const SECRET_HASH = 'test-webhook-secret-hash-o11';
const RUN = `o11-${randomUUID().slice(0, 8)}`;
const PATH = '/api/hub/webhooks/flutterwave';
/** One Flutterwave sender, as nginx's X-Forwarded-For would name it. */
const FLUTTERWAVE_ADDRESS = '203.0.113.40';
/** Another sender, only for warming the app up before a timed burst. */
const WARM_UP_ADDRESS = '203.0.113.41';

const SHORT = HUB_THROTTLERS.find((t) => t.name === 'short')!;

function chargeCompleted(txRef: string) {
  return {
    event: 'charge.completed',
    'event.type': 'CARD_TRANSACTION',
    data: {
      id: `flw-${txRef}`,
      tx_ref: txRef,
      amount: 5999,
      currency: 'NGN',
      status: 'successful',
      customer: { id: 1, name: 'Test', email: 'user@test.wawu.dev' },
    },
  };
}

async function buildApp() {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true }),
      ThrottlerModule.forRoot([...HUB_THROTTLERS]),
      PrismaModule,
      WawuAuthModule,
      PaymentWebhookModule,
    ],
    providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
  }).compile();
  const app = moduleRef.createNestApplication(HUB_APP_OPTIONS);
  applyHubHttpSettings(app);
  // Observes only: notes when each delivery reaches the app, ahead of the
  // guard, and passes it on untouched. The throttler's window counts
  // arrivals, so that is what a burst is timed by (see burst()).
  const arrivals: number[] = [];
  app.use(PATH, (_req: Request, _res: Response, next: NextFunction) => {
    arrivals.push(Date.now());
    next();
  });
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
  // Port 0: the OS picks a free one, so nothing here can collide.
  await app.listen(0, '127.0.0.1');
  const { port } = (app.getHttpServer() as Server).address() as AddressInfo;
  return { app, moduleRef, arrivals, url: `http://127.0.0.1:${port}` };
}

type Built = Awaited<ReturnType<typeof buildApp>>;

/**
 * `count` different signed deliveries from `sender`, all sent at once.
 *
 * `span` is the time from the first delivery reaching the app to the last.
 * The `short` throttler counts a caller's arrivals within 1 s of the first,
 * so a span under 1 s means every delivery fell in one window: without the
 * skip, the 21st onward would be refused. The time until the last RESPONSE
 * is not used: each delivery also writes a receipt, and on a busy machine
 * those writes alone take more than a second (the flake the OPS-11 verifier
 * found).
 */
async function burst(
  app: Built,
  label: string,
  count: number,
  sender = FLUTTERWAVE_ADDRESS,
) {
  app.arrivals.length = 0;
  const results = await Promise.all(
    Array.from({ length: count }, (_, i) =>
      request(app.url)
        .post(PATH)
        .set('verif-hash', SECRET_HASH)
        .set('X-Forwarded-For', sender)
        .send(chargeCompleted(`${RUN}-${label}-${i}`)),
    ),
  );
  expect(app.arrivals).toHaveLength(count);
  const span = Math.max(...app.arrivals) - Math.min(...app.arrivals);
  return { results, span };
}

/**
 * A fresh app's first requests open the database pool and pay every
 * first-call cost. Before a timed burst, 10 deliveries at once from ANOTHER
 * sender (its own bucket, so the burst's sender starts with a full one in
 * either variant) warm the app up.
 */
async function warmUp(app: Built, label: string) {
  const { results } = await burst(app, `warm-${label}`, 10, WARM_UP_ADDRESS);
  expect(results.map((r) => r.status)).toEqual(Array(10).fill(200));
}

describe('Flutterwave webhook rate limits (OPS-11)', () => {
  let built: Built;
  let prisma: PrismaService;
  const previousHash = process.env.FLUTTERWAVE_SECRET_HASH;

  beforeAll(async () => {
    process.env.FLUTTERWAVE_SECRET_HASH = SECRET_HASH;
    built = await buildApp();
    prisma = built.moduleRef.get(PrismaService);
  }, 30000);

  afterAll(async () => {
    await prisma?.paymentWebhookReceipt.deleteMany({
      where: { txRef: { startsWith: RUN } },
    });
    await built?.app.close();
    if (previousHash === undefined) delete process.env.FLUTTERWAVE_SECRET_HASH;
    else process.env.FLUTTERWAVE_SECRET_HASH = previousHash;
  });

  it('30 different signed deliveries in the same second, through the real global ThrottlerGuard: 30 times 200, 30 receipts, no 429', async () => {
    // AppModule allows 20 a second (`short`) per caller: without the skip,
    // 10 of these are refused with 429 and wait for Flutterwave's resend.
    const count = SHORT.limit + 10;
    await warmUp(built, 'burst');
    const { results, span } = await burst(built, 'burst', count);
    expect(span).toBeLessThan(SHORT.ttl);
    expect(results.map((r) => r.status)).toEqual(Array(count).fill(200));
    expect(
      results.every(
        (r) =>
          (r.body as { data: { outcome: string } }).data.outcome ===
          'unmatched',
      ),
    ).toBe(true);
    expect(
      await prisma.paymentWebhookReceipt.count({
        where: { txRef: { startsWith: `${RUN}-burst-` } },
      }),
    ).toBe(count);
  }, 30000);

  it('the old bare @SkipThrottle() on the same controller fails that burst: 20 times 200, then 429', async () => {
    // The controller as it was before OPS-11: the named skips taken off and
    // a bare @SkipThrottle() put on, which marks only a throttler called
    // `default`. Restored in `finally`, before any other test runs.
    const names = HUB_THROTTLERS.map((t) => t.name);
    const saved = names.map((name) => [
      name,
      Reflect.getOwnMetadata(
        THROTTLER_SKIP + name,
        PaymentWebhookController,
      ) as unknown,
    ]);
    for (const name of names)
      Reflect.deleteMetadata(THROTTLER_SKIP + name, PaymentWebhookController);
    SkipThrottle()(PaymentWebhookController);
    const bare = await buildApp();
    try {
      const count = SHORT.limit + 10;
      await warmUp(bare, 'bare');
      const { results, span } = await burst(bare, 'bare', count);
      expect(span).toBeLessThan(SHORT.ttl);
      const statuses = results.map((r) => r.status);
      expect(statuses.filter((s) => s === 200)).toHaveLength(SHORT.limit);
      expect(statuses.filter((s) => s === 429)).toHaveLength(10);
    } finally {
      await bare.app.close();
      Reflect.deleteMetadata(
        THROTTLER_SKIP + 'default',
        PaymentWebhookController,
      );
      for (const [name, value] of saved)
        Reflect.defineMetadata(
          THROTTLER_SKIP + String(name),
          value,
          PaymentWebhookController,
        );
    }
  }, 30000);

  it('the controller skips every throttler AppModule registers, by name', () => {
    expect(Object.keys(SKIP_EVERY_HUB_THROTTLER).sort()).toEqual(
      HUB_THROTTLERS.map((t) => t.name).sort(),
    );
    for (const { name } of HUB_THROTTLERS) {
      expect(
        Reflect.getMetadata(THROTTLER_SKIP + name, PaymentWebhookController),
      ).toBe(true);
    }
  });
});
