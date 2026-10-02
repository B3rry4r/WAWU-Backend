import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { inspect } from 'node:util';
import {
  ConsoleLogger,
  INestApplication,
  Logger,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { THROTTLER_SKIP } from '@nestjs/throttler/dist/throttler.constants';
import request, { type Response } from 'supertest';
import {
  accountFunded,
  cardPayment,
  customerBankTransfer,
  debitTransferReversal,
  PERSONAL_DATA,
  virtualWalletPayment,
  walletToWallet,
} from '../../../../test/fintava/fintava-webhook-payloads';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { HUB_APP_OPTIONS } from '../../../hub-app-options';
import {
  HUB_THROTTLERS,
  SKIP_EVERY_HUB_THROTTLER,
} from '../../../hub-throttlers';
import { FintavaWebhookController } from '../fintava-webhook.controller';
import {
  FINTAVA_SIGNATURE_HEADER,
  signFintavaBody,
} from '../fintava-signature';
import { FintavaWebhookModule } from '../fintava-webhook.module';
import { FintavaWebhookService } from '../fintava-webhook.service';
import type { FintavaWebhookAck } from '../fintava-webhook-view.type';

/**
 * MONEY-07 over HTTP, against a real database.
 *
 * There is no tunnel (DECISIONS R-25), so no delivery here came from
 * Fintava: every body is built from Fintava's documented format
 * (test/fintava/fintava-webhook-payloads.ts, from the mobile repo's
 * `docs/fintava/reference/webhook-events.md`), signed here with a local
 * secret exactly as `reference/verifying-events.md` describes, and sent to
 * this app's own endpoint.
 *
 * The app is built with the same options as src/main.ts (HUB_APP_OPTIONS)
 * and the same global pipe, filter and interceptor. Every reference carries
 * this run's id, so the run owns its rows and afterAll deletes them.
 *
 * Every log line the app writes, on every channel (Nest's Logger, stdout,
 * stderr, console.*), is captured for the whole file; the last test checks
 * none of it holds the secret, a signature or a payload's personal data.
 */

const SECRET = 'whsec_local_m07_Kx4Rb8Nq2Tz6Wd1Fh9';
const RUN = `m07-${randomUUID().slice(0, 8)}`;
const PATH = '/api/hub/webhooks/fintava';

const captured: string[] = [];
const restores: Array<() => void> = [];
const signaturesSent: string[] = [];

function capture(target: object, method: string): void {
  const t = target as Record<string, (...a: unknown[]) => unknown>;
  const original = t[method];
  t[method] = (...args: unknown[]) => {
    captured.push(
      args
        .map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 8 })))
        .join(' '),
    );
    return true;
  };
  restores.push(() => {
    t[method] = original;
  });
}

function windows(secret: string, size = 8): string[] {
  const out: string[] = [];
  for (let i = 0; i + size <= secret.length; i += 1)
    out.push(secret.slice(i, i + size));
  return out;
}

type Ack = { statusCode: number; message: string; data: FintavaWebhookAck };
const ack = (res: Response): FintavaWebhookAck => (res.body as Ack).data;

/** Every level on: whatever the app logs is printed, and so captured. */
const everyLevel = () =>
  new ConsoleLogger({
    logLevels: ['log', 'error', 'warn', 'debug', 'verbose', 'fatal'],
  });

/**
 * The app as production composes it for this route: the same options
 * (raw body), pipe, filter and interceptor, AND AppModule's rate limits
 * (HUB_THROTTLERS) behind the same global ThrottlerGuard, so a route that
 * forgets to skip them is refused here as it would be live.
 */
async function buildApp(options = HUB_APP_OPTIONS) {
  // setLogger: a TestingModule otherwise swaps in Nest's TestingLogger,
  // which prints errors only and would hide every other line from the check.
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true }),
      ThrottlerModule.forRoot([...HUB_THROTTLERS]),
      FintavaWebhookModule,
    ],
    providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
  })
    .setLogger(everyLevel())
    .compile();
  const app = moduleRef.createNestApplication(options);
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
  const server = app.getHttpServer() as Server;
  const { port } = server.address() as AddressInfo;
  return { app, moduleRef, url: `http://127.0.0.1:${port}` };
}

describe('Fintava webhooks (MONEY-07) over HTTP', () => {
  let app: INestApplication;
  let url: string;
  let prisma: PrismaService;
  const previousSecret = process.env.FINTAVA_WEBHOOK_SECRET;

  /** Sends `text` exactly as given, signed (or not) as asked. */
  function send(
    text: string,
    signature: string | null = signFintavaBody(
      SECRET,
      Buffer.from(text, 'utf8'),
    ),
    base = url,
  ) {
    const req = request(base)
      .post(PATH)
      .set('Content-Type', 'application/json');
    if (signature !== null) {
      signaturesSent.push(signature);
      req.set(FINTAVA_SIGNATURE_HEADER, signature);
    }
    return req.send(text);
  }

  const rowsFor = (reference: string) =>
    prisma.fintavaWebhookEvent.findMany({ where: { reference } });

  /** Rows whose raw bytes contain `fragment` (rawBody is bytea). */
  async function rowsWithRaw(fragment: string) {
    const ids = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "FintavaWebhookEvent"
      WHERE position(convert_to(${fragment}, 'UTF8') in "rawBody") > 0`;
    return prisma.fintavaWebhookEvent.findMany({
      where: { id: { in: ids.map((r) => r.id) } },
    });
  }

  const rawText = (row: { rawBody: Uint8Array }) =>
    Buffer.from(row.rawBody).toString('utf8');

  beforeAll(async () => {
    capture(process.stdout, 'write');
    capture(process.stderr, 'write');
    for (const m of ['log', 'info', 'warn', 'error', 'debug', 'trace'])
      capture(console, m);
    Logger.overrideLogger(everyLevel());
    process.env.FINTAVA_WEBHOOK_SECRET = SECRET;
    const built = await buildApp();
    app = built.app;
    url = built.url;
    prisma = built.moduleRef.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.$executeRaw`
      DELETE FROM "FintavaWebhookEvent"
      WHERE position(convert_to(${RUN}, 'UTF8') in "rawBody") > 0`;
    await app.close();
    if (previousSecret === undefined) delete process.env.FINTAVA_WEBHOOK_SECRET;
    else process.env.FINTAVA_WEBHOOK_SECRET = previousSecret;
    Logger.overrideLogger(new ConsoleLogger());
    for (const restore of restores.reverse()) restore();
  });

  beforeEach(() => {
    process.env.FINTAVA_WEBHOOK_SECRET = SECRET;
  });

  describe('a forged delivery is refused, and never reaches the database', () => {
    it('a signature made with another secret, a missing one, one for another body, or a malformed one: 401, nothing stored, no insert tried', async () => {
      const text = accountFunded(`${RUN}-forged`);
      const raw = Buffer.from(text, 'utf8');
      const reference = `000014231211154211281900319598-${RUN}-forged`;
      const insert = jest.spyOn(prisma.fintavaWebhookEvent, 'createMany');
      try {
        const forgeries: Array<string | null> = [
          signFintavaBody('not-the-secret', raw),
          null,
          signFintavaBody(SECRET, Buffer.from(accountFunded(`${RUN}-other`))),
          signFintavaBody(SECRET, raw).slice(0, 100),
          'f'.repeat(128),
          `sha512=${signFintavaBody(SECRET, raw)}`,
        ];
        for (const signature of forgeries) {
          const res = await send(text, signature);
          expect(res.status).toBe(401);
          expect(res.body).toMatchObject({ statusCode: 401, data: null });
        }
        expect(insert).not.toHaveBeenCalled();
      } finally {
        insert.mockRestore();
      }
      expect(await rowsFor(reference)).toHaveLength(0);
    });

    it('with no FINTAVA_WEBHOOK_SECRET set, even a correctly signed delivery is refused (fails closed)', async () => {
      const text = accountFunded(`${RUN}-nosecret`);
      delete process.env.FINTAVA_WEBHOOK_SECRET;
      const res = await send(text);
      expect(res.status).toBe(401);
      expect((res.body as { message: string }).message).toBe(
        'Fintava webhooks are not configured on this server.',
      );
      process.env.FINTAVA_WEBHOOK_SECRET = '   ';
      expect((await send(text)).status).toBe(401);
      expect(
        await rowsFor(`000014231211154211281900319598-${RUN}-nosecret`),
      ).toHaveLength(0);
    });

    it('no token is needed: the signature is the only credential', async () => {
      const res = await send(accountFunded(`${RUN}-notoken`));
      expect(res.status).toBe(200);
      expect(ack(res)).toEqual({
        outcome: 'recorded',
        event: 'account_funded',
      });
    });
  });

  describe('the same webhook delivered three times is processed once', () => {
    it('three identical deliveries: 200 each, recorded once, then duplicate twice; one row', async () => {
      const text = customerBankTransfer(`${RUN}-thrice`);
      const outcomes: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const res = await send(text);
        expect(res.status).toBe(200);
        outcomes.push(ack(res).outcome);
      }
      expect(outcomes).toEqual(['recorded', 'duplicate', 'duplicate']);

      const rows = await rowsFor(`FIO241106308911000370001675-${RUN}-thrice`);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        event: 'customer_bank_transfer',
        eventRaw: 'customer_bank_transfer',
        referenceField: 'data.customerReference',
        fintavaStatus: 'SUCCESS',
        dataReference: `2e076e1-019a-4a3c-b1a6-65b0d98-${RUN}-thrice`,
        dataCustomerReference: `FIO241106308911000370001675-${RUN}-thrice`,
        processingStatus: 'pending',
        processedAt: null,
        note: null,
      });
      expect(Buffer.from(rows[0].rawBody).equals(Buffer.from(text))).toBe(true);
      expect(rows[0].payload).toEqual(JSON.parse(text));
      expect(rows[0].receivedAt).toBeInstanceOf(Date);
    });

    it('a later delivery with a new status for the same transaction is recorded too, once', async () => {
      const reference = `FIO241106308911000370001675-${RUN}-status`;
      const pending = customerBankTransfer(`${RUN}-status`, 'PENDING');
      const success = customerBankTransfer(`${RUN}-status`, 'SUCCESS');
      expect(ack(await send(pending)).outcome).toBe('recorded');
      expect(ack(await send(success)).outcome).toBe('recorded');
      expect(ack(await send(pending)).outcome).toBe('duplicate');
      expect(ack(await send(success)).outcome).toBe('duplicate');
      const rows = await rowsFor(reference);
      expect(rows.map((r) => r.fintavaStatus).sort()).toEqual([
        'PENDING',
        'SUCCESS',
      ]);
    });

    it('the reversal of a send is its own event, not a duplicate of the send', async () => {
      const send1 = customerBankTransfer(`${RUN}-rev`);
      const reversal = debitTransferReversal(`${RUN}-rev`);
      expect(ack(await send(send1)).outcome).toBe('recorded');
      expect(ack(await send(reversal))).toEqual({
        outcome: 'recorded',
        event: 'debit_transfer_reversal',
      });
      const both = await prisma.fintavaWebhookEvent.findMany({
        where: {
          dataCustomerReference: `FIO241106308911000370001675-${RUN}-rev`,
        },
      });
      expect(both.map((r) => r.event).sort()).toEqual([
        'customer_bank_transfer',
        'debit_transfer_reversal',
      ]);
    });
  });

  describe('two copies at the same moment are processed once (the unique key, not a check)', () => {
    it('10 identical deliveries sent together over HTTP: one recorded, nine duplicates, one row', async () => {
      const text = walletToWallet(`${RUN}-race`);
      const results = await Promise.all(
        Array.from({ length: 10 }, () => send(text)),
      );
      expect(results.map((r) => r.status)).toEqual(Array(10).fill(200));
      const outcomes = results.map((r) => ack(r).outcome);
      expect(outcomes.filter((o) => o === 'recorded')).toHaveLength(1);
      expect(outcomes.filter((o) => o === 'duplicate')).toHaveLength(9);
      expect(
        await rowsFor(`48VYIuIAZTSVQlZ8O900JdcUJ0imoVZ1L-${RUN}-race`),
      ).toHaveLength(1);
    });

    it('25 calls into the service at once, with no HTTP in between: one row', async () => {
      const service = app.get(FintavaWebhookService);
      const text = virtualWalletPayment(`${RUN}-race2`);
      const raw = Buffer.from(text, 'utf8');
      const body = JSON.parse(text) as unknown;
      const acks = await Promise.all(
        Array.from({ length: 25 }, () => service.record(raw, body)),
      );
      expect(acks.filter((a) => a.outcome === 'recorded')).toHaveLength(1);
      expect(await rowsFor(`9TTEER288282882818-${RUN}-race2`)).toHaveLength(1);
    });
  });

  describe('the raw body', () => {
    it('the signature is checked over the bytes as sent: spacing, key order, 100.0 and escapes kept; the bytes are stored', async () => {
      const text =
        `{ "data" : {"amount":100.0,  "accountName":"Ad\\u00e9 \\"Ola\\"",` +
        `"reference":"RAW-${RUN}","status":"success"},\n\t"event":"account_funded" }`;
      const parsedAgain = JSON.stringify(JSON.parse(text));
      expect(parsedAgain).not.toBe(text);

      // Signed over a re-serialisation of the same JSON: refused.
      const reserialisedSig = signFintavaBody(
        SECRET,
        Buffer.from(parsedAgain, 'utf8'),
      );
      expect((await send(text, reserialisedSig)).status).toBe(401);
      expect(await rowsFor(`RAW-${RUN}`)).toHaveLength(0);

      // Signed over the exact bytes: accepted, and stored byte for byte.
      const res = await send(text);
      expect(res.status).toBe(200);
      const [row] = await rowsFor(`RAW-${RUN}`);
      expect(rawText(row)).toBe(text);
      expect(row.payload).toEqual({
        data: {
          amount: 100,
          accountName: 'Adé "Ola"',
          reference: `RAW-${RUN}`,
          status: 'success',
        },
        event: 'account_funded',
      });
    });

    it('a body that is not JSON cannot be checked: 400, nothing stored', async () => {
      const text = `event=account_funded&reference=FORM-${RUN}`;
      const res = await request(url)
        .post(PATH)
        .set('Content-Type', 'text/plain')
        .set(
          FINTAVA_SIGNATURE_HEADER,
          signFintavaBody(SECRET, Buffer.from(text, 'utf8')),
        )
        .send(text);
      expect(res.status).toBe(400);
      expect(await rowsWithRaw(`FORM-${RUN}`)).toHaveLength(0);
    });

    it('an app built without rawBody refuses every delivery (400) and stores nothing, so main.ts must keep it', async () => {
      const bare = await buildApp({});
      try {
        const text = accountFunded(`${RUN}-bare`);
        const res = await send(text, undefined, bare.url);
        expect(res.status).toBe(400);
        expect(
          await rowsFor(`000014231211154211281900319598-${RUN}-bare`),
        ).toHaveLength(0);
      } finally {
        await bare.app.close();
      }
    });

    it('src/main.ts creates the app with HUB_APP_OPTIONS, which keeps the raw body', () => {
      expect(HUB_APP_OPTIONS.rawBody).toBe(true);
      const main = readFileSync(join(__dirname, '../../../main.ts'), 'utf8');
      expect(main).toMatch(
        /NestFactory\.create\(\s*AppModule,\s*HUB_APP_OPTIONS\s*\)/,
      );
    });
  });

  describe('every documented event is recorded pending for its task; nothing else is touched', () => {
    it.each([
      [
        'account_funded',
        accountFunded,
        `000014231211154211281900319598`,
        'data.reference',
        'SUCCESS',
      ],
      [
        'virtual_wallet_payment',
        virtualWalletPayment,
        `9TTEER288282882818`,
        'data.merchantReference',
        'PAID',
      ],
      [
        'wallet_to_wallet_transfer_v2',
        walletToWallet,
        `48VYIuIAZTSVQlZ8O900JdcUJ0imoVZ1L`,
        'data.reference',
        '',
      ],
      [
        'debit_transfer_reversal',
        debitTransferReversal,
        `r-tyqwA0xLFh2ifNhDX9BWSgzGb0C`,
        'data.reversalRef',
        'SUCCESS',
      ],
    ])(
      '%s',
      async (event, build, referenceBase, referenceField, fintavaStatus) => {
        const run = `${RUN}-each`;
        const res = await send(build(run));
        expect(res.status).toBe(200);
        expect(ack(res)).toEqual({ outcome: 'recorded', event });
        const rows = await rowsFor(`${referenceBase}-${run}`);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          event,
          referenceField,
          fintavaStatus,
          processingStatus: 'pending',
        });
      },
    );

    it('a card payment with no reference is keyed on its body hash; an unknown event is kept as unrecognised', async () => {
      const card = cardPayment(`${RUN}-card`);
      expect(ack(await send(card)).outcome).toBe('recorded');
      expect(ack(await send(card)).outcome).toBe('duplicate');
      const cardRows = await rowsWithRaw(`${RUN}-card`);
      expect(cardRows).toHaveLength(1);
      expect(cardRows[0]).toMatchObject({
        event: 'card_payment',
        referenceField: 'body.sha256',
        processingStatus: 'pending',
      });
      expect(cardRows[0].reference).toMatch(/^sha256:[0-9a-f]{64}$/);

      const unknown = `{"event":"transfer_success","data":{"reference":"UNK-${RUN}","accountName":"John Doe"}}`;
      const res = await send(unknown);
      expect(res.status).toBe(200);
      expect(ack(res)).toEqual({
        outcome: 'recorded',
        event: 'transfer_success',
      });
      const [row] = await rowsFor(`UNK-${RUN}`);
      expect(row.processingStatus).toBe('unrecognised');
    });
  });

  describe('no rate limit applies to the webhook', () => {
    it('30 different signed deliveries in the same second, through the real global ThrottlerGuard: 30 times 200, 30 rows, no 429', async () => {
      // AppModule allows 20 a second (`short`): without the skip, 10 of
      // these are refused with 429 and lost until Fintava resends.
      const shortLimit = HUB_THROTTLERS.find((t) => t.name === 'short')!;
      const count = shortLimit.limit + 10;
      const bodies = Array.from({ length: count }, (_, i) =>
        walletToWallet(`${RUN}-burst-${i}`),
      );
      const started = Date.now();
      const results = await Promise.all(bodies.map((b) => send(b)));
      expect(Date.now() - started).toBeLessThan(shortLimit.ttl);
      expect(results.map((r) => r.status)).toEqual(Array(count).fill(200));
      expect(results.every((r) => ack(r).outcome === 'recorded')).toBe(true);
      expect(await rowsWithRaw(`${RUN}-burst-`)).toHaveLength(count);
    });

    it('the skip names every throttler AppModule registers, so a new one is skipped too', () => {
      const names = HUB_THROTTLERS.map((t) => t.name);
      expect(Object.keys(SKIP_EVERY_HUB_THROTTLER).sort()).toEqual(
        [...names].sort(),
      );
      for (const name of names) {
        expect(
          Reflect.getMetadata(THROTTLER_SKIP + name, FintavaWebhookController),
        ).toBe(true);
      }
      const appModule = readFileSync(
        join(__dirname, '../../../app.module.ts'),
        'utf8',
      );
      expect(appModule).toMatch(
        /ThrottlerModule\.forRoot\(\[\.\.\.HUB_THROTTLERS\]\)/,
      );
    });
  });

  describe('a delivery with a NUL in it', () => {
    it('is stored once: raw bytes exact, NUL replaced in the payload and the key, and a replay is a duplicate', async () => {
      // JSON writes a NUL as the escape \u0000; Postgres text and json
      // refuse it, so before the fix every retry answered 503.
      const text =
        `{"event":"customer_bank_transfer","data":{` +
        `"customerReference":"NUL\\u0000REF-${RUN}",` +
        `"reference":"NULREF2-${RUN}",` +
        `"description":"Pay\\u0000ment from \\u0000 bank",` +
        `"na\\u0000me":"x","status":"SUCCESS"}}`;
      expect(text).toContain('\\u0000');

      const first = await send(text);
      expect(first.status).toBe(200);
      expect(ack(first)).toEqual({
        outcome: 'recorded',
        event: 'customer_bank_transfer',
      });
      expect(ack(await send(text)).outcome).toBe('duplicate');
      expect(ack(await send(text)).outcome).toBe('duplicate');

      const rows = await rowsFor(`NUL�REF-${RUN}`);
      expect(rows).toHaveLength(1);
      const [row] = rows;
      expect(row).toMatchObject({
        referenceField: 'data.customerReference',
        dataCustomerReference: `NUL�REF-${RUN}`,
        processingStatus: 'pending',
      });
      // The bytes Fintava signed, exactly.
      expect(Buffer.from(row.rawBody).equals(Buffer.from(text, 'utf8'))).toBe(
        true,
      );
      expect(signFintavaBody(SECRET, Buffer.from(row.rawBody))).toBe(
        signFintavaBody(SECRET, Buffer.from(text, 'utf8')),
      );
      expect(row.payload).toEqual({
        event: 'customer_bank_transfer',
        data: {
          customerReference: `NUL�REF-${RUN}`,
          reference: `NULREF2-${RUN}`,
          description: 'Pay�ment from � bank',
          'na�me': 'x',
          status: 'SUCCESS',
        },
      });
    });
  });

  describe('no secret or personal data in logs', () => {
    it('a database failure answers 503 (Fintava resends) and logs only the error name and code', async () => {
      const text = accountFunded(`${RUN}-dbdown`);
      const insert = jest
        .spyOn(prisma.fintavaWebhookEvent, 'createMany')
        .mockRejectedValueOnce(
          Object.assign(
            new Error(
              `Invalid invocation: { data: [{ rawBody: ${text}, secret: ${SECRET} }] }`,
            ),
            { name: 'PrismaClientKnownRequestError', code: 'P1001' },
          ),
        );
      try {
        const res = await send(text);
        expect(res.status).toBe(503);
        expect(JSON.stringify(res.body)).not.toContain('John Doe');
      } finally {
        insert.mockRestore();
      }
      expect(
        captured.some((l) =>
          l.includes(
            'account_funded: not stored (PrismaClientKnownRequestError P1001)',
          ),
        ),
      ).toBe(true);
    });

    it('a body that is not valid JSON is refused before anything reads it', async () => {
      const text = `{"event":"account_funded","data":{"accountName":"John Doe","accountNumber":"0865231291",`;
      const res = await send(text);
      expect(res.status).toBe(400);
    });

    it("nothing captured in this file holds the secret, any 8 characters of it, a signature, or a payload's personal data", () => {
      // The run wrote lines: the check is not passing on silence.
      expect(
        captured.some((l) =>
          l.includes('fintava webhook account_funded: recorded'),
        ),
      ).toBe(true);
      expect(
        captured.some((l) => l.includes('refused: signature does not match')),
      ).toBe(true);
      expect(captured.some((l) => l.includes('refused: no signature'))).toBe(
        true,
      );
      expect(
        captured.some((l) => l.includes('FINTAVA_WEBHOOK_SECRET is not set')),
      ).toBe(true);

      const all = captured.join('\n');
      for (const w of windows(SECRET)) expect(all).not.toContain(w);
      for (const sig of signaturesSent) {
        expect(all).not.toContain(sig.slice(0, 16));
      }
      for (const personal of PERSONAL_DATA) expect(all).not.toContain(personal);
      // No reference value either: lines name the field, never the value.
      expect(all).not.toContain('000014231211154211281900319598');
      expect(all).not.toContain('FIO241106308911000370001675');
    });
  });
});
