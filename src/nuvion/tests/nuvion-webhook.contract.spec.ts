import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { inspect } from 'node:util';
import {
  ConsoleLogger,
  type INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import {
  guardOutbound,
  type OutboundGuard,
} from '../../../test/nuvion/outbound-guard';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaService } from '../../common/prisma/prisma.service';
import { HUB_APP_OPTIONS } from '../../hub-app-options';
import { HUB_THROTTLERS } from '../../hub-throttlers';
import { NuvionHandlerRegistry } from '../handlers/nuvion-handler-registry';
import type {
  NuvionDelivery,
  NuvionHandlerResult,
} from '../handlers/nuvion-handler.interface';
import { NUVION_WEBHOOK_WINDOW_MS } from '../nuvion-config';
import {
  readNuvionTimestamp,
  signNuvionDelivery,
  withinNuvionWindow,
} from '../webhook/nuvion-signature';
import { NuvionSignatureGuard } from '../webhook/nuvion-signature.guard';
import { NuvionWebhookDispatcher } from '../webhook/nuvion-webhook-dispatcher.service';
import { NuvionWebhookModule } from '../webhook/nuvion-webhook.module';

/**
 * NUV-01, `POST /api/hub/webhooks/nuvion` over HTTP against a real
 * database (V8: replay and forgery). No delivery here came from Nuvion:
 * every body is one of Nuvion's documented examples
 * (`webhooks__event-types.md`), signed here exactly as
 * `webhooks__overview.md` says (hex HMAC-SHA256 of `{timestamp}.{body}`).
 *
 * The app is built as src/main.ts builds it (raw body, pipe, filter,
 * interceptor) with AppModule's rate limits behind the global guard, so a
 * receiver that forgot to skip them would be refused here as live.
 *
 * Capability check proved here: a delivery signed over `{timestamp}.{body}`
 * is stored once and answered 200; the same event id again is stored once; a
 * wrong signature, a missing header or a timestamp outside the window
 * answers 401 and stores nothing. Then the handler registry: a stored
 * delivery reaches the handlers of its event, once.
 */

jest.setTimeout(60_000);

const SECRET = 'whsec_nuv01_local_Qm3Vb7Tz1Kc5Rx9Lp2';
const RUN = `nuv01-${randomUUID().slice(0, 8)}`;
const PATH = '/api/hub/webhooks/nuvion';

/** inflows.completed, as webhooks__event-types.md shows it. */
function inflow(n: number) {
  return {
    event: 'inflows.completed',
    data: {
      id: `01HXYZ5301${RUN}${n}`.slice(0, 40),
      amount: 10000,
      currency: 'NGN',
      unique_reference: `${RUN}-ref-${n}`,
      counterparty_id: '01HXYZ5304ABCDEFGHJKMNPQRS',
      account_id: '01HXYZ5302ABCDEFGHJKMNPQRS',
      entity_id: '01HXYZ5303ABCDEFGHJKMNPQRS',
      status: 'successful',
      status_reason: 'Successful.',
      narration: 'Invoice payment received from Adaeze 08031234567',
      type: 'inflow',
      payment_type: 'bank-transfer',
      applicable_fee: 0,
      meta: {},
      account: {
        id: '01HXYZ5302ABCDEFGHJKMNPQRS',
        display_name: 'Primary NGN Account',
      },
      created: 1759860119195,
      updated: 1759860119195,
    },
  };
}

let seq = 0;
function eventId(): string {
  seq += 1;
  return `${RUN}-evt-${seq}`;
}

const captured: string[] = [];

function everyLevel() {
  const logger = new ConsoleLogger({
    logLevels: ['log', 'error', 'warn', 'debug', 'verbose', 'fatal'],
  });
  for (const level of [
    'log',
    'error',
    'warn',
    'debug',
    'verbose',
    'fatal',
  ] as const) {
    logger[level] = (...args: unknown[]) => {
      captured.push(
        args.map((a) => (typeof a === 'string' ? a : inspect(a))).join(' '),
      );
    };
  }
  return logger;
}

async function buildApp(env: Record<string, string | undefined>) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      ThrottlerModule.forRoot([...HUB_THROTTLERS]),
      NuvionWebhookModule,
    ],
    providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
  })
    .setLogger(everyLevel())
    .compile();
  const app: INestApplication =
    moduleRef.createNestApplication(HUB_APP_OPTIONS);
  app.useLogger(everyLevel());
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
  // One server for the whole file: concurrent requests are not reset by a
  // per-request server closing under them (FIX-02).
  await app.listen(0, '127.0.0.1');
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  return { app, moduleRef, restore };
}

describe('NUV-01: Nuvion webhooks are received, checked and stored once', () => {
  let guard: OutboundGuard;
  let app: INestApplication;
  let prisma: PrismaService;
  let registry: NuvionHandlerRegistry;
  let dispatcher: NuvionWebhookDispatcher;
  let restoreEnv: () => void;
  const signatures: string[] = [];

  beforeAll(async () => {
    guard = guardOutbound();
    const built = await buildApp({ NUVION_WEBHOOK_SECRET: SECRET });
    app = built.app;
    restoreEnv = built.restore;
    prisma = built.moduleRef.get(PrismaService);
    registry = built.moduleRef.get(NuvionHandlerRegistry);
    dispatcher = built.moduleRef.get(NuvionWebhookDispatcher);
  });

  afterAll(async () => {
    await prisma.nuvionWebhookEvent.deleteMany({
      where: { eventId: { startsWith: RUN } },
    });
    await app.close();
    restoreEnv();
    guard.restore();
  });

  async function rows() {
    return prisma.nuvionWebhookEvent.findMany({
      where: { eventId: { startsWith: RUN } },
      orderBy: { receivedAt: 'asc' },
    });
  }

  /** Sends `raw` signed with `opts` (a header left undefined is not sent). */
  function deliver(
    raw: string,
    opts: {
      id?: string | null;
      timestamp?: string | null;
      signature?: string | null;
      contentType?: string;
    } = {},
  ) {
    const timestamp =
      opts.timestamp === undefined ? new Date().toISOString() : opts.timestamp;
    const signature =
      opts.signature === undefined
        ? signNuvionDelivery(SECRET, timestamp ?? '', Buffer.from(raw))
        : opts.signature;
    if (signature) signatures.push(signature);
    let req = request(app.getHttpServer() as Server)
      .post(PATH)
      .set('Content-Type', opts.contentType ?? 'application/json');
    const id = opts.id === undefined ? eventId() : opts.id;
    if (id !== null) req = req.set('x-nuvion-event-id', id);
    if (timestamp !== null)
      req = req.set('x-nuvion-event-timestamp', timestamp);
    if (signature !== null)
      req = req.set('x-nuvion-event-signature', signature);
    return req.send(raw);
  }

  describe('stored once and answered 200', () => {
    it('a signed inflows.completed is stored, with its event, ids and exact bytes, and answered 200 recorded', async () => {
      const raw = JSON.stringify(inflow(1));
      const id = eventId();
      const ts = new Date().toISOString();
      const res = await deliver(raw, { id, timestamp: ts }).expect(200);
      expect((res.body as { data: unknown }).data).toEqual({
        outcome: 'recorded',
        event: 'inflows.completed',
      });
      const stored = await prisma.nuvionWebhookEvent.findUniqueOrThrow({
        where: { eventId: id },
      });
      expect(stored).toMatchObject({
        event: 'inflows.completed',
        resourceId: inflow(1).data.id,
        entityId: '01HXYZ5303ABCDEFGHJKMNPQRS',
        signedAt: ts,
        processingStatus: 'pending',
        attempts: 0,
      });
      expect(Buffer.from(stored.rawBody).toString('utf8')).toBe(raw);
      expect(stored.payload).toEqual(inflow(1));
    });

    it('the same event again (Nuvion retries: a new timestamp, the same id) is stored once and answered 200 duplicate', async () => {
      const raw = JSON.stringify(inflow(2));
      const id = eventId();
      await deliver(raw, { id }).expect(200);
      const again = await deliver(raw, {
        id,
        timestamp: new Date(Date.now() + 1000).toISOString(),
      }).expect(200);
      expect((again.body as { data: { outcome: string } }).data.outcome).toBe(
        'duplicate',
      );
      expect((await rows()).filter((r) => r.eventId === id)).toHaveLength(1);
    });

    it('the exact signed delivery replayed under another event id (the id is not signed) lands on the same row', async () => {
      const raw = JSON.stringify(inflow(3));
      const ts = new Date().toISOString();
      const before = (await rows()).length;
      await deliver(raw, { timestamp: ts }).expect(200);
      const replay = await deliver(raw, {
        timestamp: ts,
        id: `${RUN}-forged`,
      }).expect(200);
      expect((replay.body as { data: { outcome: string } }).data.outcome).toBe(
        'duplicate',
      );
      expect((await rows()).length).toBe(before + 1);
    });

    it('two copies at the same moment: one row, one recorded, one duplicate', async () => {
      const raw = JSON.stringify(inflow(4));
      const id = eventId();
      const ts = new Date().toISOString();
      const [a, b] = await Promise.all([
        deliver(raw, { id, timestamp: ts }),
        deliver(raw, { id, timestamp: ts }),
      ]);
      expect([a.status, b.status]).toEqual([200, 200]);
      const outcomes = [a, b]
        .map((r) => (r.body as { data: { outcome: string } }).data.outcome)
        .sort();
      expect(outcomes).toEqual(['duplicate', 'recorded']);
      expect((await rows()).filter((r) => r.eventId === id)).toHaveLength(1);
    });

    it('a timestamp in Unix seconds or milliseconds is read too', async () => {
      await deliver(JSON.stringify(inflow(5)), {
        timestamp: String(Math.floor(Date.now() / 1000)),
      }).expect(200);
      await deliver(JSON.stringify(inflow(6)), {
        timestamp: String(Date.now()),
      }).expect(200);
    });

    it('accounts.created (its object wrapped) is keyed on the wrapped account', async () => {
      const id = eventId();
      await deliver(
        JSON.stringify({
          event: 'accounts.created',
          data: {
            account: {
              id: '01HXYZ5001ABCDEFGHJKMNPQRS',
              entity_id: '01HXYZ5002ABCDEFGHJKMNPQRS',
              type: 'checking',
              currency: 'NGN',
            },
            entity_impact: {
              entity_id: '01HXYZ5002ABCDEFGHJKMNPQRS',
              total_accounts: 1,
            },
          },
        }),
        { id },
      ).expect(200);
      expect(
        await prisma.nuvionWebhookEvent.findUniqueOrThrow({
          where: { eventId: id },
        }),
      ).toMatchObject({
        event: 'accounts.created',
        resourceId: '01HXYZ5001ABCDEFGHJKMNPQRS',
        entityId: '01HXYZ5002ABCDEFGHJKMNPQRS',
        processingStatus: 'pending',
      });
    });

    it('Nuvion test delivery ({event_group, event_name}) is stored as `test`, never handled', async () => {
      const id = eventId();
      await deliver(
        JSON.stringify({ event_group: 'inflows', event_name: 'completed' }),
        { id },
      ).expect(200);
      expect(
        await prisma.nuvionWebhookEvent.findUniqueOrThrow({
          where: { eventId: id },
        }),
      ).toMatchObject({
        event: 'inflows.completed',
        processingStatus: 'test',
      });
    });

    it('an event Nuvion does not document is stored `pending`, for a handler that lists it later (ruling 6)', async () => {
      const id = eventId();
      await deliver(
        JSON.stringify({ event: 'Wallets.Exploded', data: { id: 'x1' } }),
        { id },
      ).expect(200);
      expect(
        await prisma.nuvionWebhookEvent.findUniqueOrThrow({
          where: { eventId: id },
        }),
      ).toMatchObject({
        event: 'wallets.exploded',
        processingStatus: 'pending',
        attempts: 0,
      });
    });

    it('only a body that names no event, a malformed one, or carries no data is `unrecognised`', async () => {
      for (const body of [
        { data: { id: 'x2' } },
        { event: 'not an event!', data: { id: 'x3' } },
        { event: 'wallets', data: { id: 'x4' } },
        { event: `wallets.${'x'.repeat(120)}`, data: { id: 'x5' } },
        { event: 'wallets.exploded' },
        [1, 2],
      ]) {
        const id = eventId();
        await deliver(JSON.stringify(body), { id }).expect(200);
        expect(
          (
            await prisma.nuvionWebhookEvent.findUniqueOrThrow({
              where: { eventId: id },
            })
          ).processingStatus,
        ).toBe('unrecognised');
      }
    });

    it('a NUL in the body is kept in the raw bytes and replaced in the parsed copy', async () => {
      const id = eventId();
      const body = inflow(7);
      body.data.narration = 'from\u0000me';
      const raw = JSON.stringify(body);
      await deliver(raw, { id }).expect(200);
      const stored = await prisma.nuvionWebhookEvent.findUniqueOrThrow({
        where: { eventId: id },
      });
      expect(Buffer.from(stored.rawBody).toString('utf8')).toBe(raw);
      expect(
        (stored.payload as { data: { narration: string } }).data.narration,
      ).toBe('from�me');
    });

    it('never rate-limited: 45 deliveries in a burst (past 20 a second) all answer 200', async () => {
      const results = await Promise.all(
        Array.from({ length: 45 }, (_, i) =>
          deliver(JSON.stringify(inflow(100 + i))),
        ),
      );
      expect(results.map((r) => r.status)).toEqual(Array(45).fill(200));
    });
  });

  describe('refused with 401 and nothing stored (V8 forgery and replay)', () => {
    function refused(res: request.Response, status = 401): void {
      expect(res.status).toBe(status);
    }

    it('a wrong signature, a signature over other bytes or another timestamp, or no hex', async () => {
      const before = (await rows()).length;
      const raw = JSON.stringify(inflow(200));
      const ts = new Date().toISOString();
      refused(
        await deliver(raw, {
          timestamp: ts,
          signature: signNuvionDelivery('wrong-secret', ts, Buffer.from(raw)),
        }),
      );
      refused(
        await deliver(raw, {
          timestamp: ts,
          signature: signNuvionDelivery(
            SECRET,
            ts,
            Buffer.from(raw.replace('10000', '99000')),
          ),
        }),
      );
      refused(
        await deliver(raw, {
          timestamp: ts,
          signature: signNuvionDelivery(
            SECRET,
            new Date(Date.now() - 1000).toISOString(),
            Buffer.from(raw),
          ),
        }),
      );
      refused(await deliver(raw, { timestamp: ts, signature: 'not-hex' }));
      // The body changed in flight after signing (an amount raised).
      const signed = signNuvionDelivery(SECRET, ts, Buffer.from(raw));
      refused(
        await deliver(raw.replace('"amount":10000', '"amount":1000000'), {
          timestamp: ts,
          signature: signed,
        }),
      );
      expect((await rows()).length).toBe(before);
    });

    it.each([
      ['x-nuvion-event-id'],
      ['x-nuvion-event-timestamp'],
      ['x-nuvion-event-signature'],
    ])('a missing %s', async (header) => {
      const before = (await rows()).length;
      const raw = JSON.stringify(inflow(210));
      const opts =
        header === 'x-nuvion-event-id'
          ? { id: null }
          : header === 'x-nuvion-event-timestamp'
            ? { timestamp: null }
            : { signature: null };
      refused(await deliver(raw, opts));
      expect((await rows()).length).toBe(before);
    });

    it('a timestamp outside the window, old (a captured delivery replayed later) or in the future, or not a time', async () => {
      const before = (await rows()).length;
      const raw = JSON.stringify(inflow(220));
      const late = new Date(
        Date.now() - NUVION_WEBHOOK_WINDOW_MS - 60_000,
      ).toISOString();
      const early = new Date(
        Date.now() + NUVION_WEBHOOK_WINDOW_MS + 60_000,
      ).toISOString();
      refused(await deliver(raw, { timestamp: late }));
      refused(await deliver(raw, { timestamp: early }));
      refused(await deliver(raw, { timestamp: 'yesterday' }));
      refused(
        await deliver(raw, {
          timestamp: String(
            Math.floor((Date.now() - NUVION_WEBHOOK_WINDOW_MS - 60_000) / 1000),
          ),
        }),
      );
      // Inside the window it is taken.
      await deliver(raw, {
        timestamp: new Date(
          Date.now() - NUVION_WEBHOOK_WINDOW_MS + 60_000,
        ).toISOString(),
      }).expect(200);
      expect((await rows()).length).toBe(before + 1);
    });

    describe('the window, to the millisecond, on a fixed clock', () => {
      const NOON = Date.parse('2026-10-08T12:00:00.000Z');
      let clock = NOON;
      let n = 900;
      beforeEach(() => {
        clock = NOON;
        jest
          .spyOn(NuvionSignatureGuard.prototype, 'now')
          .mockImplementation(() => clock);
      });
      afterEach(() => jest.restoreAllMocks());
      const at = (timestamp: string) =>
        deliver(JSON.stringify(inflow((n += 1))), { timestamp });

      it('is 20 minutes either side (Nuvion 15-minute retry span plus 5, ruling 5)', async () => {
        expect(NUVION_WEBHOOK_WINDOW_MS).toBe(20 * 60_000);
        // Written out, not derived from the constant.
        await at('2026-10-08T11:41:00.000Z').expect(200);
        await at('2026-10-08T11:39:00.000Z').expect(401);
        await at('2026-10-08T12:19:00.000Z').expect(200);
        await at('2026-10-08T12:21:00.000Z').expect(401);
        // A retry 14 minutes after the first attempt, signed then.
        await at('2026-10-08T11:46:00.000Z').expect(200);
      });

      it('the edge is inside: exactly 20 minutes is taken, 1 ms more is refused, both sides', async () => {
        await at('2026-10-08T11:40:00.000Z').expect(200);
        await at('2026-10-08T11:39:59.999Z').expect(401);
        await at('2026-10-08T12:20:00.000Z').expect(200);
        await at('2026-10-08T12:20:00.001Z').expect(401);
        expect(withinNuvionWindow(NOON - 1_200_000, NOON, 1_200_000)).toBe(
          true,
        );
        expect(withinNuvionWindow(NOON - 1_200_001, NOON, 1_200_000)).toBe(
          false,
        );
        expect(withinNuvionWindow(NOON + 1_200_000, NOON, 1_200_000)).toBe(
          true,
        );
        expect(withinNuvionWindow(NOON + 1_200_001, NOON, 1_200_000)).toBe(
          false,
        );
      });

      it('an ISO 8601 timestamp must be a whole one: date, T, time and a zone', async () => {
        await at('2026-10-08T12:00:00Z').expect(200);
        await at('2026-10-08T12:00:00.123456Z').expect(200);
        await at('2026-10-08T13:00:00+01:00').expect(200);
        for (const t of [
          '2026-10-08 12:00:00Z',
          '2026-10-08T12:00:00',
          '2026-10-08T12:00Z',
          '2026-10-08T12:00:00Z junk',
          '2026-10-08T12:00:00.Z',
        ]) {
          expect(readNuvionTimestamp(t)).toBeNull();
          await at(t).expect(401);
        }
        // A bare date reads as midnight: refused even with the clock there.
        clock = Date.parse('2026-10-08T00:05:00.000Z');
        expect(readNuvionTimestamp('2026-10-08')).toBeNull();
        await at('2026-10-08').expect(401);
        await at('2026-10-08T00:04:00Z').expect(200);
      });
    });

    it('an event id we would not store', async () => {
      const before = (await rows()).length;
      refused(
        await deliver(JSON.stringify(inflow(230)), {
          id: 'id with spaces; drop',
        }),
      );
      expect((await rows()).length).toBe(before);
    });

    it('a body that is not JSON is 400 and stored nowhere', async () => {
      const before = (await rows()).length;
      refused(
        await deliver('event=inflows.completed', { contentType: 'text/plain' }),
        400,
      );
      expect((await rows()).length).toBe(before);
    });

    it('with NUVION_WEBHOOK_SECRET unset every delivery is refused (fails closed)', async () => {
      const bare = await buildApp({ NUVION_WEBHOOK_SECRET: undefined });
      try {
        const raw = JSON.stringify(inflow(240));
        const ts = new Date().toISOString();
        const res = await request(bare.app.getHttpServer() as Server)
          .post(PATH)
          .set('Content-Type', 'application/json')
          .set('x-nuvion-event-id', eventId())
          .set('x-nuvion-event-timestamp', ts)
          .set(
            'x-nuvion-event-signature',
            signNuvionDelivery('', ts, Buffer.from(raw)),
          )
          .send(raw);
        expect(res.status).toBe(401);
      } finally {
        await bare.app.close();
        bare.restore();
      }
    });
  });

  describe('the handler registry hands a stored delivery to the handlers of its event, once', () => {
    let behaviour: (d: NuvionDelivery) => Promise<NuvionHandlerResult>;
    const seen: NuvionDelivery[] = [];
    beforeAll(() => {
      registry.add({
        task: 'SPEC',
        events: ['inflows.failed'],
        handle: (d) => {
          seen.push(d);
          return behaviour(d);
        },
      });
    });
    beforeEach(() => {
      seen.length = 0;
      behaviour = () => Promise.resolve({ outcome: 'done', note: 'credited' });
    });

    async function stored(n: number) {
      const id = eventId();
      const body = { ...inflow(n), event: 'inflows.failed' };
      await deliver(JSON.stringify(body), { id }).expect(200);
      return prisma.nuvionWebhookEvent.findUniqueOrThrow({
        where: { eventId: id },
      });
    }

    it('done: processed, with the handler note; the handler saw the data', async () => {
      const row = await stored(300);
      expect(await dispatcher.dispatch(row.id)).toBe('processed');
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        event: 'inflows.failed',
        eventId: row.eventId,
        attempts: 1,
      });
      expect((seen[0].data as { amount: number }).amount).toBe(10000);
      expect(
        await prisma.nuvionWebhookEvent.findUniqueOrThrow({
          where: { id: row.id },
        }),
      ).toMatchObject({
        processingStatus: 'processed',
        note: 'SPEC: credited',
        claimedUntil: null,
      });
      // Never twice.
      expect(await dispatcher.dispatch(row.id)).toBe('skipped');
      expect(seen).toHaveLength(1);
    });

    it('wait (or a handler that throws): left pending, resting, and tried again after the rest', async () => {
      const row = await stored(310);
      behaviour = () => Promise.resolve({ outcome: 'wait', note: 'not yet' });
      const t0 = new Date();
      expect(await dispatcher.dispatch(row.id, t0)).toBe('waiting');
      const after = await prisma.nuvionWebhookEvent.findUniqueOrThrow({
        where: { id: row.id },
      });
      expect(after).toMatchObject({
        processingStatus: 'pending',
        attempts: 1,
        claimedUntil: null,
      });
      expect(after.nextAttemptAt!.getTime()).toBe(t0.getTime() + 60_000);
      // The sweep leaves it until its rest is over.
      seen.length = 0;
      await dispatcher.sweep(new Date(t0.getTime() + 30_000));
      expect(seen.filter((d) => d.id === row.id)).toHaveLength(0);
      behaviour = () => Promise.reject(new TypeError('boom with 08031234567'));
      await dispatcher.sweep(new Date(t0.getTime() + 61_000));
      const again = await prisma.nuvionWebhookEvent.findUniqueOrThrow({
        where: { id: row.id },
      });
      expect(again).toMatchObject({
        processingStatus: 'pending',
        attempts: 2,
        note: 'SPEC: stopped (TypeError)',
      });
      expect(again.nextAttemptAt!.getTime()).toBe(
        t0.getTime() + 61_000 + 120_000,
      );
    });

    it('failed: kept for review', async () => {
      const row = await stored(320);
      behaviour = () =>
        Promise.resolve({ outcome: 'failed', note: 'no such account' });
      expect(await dispatcher.dispatch(row.id)).toBe('failed');
      expect(
        (
          await prisma.nuvionWebhookEvent.findUniqueOrThrow({
            where: { id: row.id },
          })
        ).processingStatus,
      ).toBe('failed');
    });

    it('two workers at once: the handler runs once', async () => {
      const row = await stored(330);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      behaviour = async () => {
        await gate;
        return { outcome: 'done', note: 'once' };
      };
      const both = Promise.all([
        dispatcher.dispatch(row.id),
        dispatcher.dispatch(row.id),
      ]);
      setTimeout(release, 200);
      expect((await both).sort()).toEqual(['processed', 'skipped']);
      expect(seen.filter((d) => d.id === row.id)).toHaveLength(1);
    });

    it('an event no handler lists stays pending, untouched; a test delivery is never handled', async () => {
      const id = eventId();
      await deliver(JSON.stringify({ ...inflow(340), event: 'cards.frozen' }), {
        id,
      }).expect(200);
      const row = await prisma.nuvionWebhookEvent.findUniqueOrThrow({
        where: { eventId: id },
      });
      expect(await dispatcher.dispatch(row.id)).toBe('skipped');
      expect(
        await prisma.nuvionWebhookEvent.findUniqueOrThrow({
          where: { id: row.id },
        }),
      ).toMatchObject({
        processingStatus: 'pending',
        attempts: 0,
      });
      const testId = eventId();
      await deliver(
        JSON.stringify({ event_group: 'inflows', event_name: 'failed' }),
        { id: testId },
      ).expect(200);
      const t = await prisma.nuvionWebhookEvent.findUniqueOrThrow({
        where: { eventId: testId },
      });
      expect(await dispatcher.dispatch(t.id)).toBe('skipped');
      expect(seen).toHaveLength(0);
    });

    it('an undocumented event waits, pending, until a handler lists it; then the sweep hands it over (ruling 6)', async () => {
      // A name only this run uses, so the sweep's batch holds no other row.
      const name = `wallets.exploded_${RUN.slice(-8)}`;
      const id = eventId();
      await deliver(
        JSON.stringify({ ...inflow(350), event: name.toUpperCase() }),
        { id },
      ).expect(200);
      const row = await prisma.nuvionWebhookEvent.findUniqueOrThrow({
        where: { eventId: id },
      });
      expect(row).toMatchObject({ event: name, processingStatus: 'pending' });
      expect(await dispatcher.dispatch(row.id)).toBe('skipped');
      await dispatcher.sweep(new Date());
      expect(
        await prisma.nuvionWebhookEvent.findUniqueOrThrow({
          where: { id: row.id },
        }),
      ).toMatchObject({ processingStatus: 'pending', attempts: 0 });

      const later: NuvionDelivery[] = [];
      registry.add({
        task: 'LATER',
        events: [name],
        handle: (d) => {
          later.push(d);
          return Promise.resolve({ outcome: 'done', note: 'handled' });
        },
      });
      expect(registry.events()).toContain(name);
      await dispatcher.sweep(new Date());
      expect(later.map((d) => [d.id, d.event])).toEqual([[row.id, name]]);
      expect(
        await prisma.nuvionWebhookEvent.findUniqueOrThrow({
          where: { id: row.id },
        }),
      ).toMatchObject({
        processingStatus: 'processed',
        note: 'LATER: handled',
        attempts: 1,
      });
    });
  });

  describe('nothing leaks, nothing leaves', () => {
    it('no log line holds the secret, a signature, a body or the personal data in one', () => {
      const all = captured.join('\n');
      expect(all).toContain('nuvion webhook');
      for (let i = 0; i + 8 <= SECRET.length; i += 1) {
        expect(all).not.toContain(SECRET.slice(i, i + 8));
      }
      for (const s of signatures) expect(all).not.toContain(s);
      expect(all).not.toContain('08031234567');
      expect(all).not.toContain('Invoice payment');
      expect(all).not.toContain('unique_reference');
    });

    it('no connection left this machine', () => {
      expect(guard.violations).toEqual([]);
    });
  });
});
