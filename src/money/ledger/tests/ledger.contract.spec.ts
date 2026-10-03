import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  INestApplication,
  LoggerService,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  FintavaDouble,
  fintavaError,
  MERCHANT_ACCOUNT,
  MERCHANT_BALANCE,
  type SeenRequest,
} from '../../../../test/fintava/fintava-double';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  FINTAVA_SIGNATURE_HEADER,
  signFintavaBody,
} from '../../../fintava/webhook/fintava-signature';
import { FintavaWebhookModule } from '../../../fintava/webhook/fintava-webhook.module';
import { HUB_APP_OPTIONS } from '../../../hub-app-options';
import { LedgerConsumerService } from '../ledger-consumer.service';
import { LedgerModule } from '../ledger.module';
import { LedgerService } from '../ledger.service';

/**
 * The ledger (task MONEY-10) over its real inputs: a delivery signed locally
 * with a local secret and posted to MONEY-07's real route (there is no
 * tunnel, R-25), stored by MONEY-07, then consumed by the ledger's sweep
 * against a real database, with the real MONEY-06 client asking a local
 * Fintava double (test/fintava/fintava-double.ts) over a socket.
 *
 * Deliveries are Fintava's documented shapes (mobile repo
 * `docs/fintava/reference/webhook-events.md`), field for field, with this
 * run's own account numbers and references, so the run owns every row it
 * writes and deletes them at the end.
 */

const RUN = `m10${Date.now().toString(36)}`;
const SECRET = 'whsec_local_m10_Qv7Lp3Xc9Ty2Hb5Jn';
const KEY = 'live_test_ledger_0123456789FAKEKEY';
const PATH = '/api/hub/webhooks/fintava';
const HOUR = 3_600_000;

class QuietLogger implements LoggerService {
  lines: string[] = [];
  log(...a: unknown[]) {
    this.lines.push(a.map(String).join(' '));
  }
  error(...a: unknown[]) {
    this.lines.push(a.map(String).join(' '));
  }
  warn(...a: unknown[]) {
    this.lines.push(a.map(String).join(' '));
  }
  debug() {}
  verbose() {}
  fatal(...a: unknown[]) {
    this.lines.push(a.map(String).join(' '));
  }
}

/** A transaction record as Fintava's lookups and history answer (`sandbox/11-`, `09-`). */
function fintavaRecord(o: {
  id: string;
  fintava: string;
  ours: string | null;
  amount: string;
  status?: string;
  tagapay?: string;
  createdAt?: string;
}) {
  const at = o.createdAt ?? new Date().toISOString();
  return {
    id: o.id,
    createdAt: at,
    updatedAt: at,
    amount: o.amount,
    amountPayable: null,
    transType: 'AATRANSFER',
    entry: 'DEBIT',
    reference: o.fintava,
    CustomerReference: o.ours,
    narration: 'ledger test',
    currency: 'NGN',
    status: o.status ?? 'SUCCESS',
    recipientDetails: 'Ada Sandbox',
    senderDetails: 'Test Account4',
    senderBank: 'Loma Bank',
    receiverBank: 'Loma Bank',
    sessionId: null,
    ...(o.tagapay ? { tagapayTransRef: o.tagapay } : {}),
  };
}

/** `wallet_to_wallet_transfer_v2`, the documented field set. */
function w2wDelivery(o: {
  from: string;
  to: string;
  amount: number | string;
  reference: string;
  customerReference?: string;
  fee?: number;
  fromName?: string;
  toName?: string;
}) {
  const data: Record<string, unknown> = {
    amount: o.amount,
    reference: o.reference,
    ...(o.customerReference ? { customerReference: o.customerReference } : {}),
    total: o.amount,
    transaction_fee: o.fee ?? 0,
    target_customer_id: randomUUID(),
    source_customer_id: randomUUID(),
    target_customer_accname: o.toName ?? 'Ada Sandbox',
    source_customer_accname: o.fromName ?? 'Test Account4',
    target_customer_accno: o.to,
    source_customer_accno: o.from,
    source_customer_wallet: o.from,
    target_customer_wallet: o.to,
    target_availableBalance: 22,
    target_bookedBalance: 22,
    source_availableBalance: 187,
    source_bookedBalance: 187,
    description: 'Fund transfer between customers',
    customer_id: randomUUID(),
  };
  return JSON.stringify(
    { event: 'wallet_to_wallet_transfer_v2', data },
    null,
    2,
  );
}

function bankTransferDelivery(o: {
  customerId: string;
  customerReference: string;
  reference: string;
  status: string;
  destination?: string;
}) {
  return JSON.stringify(
    {
      event: 'customer_bank_transfer',
      data: {
        amount: 100,
        vat: 0,
        reference: o.reference,
        customerId: o.customerId,
        availableBalance: 109.52,
        bookedBalance: 109.52,
        status: o.status,
        total: 130.75,
        description: 'Payment',
        destination: o.destination ?? '81450/100004',
        sessionID: `S-${o.reference}`,
        customerReference: o.customerReference,
        senderName: 'Bayo Sandbox',
        senderAccountNumber: '0000037726',
        charges: 30.75,
      },
    },
    null,
    2,
  );
}

function reversalDelivery(o: {
  customerId: string;
  customerReference: string;
  transactionReference: string;
  reversalRef: string;
  status?: string;
}) {
  return JSON.stringify(
    {
      event: 'debit_transfer_reversal',
      data: {
        amount: 100,
        charges: 30.75,
        vat: 0,
        accountName: 'ABC Nigeria Ltd',
        accountNumber: '00126',
        customerId: o.customerId,
        customerReference: o.customerReference,
        type: 'CREDIT',
        status: o.status ?? 'success',
        total: 130.75,
        transactionReference: o.transactionReference,
        description: 'Transfer reversal',
        destination: '5509704/090405',
        reversalRef: o.reversalRef,
      },
    },
    null,
    2,
  );
}

describe('The ledger (MONEY-10) fed by stored Fintava deliveries', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let ledger: LedgerService;
  let consumer: LedgerConsumerService;
  const double = new FintavaDouble();
  const logger = new QuietLogger();
  const previous: Record<string, string | undefined> = {};
  const wallets: string[] = [];
  let seq = 0;

  /** What the double answers, per reference and per id. */
  const byReference = new Map<string, { status: number; body: unknown }>();
  const byId = new Map<string, unknown>();
  let merchantRows: unknown[] = [];
  const customerRows = new Map<string, unknown[]>();

  const ref = (name: string) => `${name}-${RUN}-${(seq += 1)}`;

  async function addWallet() {
    const wawuUserId = randomUUID();
    const customerId = randomUUID();
    seq += 1;
    const accountNumber = `7${String(Date.now()).slice(-7)}${String(seq % 100).padStart(2, '0')}`;
    await prisma.fintavaWallet.create({
      data: { wawuUserId, customerId, walletId: randomUUID(), accountNumber },
    });
    wallets.push(wawuUserId);
    return { wawuUserId, customerId, accountNumber };
  }

  /** Posts `text` to the real webhook route, signed with the local secret; returns its stored event id. */
  async function deliver(text: string, marker: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post(PATH)
      .set('Content-Type', 'application/json')
      .set(FINTAVA_SIGNATURE_HEADER, signFintavaBody(SECRET, Buffer.from(text)))
      .send(text);
    expect(res.status).toBe(200);
    const ids = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "FintavaWebhookEvent"
       WHERE position(convert_to(${text}, 'UTF8') in "rawBody") > 0`;
    expect(ids.length).toBeGreaterThanOrEqual(1);
    void marker;
    return ids[0].id;
  }

  const event = (id: string) =>
    prisma.fintavaWebhookEvent.findUniqueOrThrow({ where: { id } });

  /** Every ledger row holding any of these references. */
  async function rowsFor(...refs: string[]) {
    const hits = await prisma.fintavaLedgerReference.findMany({
      where: { value: { in: refs } },
      select: { entryId: true },
    });
    return prisma.fintavaLedgerEntry.findMany({
      where: { id: { in: [...new Set(hits.map((h) => h.entryId))] } },
      orderBy: { direction: 'asc' },
    });
  }

  const fintavaCalls = (pattern: RegExp) =>
    double.seen.filter((s: SeenRequest) => pattern.test(s.path)).length;

  beforeAll(async () => {
    await double.start();
    double
      .on('GET', '/merchant/balance', { status: 200, body: MERCHANT_BALANCE })
      .on('GET', /^\/transaction\/reference\//, (req) => {
        const r = decodeURIComponent(
          req.path.replace('/transaction/reference/', ''),
        );
        return (
          byReference.get(r) ?? {
            status: 404,
            body: fintavaError(404, 'Transaction not found!'),
          }
        );
      })
      .on('GET', /^\/transaction\/id\//, (req) => {
        const id = decodeURIComponent(req.path.replace('/transaction/id/', ''));
        return {
          status: 200,
          body: byId.get(id) ?? {
            data: null,
            status: 200,
            message: 'successful',
          },
        };
      })
      .on('GET', '/txn/merchant', () => ({
        status: 200,
        body: {
          data: merchantRows,
          meta: {
            page: '1',
            take: '100',
            itemCount: merchantRows.length,
            pageCount: 1,
            hasPreviousPage: false,
            hasNextPage: false,
          },
        },
      }))
      .on('GET', '/txn', (req) => {
        const rows = customerRows.get(req.query.customerId) ?? [];
        return {
          status: 200,
          body: {
            data: {
              data: rows,
              meta: {
                page: '1',
                take: '100',
                itemCount: rows.length,
                pageCount: 1,
                hasPreviousPage: false,
                hasNextPage: false,
              },
            },
            status: 200,
            message: 'Customer transactions fetched',
          },
        };
      });
    const env = {
      FINTAVA_BASE_URL: double.baseUrl,
      FINTAVA_API_KEY: KEY,
      FINTAVA_TIMEOUT_MS: '2000',
      FINTAVA_WEBHOOK_SECRET: SECRET,
    };
    for (const [k, v] of Object.entries(env)) {
      previous[k] = process.env[k];
      process.env[k] = v;
    }
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
        FintavaWebhookModule,
        LedgerModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication({ ...HUB_APP_OPTIONS, logger });
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
    prisma = moduleRef.get(PrismaService);
    ledger = moduleRef.get(LedgerService);
    consumer = moduleRef.get(LedgerConsumerService);
  });

  afterAll(async () => {
    const pattern = `%${RUN}%`;
    await prisma.$executeRaw`
      DELETE FROM "FintavaLedgerEntry" WHERE "id" IN (
        SELECT "entryId" FROM "FintavaLedgerReference" WHERE "value" LIKE ${pattern})`;
    await prisma.fintavaLedgerEntry.deleteMany({
      where: { wawuUserId: { in: wallets } },
    });
    await prisma.$executeRaw`
      DELETE FROM "FintavaWebhookEvent"
       WHERE position(convert_to(${RUN}, 'UTF8') in "rawBody") > 0`;
    await prisma.fintavaWallet.deleteMany({
      where: { wawuUserId: { in: wallets } },
    });
    await app.close();
    await double.stop();
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  describe('each movement once, with the right sign, in kobo', () => {
    it("WAWU sends ₦10 to a person: one out row on WAWU's wallet and one in row on theirs, confirmed with Fintava", async () => {
      const a = await addWallet();
      const ours = ref('OURS');
      const fin = ref('FIN');
      const tag = ref('TAG');
      const id = randomUUID();
      byReference.set(fin, {
        status: 200,
        body: {
          data: fintavaRecord({ id, fintava: fin, ours, amount: '10.00' }),
          status: 200,
          message: 'successful',
        },
      });
      byId.set(id, {
        data: fintavaRecord({
          id,
          fintava: fin,
          ours,
          amount: '10.00',
          tagapay: tag,
        }),
        status: 200,
      });

      // As the transfer response names them: `reference` is the tagapay
      // one and `customerReference` is Fintava's (G-19, `sandbox/11-`).
      const e = await deliver(
        w2wDelivery({
          from: MERCHANT_ACCOUNT,
          to: a.accountNumber,
          amount: 10,
          reference: tag,
          customerReference: fin,
        }),
        tag,
      );
      expect(await consumer.consume(e)).toBe('processed');

      const rows = await rowsFor(tag);
      expect(rows).toHaveLength(2);
      const [incoming, outgoing] = rows;
      expect(outgoing).toMatchObject({
        walletKind: 'merchant',
        wawuUserId: null,
        accountNumber: MERCHANT_ACCOUNT,
        direction: 'out',
        status: 'completed',
        category: 'transfer',
        amountKobo: 1000n,
        feeKobo: 0n,
        totalKobo: 1000n,
        customerReference: ours,
        fintavaReference: fin,
        tagapayTransRef: tag,
        fintavaTransactionId: id,
        counterpartyKind: 'wawu_user',
        counterpartyWawuUserId: a.wawuUserId,
        source: 'webhook',
        sourceEventId: e,
      });
      expect(incoming).toMatchObject({
        walletKind: 'user',
        wawuUserId: a.wawuUserId,
        accountNumber: a.accountNumber,
        direction: 'in',
        status: 'completed',
        amountKobo: 1000n,
        feeKobo: 0n,
        totalKobo: 1000n,
        // Ours is the sender's reference; on the receiving row it is only an alias.
        customerReference: null,
        counterpartyKind: 'wawu',
      });
      expect(incoming.completedAt).toBeInstanceOf(Date);
      const ev = await event(e);
      expect(ev.processingStatus).toBe('processed');
      expect(ev.note).toMatch(
        /out recorded; in recorded; confirmed with Fintava/,
      );
    });

    it('the same movement delivered again, under other statuses and shapes, and consumed concurrently: still one row per side', async () => {
      const a = await addWallet();
      const fin = ref('FIN');
      const tag = ref('TAG');
      const id = randomUUID();
      byReference.set(fin, {
        status: 200,
        body: {
          data: fintavaRecord({
            id,
            fintava: fin,
            ours: ref('OURS'),
            amount: '2.75',
          }),
          status: 200,
        },
      });
      const shapes = [
        w2wDelivery({
          from: MERCHANT_ACCOUNT,
          to: a.accountNumber,
          amount: 2.75,
          reference: tag,
          customerReference: fin,
        }),
        // The documented delivery: only `reference`.
        w2wDelivery({
          from: MERCHANT_ACCOUNT,
          to: a.accountNumber,
          amount: '2.75',
          reference: tag,
        }),
        // A status Fintava might add: a new MONEY-07 row for the same transfer.
        w2wDelivery({
          from: MERCHANT_ACCOUNT,
          to: a.accountNumber,
          amount: 2.75,
          reference: fin,
        }).replace(
          '"amount": 2.75,',
          '"amount": 2.75,\n    "status": "SUCCESS",',
        ),
      ];
      const ids: string[] = [];
      for (const text of shapes) {
        ids.push(await deliver(text, tag));
        // MONEY-07 keeps a byte-identical retry once.
        await deliver(text, tag);
      }
      expect(new Set(ids).size).toBe(3);

      const outcomes = await Promise.all([
        ...ids.map((i) => consumer.consume(i)),
        ...ids.map((i) => consumer.consume(i)),
        consumer.sweep(),
      ]);
      const perEvent = outcomes.filter((o) => typeof o === 'string');
      expect(
        perEvent.filter((o) => o === 'processed').length,
      ).toBeLessThanOrEqual(3);
      // Whatever the interleaving, every delivery ends processed, once.
      await consumer.consume(ids[0]);
      for (const i of ids)
        expect((await event(i)).processingStatus).toBe('processed');

      const rows = await rowsFor(tag, fin);
      expect(
        rows.map((r) => `${r.walletKind} ${r.direction} ${r.amountKobo}`),
      ).toEqual(['user in 275', 'merchant out 275']);
      // Every reference ended up on the one row of its side.
      const refsOnOut = await prisma.fintavaLedgerReference.findMany({
        where: { entryId: rows[1].id },
      });
      expect(refsOnOut.map((r) => r.value)).toEqual(
        expect.arrayContaining([tag, fin]),
      );
    });

    it('ten writers racing with overlapping references: one row, all references on it (the key, not a read, decides)', async () => {
      const a = await addWallet();
      const r1 = ref('R1');
      const r2 = ref('R2');
      const r3 = ref('R3');
      const sets = [
        [r1],
        [r2],
        [r1, r2],
        [r3, r1],
        [r2, r3],
        [r3],
        [r1, r2, r3],
        [r2],
        [r1],
        [r3, r2],
      ];
      const results = await Promise.all(
        sets.map((delivery) =>
          ledger.record({
            wallet: {
              kind: 'user',
              wawuUserId: a.wawuUserId,
              accountNumber: a.accountNumber,
            },
            direction: 'in',
            status: 'completed',
            category: 'transfer',
            amountKobo: 123456789,
            references: { delivery },
            source: 'webhook',
          }),
        ),
      );
      const rows = await rowsFor(r1, r2, r3);
      // r1, r2 and r3 are tied together by the writers that name two of them.
      expect(rows).toHaveLength(1);
      expect(rows[0].amountKobo).toBe(123456789n);
      expect(
        new Set(results.map((r) => r.entryId)).size,
      ).toBeGreaterThanOrEqual(1);
      expect(results.filter((r) => r.created).length).toBeGreaterThanOrEqual(1);
      const held = await prisma.fintavaLedgerReference.findMany({
        where: { entryId: rows[0].id },
      });
      expect(held.map((h) => h.value).sort()).toEqual([r1, r2, r3].sort());
    });

    it("the feature that sent it recorded it first: the delivery adds the receiver's row and no second debit", async () => {
      const a = await addWallet();
      const b = await addWallet();
      const ours = ref('OURS');
      const fin = ref('FIN');
      const tag = ref('TAG');
      // As WALLET-07 would, from the MONEY-06 receipt.
      const own = await ledger.record({
        wallet: {
          kind: 'user',
          wawuUserId: a.wawuUserId,
          accountNumber: a.accountNumber,
        },
        direction: 'out',
        status: 'completed',
        category: 'transfer',
        amountKobo: 1000,
        feeKobo: 0,
        providerFeeKobo: 2325,
        wawuFeeKobo: 1000,
        counterparty: {
          kind: 'wawu_user',
          name: 'Bayo',
          wawuUserId: b.wawuUserId,
        },
        note: 'for lunch',
        references: {
          customerReference: ours,
          fintavaReference: fin,
          tagapayTransRef: tag,
        },
        source: 'send',
      });
      expect(own.created).toBe(true);
      const before = fintavaCalls(/^\/(transaction|txn)/);
      const e = await deliver(
        w2wDelivery({
          from: a.accountNumber,
          to: b.accountNumber,
          amount: 10,
          reference: tag,
        }),
        tag,
      );
      expect(await consumer.consume(e)).toBe('processed');
      const rows = await rowsFor(tag);
      expect(rows.map((r) => `${r.wawuUserId} ${r.direction}`)).toEqual([
        `${b.wawuUserId} in`,
        `${a.wawuUserId} out`,
      ]);
      const out = rows[1];
      expect(out.id).toBe(own.entryId);
      // The sender's description is kept; the delivery only filled gaps.
      expect(out).toMatchObject({
        note: 'for lunch',
        providerFeeKobo: 2325n,
        wawuFeeKobo: 1000n,
        counterpartyName: 'Bayo',
        source: 'send',
        sourceEventId: e,
        discrepancy: null,
      });
      // A's side identified the movement: B's row takes its references and
      // nothing is asked of Fintava.
      expect(fintavaCalls(/^\/(transaction|txn)/)).toBe(before);
      expect(rows[0]).toMatchObject({
        status: 'completed',
        amountKobo: 1000n,
        customerReference: null,
        fintavaReference: fin,
        tagapayTransRef: tag,
        counterpartyKind: 'wawu_user',
        counterpartyWawuUserId: a.wawuUserId,
      });
      expect((await event(e)).note).toMatch(
        /identified by the side already held/,
      );
    });

    it("G-19: a row known only by ours and Fintava's reference, a delivery carrying only the tagapay one: history and the by-id record tie them, one row", async () => {
      const a = await addWallet();
      const ours = ref('OURS');
      const fin = ref('FIN');
      const tag = ref('TAG');
      const id = randomUUID();
      await ledger.record({
        wallet: { kind: 'merchant', accountNumber: MERCHANT_ACCOUNT },
        direction: 'out',
        status: 'pending',
        category: 'refund',
        amountKobo: 1000,
        references: { customerReference: ours, fintavaReference: fin },
        source: 'lookup',
      });
      // The merchant's history lists the debit without tagapayTransRef
      // (`sandbox/10-`); only the by-id record carries it (`sandbox/12-`).
      merchantRows = [
        fintavaRecord({
          id: randomUUID(),
          fintava: ref('OTHER'),
          ours: ref('OTHER'),
          amount: '10.00',
        }),
        fintavaRecord({ id, fintava: fin, ours, amount: '10.00' }),
      ];
      byId.set(id, {
        data: fintavaRecord({
          id,
          fintava: fin,
          ours,
          amount: '10.00',
          tagapay: tag,
        }),
        status: 200,
      });

      const e = await deliver(
        w2wDelivery({
          from: MERCHANT_ACCOUNT,
          to: a.accountNumber,
          amount: 10,
          reference: tag,
        }),
        tag,
      );
      expect(await consumer.consume(e)).toBe('processed');
      merchantRows = [];
      const outs = (await rowsFor(tag, fin, ours)).filter(
        (r) => r.direction === 'out',
      );
      expect(outs).toHaveLength(1);
      expect(outs[0]).toMatchObject({
        status: 'completed',
        category: 'refund',
        customerReference: ours,
        tagapayTransRef: tag,
      });
    });
  });

  describe('when Fintava cannot confirm', () => {
    it('a lookup answering {} leaves the delivery pending with a note; it lands once Fintava answers', async () => {
      const a = await addWallet();
      const fin = ref('FIN');
      byReference.set(fin, { status: 200, body: {} });
      const e = await deliver(
        // From a Fintava wallet that is not WAWU's: no history to read.
        w2wDelivery({
          from: '0020886993',
          to: a.accountNumber,
          amount: 50,
          reference: fin,
          fromName: 'John Services Limited',
        }),
        fin,
      );
      expect(await consumer.consume(e)).toBe('waiting');
      expect(await event(e)).toMatchObject({ processingStatus: 'pending' });
      expect((await event(e)).note).toMatch(
        /waiting for Fintava to confirm \(empty_lookup\)/,
      );
      expect(await rowsFor(fin)).toHaveLength(0);

      byReference.set(fin, {
        status: 200,
        body: {
          data: fintavaRecord({
            id: randomUUID(),
            fintava: fin,
            ours: 'THEIRS-1',
            amount: '50.00',
          }),
          status: 200,
        },
      });
      expect(await consumer.consume(e)).toBe('processed');
      const rows = await rowsFor(fin);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        direction: 'in',
        amountKobo: 5000n,
        counterpartyKind: 'bank_account',
        counterpartyName: 'John Services Limited',
        // Not ours: another sender's CustomerReference is only an alias here.
        customerReference: null,
      });
    });

    it('past the confirm window a movement is recorded from the signed delivery alone, with a note', async () => {
      const a = await addWallet();
      const fin = ref('FIN');
      byReference.set(fin, { status: 200, body: {} });
      const e = await deliver(
        w2wDelivery({
          from: '0020886993',
          to: a.accountNumber,
          amount: 1,
          reference: fin,
        }),
        fin,
      );
      expect(await consumer.consume(e, new Date(Date.now() + 73 * HOUR))).toBe(
        'processed',
      );
      expect((await event(e)).note).toMatch(
        /could not confirm it within the window/,
      );
      expect(await rowsFor(fin)).toHaveLength(1);
    });
  });

  describe('reversals', () => {
    it('a bank send settles, then comes back: the same row becomes reversed, never a second debit, and stays reversed', async () => {
      const b = await addWallet();
      const ours = ref('FIO');
      const fin = ref('BT');
      // WALLET-09 records its send with our reference before Fintava settles it.
      const own = await ledger.record({
        wallet: {
          kind: 'user',
          wawuUserId: b.wawuUserId,
          accountNumber: b.accountNumber,
        },
        direction: 'out',
        status: 'pending',
        category: 'transfer',
        amountKobo: 10000,
        feeKobo: 3075,
        references: { customerReference: ours },
        source: 'send',
      });
      const settled = await deliver(
        bankTransferDelivery({
          customerId: b.customerId,
          customerReference: ours,
          reference: fin,
          status: 'SUCCESS',
        }),
        ours,
      );
      expect(await consumer.consume(settled)).toBe('processed');
      let rows = await prisma.fintavaLedgerEntry.findMany({
        where: { wawuUserId: b.wawuUserId },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: own.entryId,
        status: 'completed',
        totalKobo: 13075n,
        feeKobo: 3075n,
      });

      const reversal = reversalDelivery({
        customerId: b.customerId,
        customerReference: ours,
        transactionReference: ref('TXREF'),
        reversalRef: ref('REV'),
      });
      const r1 = await deliver(reversal, ours);
      expect(await consumer.consume(r1)).toBe('processed');
      rows = await prisma.fintavaLedgerEntry.findMany({
        where: { wawuUserId: b.wawuUserId },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: own.entryId,
        direction: 'out',
        status: 'reversed',
        amountKobo: 10000n,
        reversalAmountKobo: 10000n,
        reversalChargesKobo: 3075n,
        reversalTotalKobo: 13075n,
      });
      expect(rows[0].reversedAt).toBeInstanceOf(Date);

      // Another copy of the reversal (a new reversalRef), and a late SUCCESS for the send.
      const r2 = await deliver(
        reversalDelivery({
          customerId: b.customerId,
          customerReference: ours,
          transactionReference: ref('TXREF'),
          reversalRef: ref('REV'),
          status: 'SUCCESS',
        }),
        ours,
      );
      const late = await deliver(
        bankTransferDelivery({
          customerId: b.customerId,
          customerReference: ours,
          reference: fin,
          status: 'SUCCESSFUL',
        }),
        ours,
      );
      expect(await consumer.consume(r2)).toBe('processed');
      expect((await event(r2)).note).toMatch(/was already reversed/);
      expect(await consumer.consume(late)).toBe('processed');
      rows = await prisma.fintavaLedgerEntry.findMany({
        where: { wawuUserId: b.wawuUserId },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('reversed');
      expect(rows[0].reversalAmountKobo).toBe(10000n);
    });

    it('a reversal before its debit waits; once the debit is recorded it applies; with no debit past the window it fails and writes nothing', async () => {
      const b = await addWallet();
      const ours = ref('FIO');
      const early = await deliver(
        reversalDelivery({
          customerId: b.customerId,
          customerReference: ours,
          transactionReference: ref('TX'),
          reversalRef: ref('REV'),
        }),
        ours,
      );
      expect(await consumer.consume(early)).toBe('waiting');
      expect(
        await prisma.fintavaLedgerEntry.count({
          where: { wawuUserId: b.wawuUserId },
        }),
      ).toBe(0);
      await ledger.record({
        wallet: {
          kind: 'user',
          wawuUserId: b.wawuUserId,
          accountNumber: b.accountNumber,
        },
        direction: 'out',
        status: 'pending',
        category: 'transfer',
        amountKobo: 10000,
        references: { customerReference: ours },
        source: 'send',
      });
      expect(await consumer.consume(early)).toBe('processed');
      const [row] = await prisma.fintavaLedgerEntry.findMany({
        where: { wawuUserId: b.wawuUserId },
      });
      expect(row.status).toBe('reversed');

      const orphan = await deliver(
        reversalDelivery({
          customerId: b.customerId,
          customerReference: ref('NOBODY'),
          transactionReference: ref('TX'),
          reversalRef: ref('REV'),
        }),
        'orphan',
      );
      expect(
        await consumer.consume(orphan, new Date(Date.now() + 73 * HOUR)),
      ).toBe('failed');
      expect((await event(orphan)).note).toMatch(
        /no debit in the ledger matches this reversal; nothing was written/,
      );
      expect(
        await prisma.fintavaLedgerEntry.count({
          where: { wawuUserId: b.wawuUserId },
        }),
      ).toBe(1);
    });
  });

  describe('deliveries the ledger does not apply', () => {
    it('an undocumented event stays unrecognised and a card event stays pending for WALLET-22: the sweep touches neither', async () => {
      const odd = await deliver(
        JSON.stringify({
          event: 'something_new',
          data: { amount: '5.00', reference: ref('ODD') },
        }),
        'odd',
      );
      const card = await deliver(
        JSON.stringify({
          event: 'card_payment',
          data: { note: `card ${RUN}` },
        }),
        'card',
      );
      await consumer.sweep();
      expect(await event(odd)).toMatchObject({
        processingStatus: 'unrecognised',
        processedAt: null,
      });
      expect(await event(card)).toMatchObject({
        processingStatus: 'pending',
        processedAt: null,
        note: null,
      });
    });

    it('an amount with 3 decimals, or none: failed with the reason, nothing written', async () => {
      const a = await addWallet();
      const bad = ref('BAD');
      const e = await deliver(
        w2wDelivery({
          from: MERCHANT_ACCOUNT,
          to: a.accountNumber,
          amount: '10.005',
          reference: bad,
        }),
        bad,
      );
      expect(await consumer.consume(e)).toBe('failed');
      expect((await event(e)).note).toBe(
        'ledger: an amount is not naira with at most 2 decimals',
      );
      expect(await rowsFor(bad)).toHaveLength(0);
    });

    it('a delivery with no WAWU wallet on either side: processed, nothing written', async () => {
      const r = ref('ELSE');
      const e = await deliver(
        w2wDelivery({
          from: '0020886993',
          to: '0040497763',
          amount: 10,
          reference: r,
        }),
        r,
      );
      expect(await consumer.consume(e)).toBe('processed');
      expect((await event(e)).note).toBe(
        'ledger: no WAWU wallet on either side; nothing recorded',
      );
      expect(await rowsFor(r)).toHaveLength(0);
    });

    it('a sighting with another amount keeps the stored figure and records the disagreement', async () => {
      const a = await addWallet();
      const fin = ref('FIN');
      await ledger.record({
        wallet: {
          kind: 'user',
          wawuUserId: a.wawuUserId,
          accountNumber: a.accountNumber,
        },
        direction: 'in',
        status: 'completed',
        category: 'transfer',
        amountKobo: 1000,
        references: { delivery: [fin] },
        source: 'webhook',
      });
      const e = await deliver(
        w2wDelivery({
          from: '0020886993',
          to: a.accountNumber,
          amount: 15,
          reference: fin,
        }),
        fin,
      );
      expect(await consumer.consume(e)).toBe('processed');
      const rows = await rowsFor(fin);
      expect(rows).toHaveLength(1);
      expect(rows[0].amountKobo).toBe(1000n);
      expect(rows[0].discrepancy).toBe(
        'webhook sighting: amountKobo 1000 vs 1500, totalKobo 1000 vs 1500',
      );
    });
  });

  describe('money in from a bank', () => {
    it('account_funded to a person: an in row, top_up, the sender as a bank account', async () => {
      const a = await addWallet();
      const r = ref('AF');
      const text = JSON.stringify(
        {
          event: 'account_funded',
          data: {
            userId: a.customerId,
            amount: '100.00',
            reference: r,
            senderBankSortcode: '000014',
            sessionID: ref('SESSION'),
            channelCode: '3',
            status: 'success',
            accountName: 'John Doe',
            beneficiaryAccountName: 'Ada Sandbox',
            beneficiaryAccountNumber: a.accountNumber,
            accountNumber: '0865231291',
          },
        },
        null,
        2,
      );
      const e = await deliver(text, r);
      const calls = fintavaCalls(/^\/(transaction|txn)/);
      expect(await consumer.consume(e)).toBe('processed');
      // Trusted alone: history lists no credits, so no lookup or history is asked.
      expect(fintavaCalls(/^\/(transaction|txn)/)).toBe(calls);
      const rows = await rowsFor(r);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        wawuUserId: a.wawuUserId,
        direction: 'in',
        status: 'completed',
        category: 'top_up',
        amountKobo: 10000n,
        totalKobo: 10000n,
        counterpartyKind: 'bank_account',
        counterpartyName: 'John Doe',
        counterpartyAccountNumber: '0865231291',
        counterpartyBankCode: '000014',
      });
    });
  });

  describe('reconciling a row of ours with Fintava', () => {
    it('found by our reference: completed and its references filled; {} then history: found; absent: unchanged', async () => {
      const ours1 = ref('OURS');
      const fin1 = ref('FIN');
      const id1 = randomUUID();
      const one = await ledger.record({
        wallet: { kind: 'merchant', accountNumber: MERCHANT_ACCOUNT },
        direction: 'out',
        status: 'pending',
        category: 'refund',
        amountKobo: 1000,
        references: { customerReference: ours1 },
        source: 'send',
      });
      byReference.set(ours1, {
        status: 200,
        body: {
          data: fintavaRecord({
            id: id1,
            fintava: fin1,
            ours: ours1,
            amount: '10.00',
          }),
          status: 200,
        },
      });
      expect(await consumer.reconcileEntry(one.entryId)).toEqual({
        state: 'found',
        status: 'completed',
      });
      expect(
        await prisma.fintavaLedgerEntry.findUniqueOrThrow({
          where: { id: one.entryId },
        }),
      ).toMatchObject({
        status: 'completed',
        fintavaReference: fin1,
        fintavaTransactionId: id1,
        discrepancy: null,
      });

      const ours2 = ref('OURS');
      const two = await ledger.record({
        wallet: { kind: 'merchant', accountNumber: MERCHANT_ACCOUNT },
        direction: 'out',
        status: 'pending',
        category: 'refund',
        amountKobo: 1000,
        references: { customerReference: ours2 },
        source: 'send',
      });
      byReference.set(ours2, { status: 200, body: {} });
      merchantRows = [
        fintavaRecord({
          id: randomUUID(),
          fintava: ref('FIN'),
          ours: ours2,
          amount: '10.00',
        }),
      ];
      expect(await consumer.reconcileEntry(two.entryId)).toEqual({
        state: 'found',
        status: 'completed',
      });
      merchantRows = [];

      const ours3 = ref('OURS');
      const three = await ledger.record({
        wallet: { kind: 'merchant', accountNumber: MERCHANT_ACCOUNT },
        direction: 'out',
        status: 'pending',
        category: 'refund',
        amountKobo: 1000,
        references: { customerReference: ours3 },
        source: 'send',
      });
      expect(await consumer.reconcileEntry(three.entryId)).toEqual({
        state: 'absent',
        status: null,
      });
      expect(
        (
          await prisma.fintavaLedgerEntry.findUniqueOrThrow({
            where: { id: three.entryId },
          })
        ).status,
      ).toBe('pending');
    });
  });

  describe('whose wallet: an account number at another bank is never a WAWU user', () => {
    it('a bank send to an account at GTBank whose number equals a WAWU wallet number writes nothing on that person (verifier A3)', async () => {
      const victim = await addWallet();
      const sender = await addWallet();
      const ours = ref('BT');
      const e = await deliver(
        bankTransferDelivery({
          customerId: sender.customerId,
          customerReference: ours,
          reference: ref('FINBT'),
          status: 'SUCCESS',
          destination: `${victim.accountNumber}/000013`,
        }),
        ours,
      );
      expect(await consumer.consume(e, new Date(Date.now() + 73 * HOUR))).toBe(
        'processed',
      );
      expect(
        await prisma.fintavaLedgerEntry.count({
          where: { accountNumber: victim.accountNumber },
        }),
      ).toBe(0);
      const sent = await prisma.fintavaLedgerEntry.findMany({
        where: { wawuUserId: sender.wawuUserId },
      });
      expect(sent.map((r) => `${r.direction} ${r.amountKobo}`)).toEqual([
        'out 10000',
      ]);
      expect(sent[0]).toMatchObject({
        counterpartyKind: 'bank_account',
        counterpartyWawuUserId: null,
        counterpartyAccountNumber: victim.accountNumber,
        counterpartyBankCode: '000013',
      });
    });

    it("the same send to that number at Fintava's own bank (090620) is money in for that person", async () => {
      const receiver = await addWallet();
      const sender = await addWallet();
      const ours = ref('BT');
      const e = await deliver(
        bankTransferDelivery({
          customerId: sender.customerId,
          customerReference: ours,
          reference: ref('FINBT'),
          status: 'SUCCESS',
          destination: `${receiver.accountNumber}/090620`,
        }),
        ours,
      );
      expect(await consumer.consume(e, new Date(Date.now() + 73 * HOUR))).toBe(
        'processed',
      );
      const got = await prisma.fintavaLedgerEntry.findMany({
        where: { wawuUserId: receiver.wawuUserId },
      });
      expect(got.map((r) => `${r.direction} ${r.amountKobo}`)).toEqual([
        'in 10000',
      ]);
    });

    it('money in from Access Bank (000014) whose sender number equals a WAWU wallet number writes nothing on that person (verifier A4)', async () => {
      const victim = await addWallet();
      const a = await addWallet();
      const r = ref('AF');
      const funded = (o: {
        userId?: string;
        beneficiary: string;
        reference: string;
      }) =>
        JSON.stringify(
          {
            event: 'account_funded',
            data: {
              ...(o.userId ? { userId: o.userId } : {}),
              amount: '100.00',
              reference: o.reference,
              senderBankSortcode: '000014',
              sessionID: ref('SESSION'),
              channelCode: '3',
              status: 'success',
              accountName: 'John Doe',
              beneficiaryAccountName: 'Ada',
              beneficiaryAccountNumber: o.beneficiary,
              accountNumber: victim.accountNumber,
            },
          },
          null,
          2,
        );
      const e = await deliver(
        funded({
          userId: a.customerId,
          beneficiary: a.accountNumber,
          reference: r,
        }),
        r,
      );
      expect(await consumer.consume(e)).toBe('processed');
      expect(
        await prisma.fintavaLedgerEntry.count({
          where: { accountNumber: victim.accountNumber },
        }),
      ).toBe(0);
      const got = await prisma.fintavaLedgerEntry.findMany({
        where: { wawuUserId: a.wawuUserId },
      });
      expect(got.map((x) => `${x.direction} ${x.amountKobo}`)).toEqual([
        'in 10000',
      ]);

      // A customerId that is not ours is not ours, whatever number sits beside it.
      const r2 = ref('AF');
      const e2 = await deliver(
        funded({
          userId: randomUUID(),
          beneficiary: a.accountNumber,
          reference: r2,
        }),
        r2,
      );
      expect(await consumer.consume(e2)).toBe('processed');
      expect((await event(e2)).note).toBe(
        'ledger: no WAWU wallet on either side; nothing recorded',
      );
      expect(await rowsFor(r2)).toHaveLength(0);
    });
  });

  describe('figures the ledger refuses settle at once, with no Fintava call', () => {
    it('a negative or zero amount, a negative fee or total, amount plus fee past 2^53, or a negative reversal: failed with the reason', async () => {
      const a = await addWallet();
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ amount: -10, total: -10 }, 'the amount is not above 0'],
        [{ amount: '-10.00', total: '-10.00' }, 'the amount is not above 0'],
        [{ amount: 0, total: 0 }, 'the amount is not above 0'],
        [{ amount: '0.00', total: '0.00' }, 'the amount is not above 0'],
        [{ amount: 10, total: 10, transaction_fee: -1 }, 'the fee is below 0'],
        [{ amount: 10, total: -10 }, 'the total is not above 0'],
        [
          { amount: '90071992547409.91', transaction_fee: 1, total: null },
          'amount and fee pass 2^53 kobo',
        ],
      ];
      for (const [over, why] of cases) {
        const tag = ref('AMT');
        const body = JSON.parse(
          w2wDelivery({
            from: '0020886993',
            to: a.accountNumber,
            amount: 1,
            reference: tag,
          }),
        ) as { data: Record<string, unknown> };
        Object.assign(body.data, over);
        const e = await deliver(JSON.stringify(body, null, 2), tag);
        const before = double.seen.length;
        expect(await consumer.consume(e)).toBe('failed');
        expect(double.seen.length).toBe(before);
        expect((await event(e)).note).toBe(`ledger: ${why}`);
        expect(await rowsFor(tag)).toHaveLength(0);
      }
      const ours = ref('FIO');
      const e = await deliver(
        reversalDelivery({
          customerId: a.customerId,
          customerReference: ours,
          transactionReference: ref('TX'),
          reversalRef: ref('REV'),
        }).replace('"amount": 100,', '"amount": -100,'),
        ours,
      );
      const before = double.seen.length;
      expect(await consumer.consume(e)).toBe('failed');
      expect(double.seen.length).toBe(before);
      expect((await event(e)).note).toBe(
        'ledger: the reversed amount is not above 0',
      );
    });
  });

  describe('the guards a race would need', () => {
    it('a holder folded away while a writer waits for its lock: the writer re-reads and folds into the row that now holds the reference', async () => {
      const a = await addWallet();
      const r1 = ref('RACE');
      const r2 = ref('RACE');
      const wallet = {
        kind: 'user' as const,
        wawuUserId: a.wawuUserId,
        accountNumber: a.accountNumber,
      };
      const x = await ledger.record({
        wallet,
        direction: 'in',
        status: 'completed',
        category: 'transfer',
        amountKobo: 500,
        references: { delivery: [r1] },
        source: 'webhook',
      });
      let release = () => {};
      const gate = new Promise<void>((r) => (release = r));
      const yId = randomUUID();
      // Another merge: it holds X, then folds X into a new row Y and deletes X.
      const folding = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "FintavaLedgerEntry" WHERE "id" = ${x.entryId} FOR UPDATE`;
          await gate;
          const row = await tx.fintavaLedgerEntry.findUniqueOrThrow({
            where: { id: x.entryId },
          });
          await tx.fintavaLedgerEntry.create({ data: { ...row, id: yId } });
          await tx.fintavaLedgerReference.updateMany({
            where: { entryId: x.entryId },
            data: { entryId: yId },
          });
          await tx.fintavaLedgerEntry.delete({ where: { id: x.entryId } });
        },
        { timeout: 20_000, maxWait: 10_000 },
      );
      // The writer, inside a caller's transaction as the consumer runs it
      // (so no retry hides a wrong fold).
      const writer = prisma.$transaction(
        (tx) =>
          ledger.record(
            {
              wallet,
              direction: 'in',
              status: 'completed',
              category: 'transfer',
              amountKobo: 500,
              references: { delivery: [r1, r2] },
              source: 'webhook',
            },
            tx,
          ),
        { timeout: 20_000, maxWait: 10_000 },
      );
      for (let i = 0; i < 400; i += 1) {
        const [w] = await prisma.$queryRaw<Array<{ n: bigint }>>`
          SELECT count(*)::bigint AS n FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'`;
        if (w.n > 0n) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      release();
      await folding;
      const res = await writer;
      expect(res).toMatchObject({ entryId: yId, created: false });
      const rows = await rowsFor(r1, r2);
      expect(rows.map((r) => r.id)).toEqual([yId]);
      const held = await prisma.fintavaLedgerReference.findMany({
        where: { entryId: yId },
      });
      expect(held.map((h) => h.value).sort()).toEqual([r1, r2].sort());
    });

    it('a reversal names only debits: an in row holding the same reference is never reversed', async () => {
      const a = await addWallet();
      const b = await addWallet();
      const ours = ref('FIO');
      const out = await ledger.record({
        wallet: {
          kind: 'user',
          wawuUserId: a.wawuUserId,
          accountNumber: a.accountNumber,
        },
        direction: 'out',
        status: 'completed',
        category: 'transfer',
        amountKobo: 1000,
        references: { customerReference: ours },
        source: 'send',
      });
      const inRow = await ledger.record({
        wallet: {
          kind: 'user',
          wawuUserId: b.wawuUserId,
          accountNumber: b.accountNumber,
        },
        direction: 'in',
        status: 'completed',
        category: 'transfer',
        amountKobo: 1000,
        references: { delivery: [ours] },
        source: 'webhook',
      });
      const e = await deliver(
        reversalDelivery({
          customerId: a.customerId,
          customerReference: ours,
          transactionReference: ref('TX'),
          reversalRef: ref('REV'),
        }),
        ours,
      );
      expect(await consumer.consume(e)).toBe('processed');
      const [o, i] = await Promise.all([
        prisma.fintavaLedgerEntry.findUniqueOrThrow({
          where: { id: out.entryId },
        }),
        prisma.fintavaLedgerEntry.findUniqueOrThrow({
          where: { id: inRow.entryId },
        }),
      ]);
      expect(o.status).toBe('reversed');
      expect(i.status).toBe('completed');
      expect(i.reversedAt).toBeNull();
    });

    it('a delivery read as pending but already processed when its lock is taken: nothing is written again', async () => {
      const a = await addWallet();
      const r = ref('DONE');
      const e = await deliver(
        w2wDelivery({
          from: '0020886993',
          to: a.accountNumber,
          amount: 3,
          reference: r,
        }),
        r,
      );
      await prisma.fintavaWebhookEvent.update({
        where: { id: e },
        data: { processingStatus: 'processed', note: 'done elsewhere' },
      });
      // What a second worker does after its stale read: take the lock and write.
      let wrote = false;
      const finish = (
        consumer as unknown as {
          finish: (
            id: string,
            write: () => { status: 'processed'; note: string },
          ) => Promise<string>;
        }
      ).finish.bind(consumer);
      const outcome = await finish(e, () => {
        wrote = true;
        return { status: 'processed', note: 'written twice' };
      });
      expect(outcome).toBe('skipped');
      expect(wrote).toBe(false);
      expect((await event(e)).note).toBe('done elsewhere');
    });

    it('a waiting delivery retried for the same reason is not rewritten; a new reason is', async () => {
      const a = await addWallet();
      const fin = ref('FIN');
      byReference.set(fin, { status: 200, body: {} });
      const e = await deliver(
        w2wDelivery({
          from: '0020886993',
          to: a.accountNumber,
          amount: 4,
          reference: fin,
        }),
        fin,
      );
      const xmin = async () =>
        (
          await prisma.$queryRaw<Array<{ x: string }>>`
            SELECT xmin::text AS x FROM "FintavaWebhookEvent" WHERE "id" = ${e}`
        )[0].x;
      expect(await consumer.consume(e)).toBe('waiting');
      const first = await xmin();
      expect(await consumer.consume(e)).toBe('waiting');
      expect(await xmin()).toBe(first);
      byReference.set(fin, {
        status: 500,
        body: fintavaError(500, 'read ECONNRESET'),
      });
      expect(await consumer.consume(e)).toBe('waiting');
      expect(await xmin()).not.toBe(first);
      expect((await event(e)).note).toMatch(/\(unreachable\)/);
    });
  });

  it('the ledger is never added up into a balance: no sum anywhere in its code', () => {
    const dir = join(__dirname, '..');
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
      const src = readFileSync(join(dir, f), 'utf8');
      expect(src).not.toMatch(/_sum|\bSUM\s*\(|aggregate\(|\.reduce\(/);
    }
  });

  it("no log line carries the secret, the key, or a delivery's personal data", () => {
    const all = logger.lines.join('\n');
    for (const s of [
      SECRET,
      KEY,
      'John Doe',
      'John Services Limited',
      'Ada Sandbox',
    ]) {
      expect(all).not.toContain(s);
    }
  });
});
