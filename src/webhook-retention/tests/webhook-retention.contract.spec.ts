import { createHash, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  FintavaDouble,
  MERCHANT_BALANCE,
} from '../../../test/fintava/fintava-double';
import {
  guardOutbound,
  type OutboundGuard,
} from '../../../test/nuvion/outbound-guard';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  FINTAVA_SIGNATURE_HEADER,
  signFintavaBody,
} from '../../fintava/webhook/fintava-signature';
import { FintavaWebhookModule } from '../../fintava/webhook/fintava-webhook.module';
import { HUB_APP_OPTIONS } from '../../hub-app-options';
import { LedgerConsumerService } from '../../money/ledger/ledger-consumer.service';
import { LedgerModule } from '../../money/ledger/ledger.module';
import { NuvionHandlerRegistry } from '../../nuvion/handlers/nuvion-handler-registry';
import type { NuvionDelivery } from '../../nuvion/handlers/nuvion-handler.interface';
import { signNuvionDelivery } from '../../nuvion/webhook/nuvion-signature';
import { NuvionWebhookDispatcher } from '../../nuvion/webhook/nuvion-webhook-dispatcher.service';
import { NuvionWebhookModule } from '../../nuvion/webhook/nuvion-webhook.module';
import {
  WEBHOOK_RETENTION_CONFIG_KEYS,
  WEBHOOK_RETENTION_SCHEDULE,
} from '../webhook-retention-config';
import { WebhookRetentionModule } from '../webhook-retention.module';
import { WebhookRetentionService } from '../webhook-retention.service';

/**
 * FIX-20: provider webhook deliveries are not kept for ever. Over HTTP and
 * against a real database: every delivery here is built in the provider's
 * documented format, signed locally with a local secret as the provider signs
 * it (Fintava: HMAC-SHA512 of the body; Nuvion: HMAC-SHA256 of
 * `{timestamp}.{body}`), and sent to the real route. Nothing reaches a
 * provider: the outbound guard refuses any non-local connection, and Fintava
 * is a local double.
 *
 * The rows the run makes carry its id, and afterEach deletes them. The job
 * clears every old row in the database it runs on, so the counts below are
 * made exact by stamping each run with a time of its own (`bodyClearedAt`).
 */

jest.setTimeout(120_000);

const RUN = `f20${randomUUID().slice(0, 8)}`;
const FIN_SECRET = 'whsec_local_f20_Qv7Lp3Xc9Ty2Hb5Jn';
const NUV_SECRET = 'whsec_f20_local_Mk4Zb8Rt1Cw6Nx3Pd';
const FIN_PATH = '/api/hub/webhooks/fintava';
const NUV_PATH = '/api/hub/webhooks/nuvion';
const DAY = 86_400_000;
const PERSON = 'Adaeze Okafor';
const PHONE = '08031234567';

const sha = (b: Buffer | Uint8Array) =>
  createHash('sha256').update(b).digest('hex');

let seq = 0;
const uniq = () => `${RUN}-${(seq += 1)}`;
/** A run time of its own, so `bodyClearedAt` identifies exactly what one run cleared. */
const stampOf = () => new Date(Date.now() + (seq += 1));

describe('FIX-20: provider webhook deliveries are not kept for ever', () => {
  let guard: OutboundGuard;
  let app: INestApplication;
  let prisma: PrismaService;
  let retention: WebhookRetentionService;
  let consumer: LedgerConsumerService;
  let registry: NuvionHandlerRegistry;
  let dispatcher: NuvionWebhookDispatcher;
  const double = new FintavaDouble();
  const previous: Record<string, string | undefined> = {};
  const wallets: string[] = [];

  beforeAll(async () => {
    guard = guardOutbound();
    await double.start();
    double.on('GET', '/merchant/balance', {
      status: 200,
      body: MERCHANT_BALANCE,
    });
    const env = {
      FINTAVA_BASE_URL: double.baseUrl,
      FINTAVA_API_KEY: 'live_test_f20_0123456789FAKEKEY',
      FINTAVA_TIMEOUT_MS: '2000',
      FINTAVA_WEBHOOK_SECRET: FIN_SECRET,
      NUVION_WEBHOOK_SECRET: NUV_SECRET,
      WEBHOOK_RETENTION_DAYS: undefined,
    };
    for (const [k, v] of Object.entries(env)) {
      previous[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
        FintavaWebhookModule,
        NuvionWebhookModule,
        LedgerModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication(HUB_APP_OPTIONS);
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
    retention = moduleRef.get(WebhookRetentionService);
    consumer = moduleRef.get(LedgerConsumerService);
    registry = moduleRef.get(NuvionHandlerRegistry);
    dispatcher = moduleRef.get(NuvionWebhookDispatcher);
  });

  afterEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
    await double.stop();
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    guard.restore();
  });

  async function cleanup() {
    await prisma.$executeRaw`
      DELETE FROM "FintavaLedgerEntry" WHERE "id" IN (
        SELECT "entryId" FROM "FintavaLedgerReference" WHERE "value" LIKE ${`%${RUN}%`})`;
    await prisma.fintavaLedgerEntry.deleteMany({
      where: { wawuUserId: { in: wallets } },
    });
    await prisma.fintavaWebhookEvent.deleteMany({
      where: { reference: { startsWith: RUN } },
    });
    await prisma.nuvionWebhookEvent.deleteMany({
      where: { eventId: { startsWith: RUN } },
    });
    await prisma.fintavaWallet.deleteMany({
      where: { wawuUserId: { in: wallets } },
    });
    wallets.length = 0;
  }

  // -------------------------------------------------------------------------
  // Deliveries through the real routes, and rows made directly
  // -------------------------------------------------------------------------

  function fintavaText(
    reference: string,
    over: Record<string, unknown> = {},
    event = 'account_funded',
  ) {
    return JSON.stringify(
      {
        event,
        data: {
          amount: '100.00',
          reference,
          sessionID: `S-${reference}`,
          status: 'success',
          accountName: PERSON,
          narration: `rent from ${PERSON} ${PHONE}`,
          accountNumber: '0865231291',
          ...over,
        },
      },
      null,
      2,
    );
  }

  function sendFintava(text: string) {
    return request(app.getHttpServer() as Server)
      .post(FIN_PATH)
      .set('Content-Type', 'application/json')
      .set(
        FINTAVA_SIGNATURE_HEADER,
        signFintavaBody(FIN_SECRET, Buffer.from(text)),
      )
      .send(text);
  }

  /** Delivers a Fintava body through the route; returns the stored row. */
  async function deliverFintava(text: string) {
    const res = await sendFintava(text).expect(200);
    expect((res.body as { data: { outcome: string } }).data.outcome).toBe(
      'recorded',
    );
    return prisma.fintavaWebhookEvent.findUniqueOrThrow({
      where: { bodySha256: sha(Buffer.from(text)) },
    });
  }

  function nuvionBody(
    id: string,
    event = 'payment_dispute.created',
    over: Record<string, unknown> = {},
  ) {
    return JSON.stringify({
      event,
      data: {
        id: `01HXYZ${id}`.slice(0, 40),
        amount: 10000,
        currency: 'NGN',
        entity_id: '01HXYZ5303ABCDEFGHJKMNPQRS',
        narration: `Invoice payment received from ${PERSON} ${PHONE}`,
        ...over,
      },
    });
  }

  function sendNuvion(
    raw: string,
    o: { id: string; timestamp?: string; signedWith?: string },
  ) {
    const timestamp = o.timestamp ?? new Date().toISOString();
    return request(app.getHttpServer() as Server)
      .post(NUV_PATH)
      .set('Content-Type', 'application/json')
      .set('x-nuvion-event-id', o.id)
      .set('x-nuvion-event-timestamp', timestamp)
      .set(
        'x-nuvion-event-signature',
        signNuvionDelivery(
          NUV_SECRET,
          o.signedWith ?? timestamp,
          Buffer.from(raw),
        ),
      )
      .send(raw);
  }

  async function deliverNuvion(raw: string, id = uniq(), timestamp?: string) {
    const ts = timestamp ?? new Date().toISOString();
    const res = await sendNuvion(raw, { id, timestamp: ts }).expect(200);
    expect((res.body as { data: { outcome: string } }).data.outcome).toBe(
      'recorded',
    );
    return prisma.nuvionWebhookEvent.findUniqueOrThrow({
      where: { eventId: id },
    });
  }

  const outcomeOf = (res: { body: unknown }) =>
    (res.body as { data: { outcome: string } }).data.outcome;

  /** Moves a row's received time back, as if it had been received `days` ago. */
  const ageFintava = (id: string, days: number, ms = 0) =>
    prisma.fintavaWebhookEvent.update({
      where: { id },
      data: { receivedAt: new Date(Date.now() - days * DAY - ms) },
    });
  const ageNuvion = (id: string, days: number, ms = 0) =>
    prisma.nuvionWebhookEvent.update({
      where: { id },
      data: { receivedAt: new Date(Date.now() - days * DAY - ms) },
    });

  /** A Fintava row made directly, in a state, `days` old. */
  async function fintavaRow(o: {
    state: 'pending' | 'processed' | 'failed' | 'unrecognised';
    days: number;
    event?: string;
    keyed?: boolean;
  }) {
    const reference = uniq();
    const text = fintavaText(reference, {}, o.event ?? 'account_funded');
    const bytes = Buffer.from(text);
    return prisma.fintavaWebhookEvent.create({
      data: {
        event: o.event ?? 'account_funded',
        eventRaw: o.event ?? 'account_funded',
        reference,
        referenceField: 'data.reference',
        fintavaStatus: 'SUCCESS',
        dataReference: reference,
        rawBody: new Uint8Array(bytes),
        payload: JSON.parse(text) as object,
        bodySha256: o.keyed === false ? null : sha(bytes),
        processingStatus: o.state,
        note: o.state === 'pending' ? null : `ledger: ${o.state} (spec)`,
        receivedAt: new Date(Date.now() - o.days * DAY),
        processedAt:
          o.state === 'pending' ? null : new Date(Date.now() - o.days * DAY),
      },
    });
  }

  /** A Nuvion row made directly, in a state, `days` old. */
  async function nuvionRow(o: {
    state: 'pending' | 'processed' | 'failed' | 'unrecognised' | 'test';
    days: number;
  }) {
    const eventId = uniq();
    const raw = nuvionBody(eventId);
    const bytes = Buffer.from(raw);
    return prisma.nuvionWebhookEvent.create({
      data: {
        eventId,
        event: 'payment_dispute.created',
        resourceId: `01HXYZ${eventId}`.slice(0, 40),
        entityId: '01HXYZ5303ABCDEFGHJKMNPQRS',
        signedAt: new Date(Date.now() - o.days * DAY).toISOString(),
        bodySha256: sha(bytes),
        rawBody: new Uint8Array(bytes),
        payload: JSON.parse(raw) as object,
        processingStatus: o.state,
        note: o.state === 'pending' ? null : `SPEC: ${o.state}`,
        receivedAt: new Date(Date.now() - o.days * DAY),
        processedAt:
          o.state === 'pending' ? null : new Date(Date.now() - o.days * DAY),
      },
    });
  }

  const finRow = (id: string) =>
    prisma.fintavaWebhookEvent.findUniqueOrThrow({ where: { id } });
  const nuvRow = (id: string) =>
    prisma.nuvionWebhookEvent.findUniqueOrThrow({ where: { id } });

  /** Every column the repeat check and the readers use: all but the body and the marker. */
  const kept = <T extends { rawBody: unknown; payload: unknown }>(row: T) => {
    const { rawBody, payload, bodyClearedAt, ...rest } = row as T & {
      bodyClearedAt?: unknown;
    };
    void rawBody;
    void payload;
    void bodyClearedAt;
    return rest;
  };

  const hasBody = (row: { rawBody: Uint8Array | Buffer }) =>
    row.rawBody.length > 0;

  /**
   * Watches the job's clearing statements (the ones that lock with SKIP
   * LOCKED): the SQL, its values and how many rows each cleared. Calls
   * through to the database.
   */
  function watchClearing() {
    const seen: Array<{
      sql: string;
      text: string;
      values: unknown[];
      rows: number;
    }> = [];
    const original = prisma.$queryRaw.bind(prisma) as (
      ...a: unknown[]
    ) => Promise<unknown>;
    const spy = jest.spyOn(prisma, '$queryRaw').mockImplementation(((
      ...args: unknown[]
    ) => {
      const q = args[0] as {
        sql?: string;
        text?: string;
        values?: unknown[];
      };
      const result = original(...args);
      if (q && typeof q.sql === 'string' && q.sql.includes('SKIP LOCKED')) {
        return result.then((rows) => {
          seen.push({
            sql: q.sql as string,
            text: q.text as string,
            values: q.values ?? [],
            rows: (rows as unknown[]).length,
          });
          return rows;
        });
      }
      return result;
    }) as never);
    return { seen, stop: () => spy.mockRestore() };
  }

  /** The personal data in a Fintava or Nuvion row's body, searched in the database. */
  async function holdsPersonalData(
    table: 'FintavaWebhookEvent' | 'NuvionWebhookEvent',
    id: string,
  ): Promise<boolean> {
    const rows =
      table === 'FintavaWebhookEvent'
        ? await prisma.$queryRaw<Array<{ n: number }>>`
            SELECT count(*)::int AS n FROM "FintavaWebhookEvent"
             WHERE "id" = ${id}
               AND (position(convert_to(${PERSON}, 'UTF8') in "rawBody") > 0
                    OR "payload"::text LIKE ${`%${PERSON}%`}
                    OR "payload"::text LIKE ${`%${PHONE}%`})`
        : await prisma.$queryRaw<Array<{ n: number }>>`
            SELECT count(*)::int AS n FROM "NuvionWebhookEvent"
             WHERE "id" = ${id}
               AND (position(convert_to(${PERSON}, 'UTF8') in "rawBody") > 0
                    OR "payload"::text LIKE ${`%${PERSON}%`}
                    OR "payload"::text LIKE ${`%${PHONE}%`})`;
    return rows[0].n > 0;
  }

  // -------------------------------------------------------------------------
  // Capability check 1: a delivery older than the period has no body after the
  // job runs; a newer one is untouched
  // -------------------------------------------------------------------------

  describe('a delivery older than the period has no body after the job runs; a newer one is untouched', () => {
    it('Fintava: old and finished is cleared (body and parsed copy only); 89 days, 1 day and a pending one are untouched', async () => {
      const old = await deliverFintava(fintavaText(uniq()));
      const nearly = await deliverFintava(fintavaText(uniq()));
      const fresh = await deliverFintava(fintavaText(uniq()));
      await prisma.fintavaWebhookEvent.updateMany({
        where: { id: { in: [old.id, nearly.id, fresh.id] } },
        data: {
          processingStatus: 'processed',
          processedAt: new Date(),
          note: 'ledger: recorded (spec)',
        },
      });
      await ageFintava(old.id, 100);
      await ageFintava(nearly.id, 89, 23 * 3_600_000);
      await ageFintava(fresh.id, 1);
      const before = await finRow(old.id);
      expect(hasBody(before)).toBe(true);
      expect(await holdsPersonalData('FintavaWebhookEvent', old.id)).toBe(true);

      const stamp = stampOf();
      const report = await retention.run(stamp);

      const after = await finRow(old.id);
      expect(after.rawBody.length).toBe(0);
      expect(after.payload).toBeNull();
      expect(after.bodyClearedAt).toEqual(stamp);
      expect(await holdsPersonalData('FintavaWebhookEvent', old.id)).toBe(
        false,
      );
      // Everything the repeat check and the readers use is as it was.
      expect(kept(after)).toEqual(kept(before));
      expect(after.bodySha256).toBe(before.bodySha256);
      expect(report.FintavaWebhookEvent.cleared).toBeGreaterThanOrEqual(1);

      for (const id of [nearly.id, fresh.id]) {
        const row = await finRow(id);
        expect(hasBody(row)).toBe(true);
        expect(row.payload).not.toBeNull();
        expect(row.bodyClearedAt).toBeNull();
      }
      expect(
        await prisma.fintavaWebhookEvent.count({
          where: { bodyClearedAt: stamp },
        }),
      ).toBe(report.FintavaWebhookEvent.cleared);
    });

    it('the period is counted from the time received, and a row received exactly a period ago is kept until it is older', async () => {
      const row = await fintavaRow({ state: 'processed', days: 0 });
      const received = row.receivedAt.getTime();
      const retention90 = 90 * DAY;
      // At exactly the period: not older, kept.
      const exact = new Date(received + retention90);
      await retention.run(exact);
      expect(hasBody(await finRow(row.id))).toBe(true);
      // One millisecond more: older, cleared.
      const later = new Date(received + retention90 + 1);
      await retention.run(later);
      const after = await finRow(row.id);
      expect(hasBody(after)).toBe(false);
      expect(after.bodyClearedAt).toEqual(later);
    });

    it('Nuvion: an old processed delivery and an old test delivery are cleared; newer ones are untouched', async () => {
      const old = await deliverNuvion(nuvionBody(uniq()));
      const test = await deliverNuvion(
        JSON.stringify({ event_group: 'cards', event_name: 'deleted' }),
      );
      const fresh = await deliverNuvion(nuvionBody(uniq()));
      expect(test.processingStatus).toBe('test');
      await prisma.nuvionWebhookEvent.updateMany({
        where: { id: { in: [old.id, fresh.id] } },
        data: { processingStatus: 'processed', processedAt: new Date() },
      });
      await ageNuvion(old.id, 100);
      await ageNuvion(test.id, 100);
      await ageNuvion(fresh.id, 10);
      const before = await nuvRow(old.id);
      expect(await holdsPersonalData('NuvionWebhookEvent', old.id)).toBe(true);

      const stamp = stampOf();
      const report = await retention.run(stamp);

      for (const id of [old.id, test.id]) {
        const row = await nuvRow(id);
        expect(row.rawBody.length).toBe(0);
        expect(row.payload).toBeNull();
        expect(row.bodyClearedAt).toEqual(stamp);
      }
      expect(kept(await nuvRow(old.id))).toEqual(kept(before));
      expect(await holdsPersonalData('NuvionWebhookEvent', old.id)).toBe(false);
      const untouched = await nuvRow(fresh.id);
      expect(hasBody(untouched)).toBe(true);
      expect(untouched.bodyClearedAt).toBeNull();
      expect(
        await prisma.nuvionWebhookEvent.count({
          where: { bodyClearedAt: stamp },
        }),
      ).toBe(report.NuvionWebhookEvent.cleared);
    });

    it('a delivery nothing has finished with keeps its body whatever its age: pending, failed and unrecognised, on both tables, and the run says how many', async () => {
      const f = {
        pending: await fintavaRow({
          state: 'pending',
          days: 400,
          event: 'card_payment',
        }),
        failed: await fintavaRow({ state: 'failed', days: 400 }),
        unrecognised: await fintavaRow({ state: 'unrecognised', days: 400 }),
      };
      const n = {
        pending: await nuvionRow({ state: 'pending', days: 400 }),
        failed: await nuvionRow({ state: 'failed', days: 400 }),
        unrecognised: await nuvionRow({ state: 'unrecognised', days: 400 }),
      };
      const report = await retention.run(stampOf());
      for (const row of Object.values(f)) {
        const after = await finRow(row.id);
        expect(hasBody(after)).toBe(true);
        expect(after.payload).toEqual(row.payload);
        expect(after.bodyClearedAt).toBeNull();
      }
      for (const row of Object.values(n)) {
        const after = await nuvRow(row.id);
        expect(hasBody(after)).toBe(true);
        expect(after.payload).toEqual(row.payload);
        expect(after.bodyClearedAt).toBeNull();
      }
      for (const state of ['pending', 'failed', 'unrecognised']) {
        expect(
          report.FintavaWebhookEvent.heldPastPeriod[state],
        ).toBeGreaterThanOrEqual(1);
        expect(
          report.NuvionWebhookEvent.heldPastPeriod[state],
        ).toBeGreaterThanOrEqual(1);
      }
    });

    it('a Fintava row without its bodySha256 is never cleared: the key its repeat check reads would be lost', async () => {
      const row = await fintavaRow({
        state: 'processed',
        days: 200,
        keyed: false,
      });
      await retention.run(stampOf());
      const after = await finRow(row.id);
      expect(hasBody(after)).toBe(true);
      expect(after.bodyClearedAt).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Capability check 2: a cleared delivery sent again is refused as a repeat
  // -------------------------------------------------------------------------

  describe('a cleared delivery sent again is refused as a repeat (both providers)', () => {
    it('Fintava: the same signed body through the route answers duplicate, writes nothing, puts nothing back, and the ledger is not told again', async () => {
      const double2 = await prisma.fintavaWallet.create({
        data: {
          wawuUserId: randomUUID(),
          customerId: randomUUID(),
          walletId: randomUUID(),
          accountNumber: `7${String(Date.now()).slice(-9)}`,
        },
      });
      wallets.push(double2.wawuUserId);
      const reference = uniq();
      const text = fintavaText(reference, {
        userId: double2.customerId,
        beneficiaryAccountNumber: double2.accountNumber,
        senderBankSortcode: '000014',
        channelCode: '3',
      });
      const stored = await deliverFintava(text);
      expect(await consumer.consume(stored.id)).toBe('processed');
      const ledgerRows = () =>
        prisma.fintavaLedgerReference.count({ where: { value: reference } });
      expect(await ledgerRows()).toBe(1);
      const entries = () =>
        prisma.fintavaLedgerEntry.count({
          where: { wawuUserId: double2.wawuUserId },
        });
      expect(await entries()).toBe(1);

      await ageFintava(stored.id, 100);
      const stamp = stampOf();
      await retention.run(stamp);
      expect((await finRow(stored.id)).bodyClearedAt).toEqual(stamp);

      const rowsBefore = await prisma.fintavaWebhookEvent.count({
        where: { reference: { startsWith: RUN } },
      });
      for (let i = 0; i < 3; i += 1) {
        const again = await sendFintava(text).expect(200);
        expect(outcomeOf(again)).toBe('duplicate');
      }
      expect(
        await prisma.fintavaWebhookEvent.count({
          where: { reference: { startsWith: RUN } },
        }),
      ).toBe(rowsBefore);
      const after = await finRow(stored.id);
      expect(after.rawBody.length).toBe(0);
      expect(after.payload).toBeNull();
      expect(after.processingStatus).toBe('processed');
      // The sent-again delivery left nothing pending for the ledger's sweep to
      // apply, and the sweep applies nothing of ours; the person's one row is
      // still one row.
      expect(
        await prisma.fintavaWebhookEvent.count({
          where: {
            reference: { startsWith: RUN },
            processingStatus: 'pending',
          },
        }),
      ).toBe(0);
      await consumer.sweep();
      expect(await entries()).toBe(1);
      expect(await ledgerRows()).toBe(1);
      // A cleared row handed to the consumer is skipped, never read as a
      // delivery it cannot parse.
      expect(await consumer.consume(stored.id)).toBe('skipped');
    });

    it('Nuvion: the same event id, with a new timestamp or another body, and the same signed pair under another event id, all answer duplicate; the handler is not told again', async () => {
      const seen: NuvionDelivery[] = [];
      registry.add({
        task: 'F20-SPEC',
        events: ['payment_dispute.created'],
        handle: (d) => {
          if (d.eventId.startsWith(RUN)) seen.push(d);
          return Promise.resolve({ outcome: 'done' as const, note: 'counted' });
        },
      });
      const id = uniq();
      const raw = nuvionBody(id);
      const signedAt = new Date().toISOString();
      const stored = await deliverNuvion(raw, id, signedAt);
      expect(await dispatcher.dispatch(stored.id)).toBe('processed');
      expect(seen).toHaveLength(1);

      await ageNuvion(stored.id, 100);
      const stamp = stampOf();
      await retention.run(stamp);
      expect((await nuvRow(stored.id)).bodyClearedAt).toEqual(stamp);

      const rowsBefore = await prisma.nuvionWebhookEvent.count({
        where: { eventId: { startsWith: RUN } },
      });
      // (a) Nuvion retries: the same event id and body, a new timestamp.
      const a = await sendNuvion(raw, {
        id,
        timestamp: new Date(Date.now() + 1000).toISOString(),
      }).expect(200);
      expect(outcomeOf(a)).toBe('duplicate');
      // (b) The same event id with another body: the event id is the key.
      const b = await sendNuvion(
        nuvionBody(id, 'payment_dispute.created', { amount: 1 }),
        {
          id,
        },
      ).expect(200);
      expect(outcomeOf(b)).toBe('duplicate');
      // (c) The same signed timestamp and body under another event id: the
      // signed pair is the key.
      const c = await sendNuvion(raw, {
        id: uniq(),
        timestamp: signedAt,
      }).expect(200);
      expect(outcomeOf(c)).toBe('duplicate');

      expect(
        await prisma.nuvionWebhookEvent.count({
          where: { eventId: { startsWith: RUN } },
        }),
      ).toBe(rowsBefore);
      const after = await nuvRow(stored.id);
      expect(after.rawBody.length).toBe(0);
      expect(after.payload).toBeNull();
      expect(after.processingStatus).toBe('processed');
      // Nothing of ours is pending, so no handler is told again; a cleared row
      // handed to the dispatcher is skipped.
      expect(
        await prisma.nuvionWebhookEvent.count({
          where: { eventId: { startsWith: RUN }, processingStatus: 'pending' },
        }),
      ).toBe(0);
      await dispatcher.sweep();
      expect(await dispatcher.dispatch(stored.id)).toBe('skipped');
      expect(seen).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Capability check 3: safe to run twice, and while a delivery is arriving
  // -------------------------------------------------------------------------

  describe('the job is safe to run twice, on two servers, and while a delivery arrives', () => {
    it('a second run finds nothing to clear and writes nothing', async () => {
      const row = await fintavaRow({ state: 'processed', days: 120 });
      const nuv = await nuvionRow({ state: 'processed', days: 120 });
      const first = stampOf();
      await retention.run(first);
      const fin1 = await finRow(row.id);
      const nuv1 = await nuvRow(nuv.id);
      expect(fin1.bodyClearedAt).toEqual(first);
      const second = stampOf();
      const report = await retention.run(second);
      expect(report.FintavaWebhookEvent.cleared).toBe(0);
      expect(report.NuvionWebhookEvent.cleared).toBe(0);
      expect(await finRow(row.id)).toEqual(fin1);
      expect(await nuvRow(nuv.id)).toEqual(nuv1);
    });

    it('one process runs the job once at a time: a call made while it runs does nothing', async () => {
      await fintavaRow({ state: 'processed', days: 120 });
      const now = stampOf();
      const [a, b] = await Promise.all([
        retention.run(now),
        retention.run(now),
      ]);
      expect([a.skipped, b.skipped].sort()).toEqual([false, true]);
    });

    it('two servers running it at once clear each row once between them, and leave a row a consumer holds to the next run', async () => {
      const second = new PrismaService();
      await second.$connect();
      const other = new WebhookRetentionService(second, new ConfigService({}));
      try {
        const fin = [];
        const nuv = [];
        for (let i = 0; i < 40; i += 1) {
          fin.push(await fintavaRow({ state: 'processed', days: 150 }));
          nuv.push(await nuvionRow({ state: 'processed', days: 150 }));
        }
        // A consumer is holding three of each (a row lock in a transaction).
        const heldFin = fin.slice(0, 3).map((r) => r.id);
        const heldNuv = nuv.slice(0, 3).map((r) => r.id);
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        let ready!: () => void;
        const locked = new Promise<void>((r) => (ready = r));
        const holder = prisma.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT "id" FROM "FintavaWebhookEvent" WHERE "id" = ANY(${heldFin}::text[]) FOR UPDATE`;
            await tx.$queryRaw`SELECT "id" FROM "NuvionWebhookEvent" WHERE "id" = ANY(${heldNuv}::text[]) FOR UPDATE`;
            ready();
            await gate;
          },
          { maxWait: 10_000, timeout: 60_000 },
        );
        await locked;

        const stamp = stampOf();
        const small = { batch: 7, budgetMs: 60_000 };
        const started = Date.now();
        const [a, b] = await Promise.all([
          retention.run(stamp, small),
          other.run(stamp, small),
        ]);
        // Neither waited for the held rows.
        expect(Date.now() - started).toBeLessThan(20_000);
        expect(a.skipped || b.skipped).toBe(false);
        for (const table of [
          'FintavaWebhookEvent',
          'NuvionWebhookEvent',
        ] as const) {
          expect(a[table].cleared + b[table].cleared).toBeGreaterThanOrEqual(
            37,
          );
        }
        // Each row was cleared by exactly one of the two: the rows stamped
        // with this run are the sum of what the two reported.
        const finStamped = await prisma.fintavaWebhookEvent.count({
          where: { bodyClearedAt: stamp },
        });
        const nuvStamped = await prisma.nuvionWebhookEvent.count({
          where: { bodyClearedAt: stamp },
        });
        expect(finStamped).toBe(
          a.FintavaWebhookEvent.cleared + b.FintavaWebhookEvent.cleared,
        );
        expect(nuvStamped).toBe(
          a.NuvionWebhookEvent.cleared + b.NuvionWebhookEvent.cleared,
        );
        for (const id of heldFin) {
          expect((await finRow(id)).bodyClearedAt).toBeNull();
        }
        for (const id of heldNuv) {
          expect((await nuvRow(id)).bodyClearedAt).toBeNull();
        }

        release();
        await holder;
        const next = stampOf();
        const rest = await retention.run(next);
        expect(rest.FintavaWebhookEvent.cleared).toBeGreaterThanOrEqual(3);
        expect(rest.NuvionWebhookEvent.cleared).toBeGreaterThanOrEqual(3);
        for (const id of heldFin) {
          expect((await finRow(id)).bodyClearedAt).toEqual(next);
        }
        for (const row of [...fin, ...nuv]) {
          const after =
            'eventId' in row ? await nuvRow(row.id) : await finRow(row.id);
          expect(after.rawBody.length).toBe(0);
        }
      } finally {
        await second.$disconnect();
      }
    });

    it('a delivery arriving while a batch is clearing: a new one is recorded at once, a repeat of a row in the batch waits for that statement and answers duplicate, and the job skips the locked rows', async () => {
      const old = await deliverFintava(fintavaText(uniq()));
      await prisma.fintavaWebhookEvent.update({
        where: { id: old.id },
        data: { processingStatus: 'processed', processedAt: new Date() },
      });
      await ageFintava(old.id, 100);
      const oldNuv = await deliverNuvion(nuvionBody(uniq()));
      await prisma.nuvionWebhookEvent.update({
        where: { id: oldNuv.id },
        data: { processingStatus: 'processed', processedAt: new Date() },
      });
      await ageNuvion(oldNuv.id, 100);
      const text = fintavaText(old.reference);
      const nuvRaw = Buffer.from(oldNuv.rawBody).toString('utf8');
      const others = [];
      for (let i = 0; i < 5; i += 1) {
        others.push(await fintavaRow({ state: 'processed', days: 100 }));
      }

      // The job's own statement on those two rows, begun and not yet committed
      // (the real one is a single statement of milliseconds; this one is held
      // open so that what arrives meanwhile can be seen).
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let ready!: () => void;
      const midRun = new Promise<void>((r) => (ready = r));
      const clearing = prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`
            UPDATE "FintavaWebhookEvent"
               SET "rawBody" = ''::bytea, "payload" = 'null'::jsonb,
                   "bodyClearedAt" = now()
             WHERE "id" = ${old.id}`;
          await tx.$executeRaw`
            UPDATE "NuvionWebhookEvent"
               SET "rawBody" = ''::bytea, "payload" = 'null'::jsonb,
                   "bodyClearedAt" = now()
             WHERE "id" = ${oldNuv.id}`;
          ready();
          await gate;
        },
        { maxWait: 10_000, timeout: 60_000 },
      );
      await midRun;

      const blocked = Symbol('blocked');
      const within = async <T>(p: Promise<T>, ms = 8000): Promise<T | symbol> =>
        Promise.race([
          p,
          new Promise<symbol>((r) => setTimeout(() => r(blocked), ms)),
        ]);

      // A new delivery is a new row: recorded while the batch is open.
      const freshText = fintavaText(uniq());
      const fresh = await within(sendFintava(freshText));
      expect(fresh).not.toBe(blocked);
      expect(outcomeOf(fresh as { body: unknown })).toBe('recorded');
      const freshNuv = await within(
        sendNuvion(nuvionBody(uniq()), { id: uniq() }),
      );
      expect(freshNuv).not.toBe(blocked);
      expect(outcomeOf(freshNuv as { body: unknown })).toBe('recorded');

      // The job, started now, does not wait for the rows the open statement
      // holds: it clears the others and leaves those to the next run.
      const stamp = stampOf();
      const ran = await within(retention.run(stamp), 15_000);
      expect(ran).not.toBe(blocked);
      for (const row of others) {
        expect((await finRow(row.id)).bodyClearedAt).toEqual(stamp);
      }
      const freshRow = await prisma.fintavaWebhookEvent.findUniqueOrThrow({
        where: { bodySha256: sha(Buffer.from(freshText)) },
      });
      expect(hasBody(freshRow)).toBe(true);
      expect(freshRow.bodyClearedAt).toBeNull();

      // A delivery sent again for a row in that very batch: Postgres makes an
      // insert that conflicts with a row being updated wait for the updater
      // (the unique key is the row's), so it is held for as long as the
      // statement is open and no longer. Here the statement is held open for
      // 300 ms; the real one is milliseconds.
      const repeatFin = sendFintava(text).then((r) => r);
      const repeatNuv = sendNuvion(nuvRaw, { id: oldNuv.eventId }).then(
        (r) => r,
      );
      await new Promise((r) => setTimeout(r, 300));
      release();
      await clearing;
      const answers = await within(Promise.all([repeatFin, repeatNuv]));
      expect(answers).not.toBe(blocked);
      for (const res of answers as Array<{ status: number; body: unknown }>) {
        expect(res.status).toBe(200);
        expect(outcomeOf(res)).toBe('duplicate');
      }
      const done = await finRow(old.id);
      expect(done.rawBody.length).toBe(0);
      expect(done.processingStatus).toBe('processed');
      expect(
        await prisma.fintavaWebhookEvent.count({
          where: { bodySha256: sha(Buffer.from(text)) },
        }),
      ).toBe(1);
    });

    it('a run is bounded: no statement clears more than `batch` rows, and a spent time budget leaves the rest for the next run', async () => {
      for (let i = 0; i < 25; i += 1) {
        await fintavaRow({ state: 'processed', days: 100 });
      }
      const watch = watchClearing();
      try {
        const stamp = stampOf();
        const report = await retention.run(stamp, {
          batch: 10,
          budgetMs: 60_000,
        });
        expect(report.FintavaWebhookEvent.cleared).toBeGreaterThanOrEqual(25);
        expect(report.FintavaWebhookEvent.stoppedEarly).toBe(false);
        // Ten, ten and five: three statements for twenty-five rows.
        const sizes = watch.seen
          .filter((s) => s.sql.includes('"FintavaWebhookEvent"'))
          .map((s) => s.rows);
        expect(Math.max(...sizes)).toBe(10);
        expect(sizes.reduce((a, b) => a + b, 0)).toBe(
          report.FintavaWebhookEvent.cleared,
        );
        expect(report.FintavaWebhookEvent.batches).toBe(sizes.length);
        expect(
          await prisma.fintavaWebhookEvent.count({
            where: { bodyClearedAt: stamp },
          }),
        ).toBe(report.FintavaWebhookEvent.cleared);
      } finally {
        watch.stop();
      }

      for (let i = 0; i < 5; i += 1) {
        await fintavaRow({ state: 'processed', days: 100 });
      }
      const spent = await retention.run(stampOf(), { batch: 10, budgetMs: 0 });
      expect(spent.FintavaWebhookEvent.stoppedEarly).toBe(true);
      expect(spent.FintavaWebhookEvent.cleared).toBe(0);
      expect(spent.NuvionWebhookEvent.stoppedEarly).toBe(true);
      const left = await prisma.fintavaWebhookEvent.count({
        where: {
          reference: { startsWith: RUN },
          bodyClearedAt: null,
          processingStatus: 'processed',
        },
      });
      expect(left).toBe(5);
      const next = await retention.run(stampOf());
      expect(next.FintavaWebhookEvent.cleared).toBeGreaterThanOrEqual(5);
    });

    it('one table failing does not stop the other: the error is reported by name only and the other table is cleared', async () => {
      const fin = await fintavaRow({ state: 'processed', days: 100 });
      const nuv = await nuvionRow({ state: 'processed', days: 100 });
      const original = prisma.$queryRaw.bind(prisma) as (
        ...a: unknown[]
      ) => Promise<unknown>;
      const spy = jest.spyOn(prisma, '$queryRaw').mockImplementation(((
        ...args: unknown[]
      ) => {
        const q = args[0] as { sql?: string };
        if (q?.sql?.includes('UPDATE "FintavaWebhookEvent"')) {
          const boom = new Error(`boom with ${PHONE}`);
          boom.name = 'BoomError';
          return Promise.reject(boom);
        }
        return original(...args);
      }) as never);
      const lines: string[] = [];
      const error = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation((...a: unknown[]) => {
          lines.push(a.map(String).join(' '));
        });
      let report;
      try {
        report = await retention.run(stampOf());
      } finally {
        spy.mockRestore();
        error.mockRestore();
      }
      expect(report.FintavaWebhookEvent.error).toBe('BoomError');
      expect(report.FintavaWebhookEvent.cleared).toBe(0);
      expect(report.NuvionWebhookEvent.error).toBeNull();
      expect(hasBody(await finRow(fin.id))).toBe(true);
      expect(hasBody(await nuvRow(nuv.id))).toBe(false);
      expect(lines.join('\n')).toContain(
        'FintavaWebhookEvent failed (BoomError)',
      );
      expect(lines.join('\n')).not.toContain(PHONE);
      // The next run finishes what this one could not.
      const next = await retention.run(stampOf());
      expect(next.FintavaWebhookEvent.error).toBeNull();
      expect(hasBody(await finRow(fin.id))).toBe(false);
    });

    it('the statement that picks rows to clear uses the partial index (the planner is shown the real statement, with sequential scans off)', async () => {
      await fintavaRow({ state: 'processed', days: 100 });
      await nuvionRow({ state: 'processed', days: 100 });
      const watch = watchClearing();
      try {
        await retention.run(stampOf());
      } finally {
        watch.stop();
      }
      for (const [table, index] of [
        ['FintavaWebhookEvent', 'FintavaWebhookEvent_body_retention_idx'],
        ['NuvionWebhookEvent', 'NuvionWebhookEvent_body_retention_idx'],
      ]) {
        const statement = watch.seen.find((s) =>
          s.sql.includes(`UPDATE "${table}"`),
        );
        expect(statement).toBeDefined();
        const plan = await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
          return tx.$queryRawUnsafe<Array<Record<string, string>>>(
            `EXPLAIN ${statement!.text}`,
            ...statement!.values,
          );
        });
        expect(plan.map((p) => Object.values(p)[0]).join('\n')).toContain(
          index,
        );
      }
    });
  });

  // -------------------------------------------------------------------------
  // The database holds the rule
  // -------------------------------------------------------------------------

  describe('the database refuses a row marked cleared that still has its body', () => {
    const refusal = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (e) {
        return String((e as Error).message) + JSON.stringify(e);
      }
      return '';
    };

    it('Fintava: marked cleared with a body, or without its bodySha256, is refused; a cleared row with both its hash and no body is accepted', async () => {
      const row = await fintavaRow({ state: 'processed', days: 1 });
      expect(
        await refusal(
          prisma.$executeRaw`UPDATE "FintavaWebhookEvent" SET "bodyClearedAt" = now() WHERE "id" = ${row.id}`,
        ),
      ).toContain('FintavaWebhookEvent_body_cleared_check');
      expect(
        await refusal(
          prisma.$executeRaw`UPDATE "FintavaWebhookEvent" SET "rawBody" = ''::bytea, "bodyClearedAt" = now() WHERE "id" = ${row.id}`,
        ),
      ).toContain('FintavaWebhookEvent_body_cleared_check');
      expect(
        await refusal(
          prisma.$executeRaw`UPDATE "FintavaWebhookEvent" SET "rawBody" = ''::bytea, "payload" = 'null'::jsonb, "bodySha256" = NULL, "bodyClearedAt" = now() WHERE "id" = ${row.id}`,
        ),
      ).toContain('FintavaWebhookEvent_body_cleared_check');
      expect(
        await refusal(
          prisma.$executeRaw`UPDATE "FintavaWebhookEvent" SET "rawBody" = ''::bytea, "payload" = 'null'::jsonb, "bodyClearedAt" = now() WHERE "id" = ${row.id}`,
        ),
      ).toBe('');
    });

    it('Nuvion: marked cleared with a body or a parsed copy is refused; a cleared row is accepted', async () => {
      const row = await nuvionRow({ state: 'processed', days: 1 });
      expect(
        await refusal(
          prisma.$executeRaw`UPDATE "NuvionWebhookEvent" SET "bodyClearedAt" = now() WHERE "id" = ${row.id}`,
        ),
      ).toContain('NuvionWebhookEvent_body_cleared_check');
      expect(
        await refusal(
          prisma.$executeRaw`UPDATE "NuvionWebhookEvent" SET "rawBody" = ''::bytea, "bodyClearedAt" = now() WHERE "id" = ${row.id}`,
        ),
      ).toContain('NuvionWebhookEvent_body_cleared_check');
      expect(
        await refusal(
          prisma.$executeRaw`UPDATE "NuvionWebhookEvent" SET "rawBody" = ''::bytea, "payload" = 'null'::jsonb, "bodyClearedAt" = now() WHERE "id" = ${row.id}`,
        ),
      ).toBe('');
    });
  });

  // -------------------------------------------------------------------------
  // The daily job, its setting and its logs
  // -------------------------------------------------------------------------

  describe('the daily job', () => {
    it('is registered at 02:40 under its name, and its tick runs the retention', async () => {
      const mod = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
          ScheduleModule.forRoot(),
          WebhookRetentionModule,
        ],
      }).compile();
      const own = mod.createNestApplication();
      await own.init();
      try {
        const job = own
          .get(SchedulerRegistry)
          .getCronJob(WEBHOOK_RETENTION_SCHEDULE.name);
        expect(job.cronTime.source).toBe('0 40 2 * * *');
        const row = await fintavaRow({ state: 'processed', days: 200 });
        await job.fireOnTick();
        // The tick does not hand its promise back to the caller, so wait for
        // the work to show.
        let after = await finRow(row.id);
        for (let i = 0; i < 100 && after.bodyClearedAt === null; i += 1) {
          await new Promise((r) => setTimeout(r, 100));
          after = await finRow(row.id);
        }
        expect(after.rawBody.length).toBe(0);
        expect(after.bodyClearedAt).not.toBeNull();
      } finally {
        await own.close();
      }
    });

    it('takes its period from WEBHOOK_RETENTION_DAYS', async () => {
      const thirty = new WebhookRetentionService(
        prisma,
        new ConfigService({ [WEBHOOK_RETENTION_CONFIG_KEYS.days]: '30' }),
      );
      const forty = await fintavaRow({ state: 'processed', days: 40 });
      const twenty = await fintavaRow({ state: 'processed', days: 20 });
      await thirty.run(stampOf());
      expect(hasBody(await finRow(forty.id))).toBe(false);
      expect(hasBody(await finRow(twenty.id))).toBe(true);
      // And the default, 90 days, leaves the row of 20 days alone.
      await retention.run(stampOf());
      expect(hasBody(await finRow(twenty.id))).toBe(true);
    });

    it('stops the app at boot on a setting that is not a number of days from 7 to 3650', async () => {
      process.env[WEBHOOK_RETENTION_CONFIG_KEYS.days] = '3';
      try {
        await expect(
          Test.createTestingModule({
            imports: [
              ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
              WebhookRetentionModule,
            ],
          }).compile(),
        ).rejects.toThrow(/WEBHOOK_RETENTION_DAYS must be a whole number/);
      } finally {
        delete process.env[WEBHOOK_RETENTION_CONFIG_KEYS.days];
      }
    });

    it('logs counts and state names only, never a body', async () => {
      await fintavaRow({ state: 'processed', days: 200 });
      await nuvionRow({ state: 'processed', days: 200 });
      await fintavaRow({ state: 'failed', days: 200 });
      const lines: string[] = [];
      const log = jest
        .spyOn(Logger.prototype, 'log')
        .mockImplementation((...a: unknown[]) => {
          lines.push(a.map(String).join(' '));
        });
      const error = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation((...a: unknown[]) => {
          lines.push(a.map(String).join(' '));
        });
      try {
        await retention.run(stampOf());
      } finally {
        log.mockRestore();
        error.mockRestore();
      }
      const said = lines.join('\n');
      expect(said).toContain('webhook retention:');
      expect(said).toContain('FintavaWebhookEvent cleared');
      expect(said).toContain('held past the period: failed');
      for (const secret of [PERSON, PHONE, FIN_SECRET, NUV_SECRET, RUN]) {
        expect(said).not.toContain(secret);
      }
    });
  });
});
