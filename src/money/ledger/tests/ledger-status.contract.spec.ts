import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
import type { LedgerCounterparty, LedgerWallet } from '../ledger.interface';
import { LedgerConsumerService } from '../ledger-consumer.service';
import { LedgerStatusService } from '../ledger-status.service';
import { LedgerModule } from '../ledger.module';
import {
  LEDGER_ABSENT_FAILURE,
  LEDGER_FINTAVA_FAILURE,
  LedgerService,
} from '../ledger.service';

/**
 * Status checks and the pending sweep (task MONEY-08), over real inputs: a
 * real database, the real MONEY-06 client asking a local Fintava double over
 * a socket (test/fintava/fintava-double.ts) with the sandbox's own record
 * shapes, and, where a webhook does arrive, a delivery signed locally and
 * posted to MONEY-07's real route, applied by MONEY-10's consumer (there is
 * no tunnel, R-25). "Withheld" means the delivery is simply never posted.
 *
 * Every row here is this run's own (its references carry RUN), and they are
 * deleted at the end.
 */

const RUN = `m08${Date.now().toString(36)}`;
const SECRET = 'whsec_local_m08_Hk4Rz8Wq2Np6Ty1Lb';
const KEY = 'live_test_status_0123456789FAKEKEY';
const PATH = '/api/hub/webhooks/fintava';
const MINUTE = 60_000;

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
    narration: 'status test',
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

function bankTransferDelivery(o: {
  customerId: string;
  customerReference: string;
  reference: string;
  status: string;
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
        destination: '81450/100004',
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
  amount?: number;
  charges?: number;
  total?: number;
  status?: string;
}) {
  return JSON.stringify(
    {
      event: 'debit_transfer_reversal',
      data: {
        amount: o.amount ?? 100,
        charges: o.charges ?? 30.75,
        vat: 0,
        accountName: 'ABC Nigeria Ltd',
        accountNumber: '00126',
        customerId: o.customerId,
        customerReference: o.customerReference,
        type: 'CREDIT',
        status: o.status ?? 'success',
        total: o.total ?? 130.75,
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

function w2wDelivery(o: {
  from: string;
  to: string;
  amount: number;
  reference: string;
  customerReference?: string;
}) {
  return JSON.stringify(
    {
      event: 'wallet_to_wallet_transfer_v2',
      data: {
        amount: o.amount,
        reference: o.reference,
        ...(o.customerReference
          ? { customerReference: o.customerReference }
          : {}),
        total: o.amount,
        transaction_fee: 0,
        target_customer_accno: o.to,
        source_customer_accno: o.from,
        source_customer_wallet: o.from,
        target_customer_wallet: o.to,
        target_customer_accname: 'Ada Sandbox',
        source_customer_accname: 'Test Account4',
        description: 'Fund transfer between customers',
      },
    },
    null,
    2,
  );
}

describe('Status checks and the pending sweep (MONEY-08)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let ledger: LedgerService;
  let consumer: LedgerConsumerService;
  let status: LedgerStatusService;
  const double = new FintavaDouble();
  const logger = new QuietLogger();
  const previous: Record<string, string | undefined> = {};
  const wallets: string[] = [];
  let seq = 0;

  const byReference = new Map<string, { status: number; body: unknown }>();
  const byId = new Map<string, unknown>();
  const merchantRows: unknown[] = [];
  const customerRows = new Map<string, unknown[]>();
  /** A customer's history answer held back this long (ms), by customerId. */
  const historyDelays = new Map<string, number>();
  /**
   * When set, the merchant history answers `pages` full pages of other
   * sends, newest first and all newer than any row here, with `ours` on
   * page `hitPage` (MONEY-06's walk reads at most 5).
   */
  let merchantPaging: {
    pages: number;
    hitPage: number;
    ours: string;
    /**
     * Round 3: reshapes one page as Fintava sent it (an empty page, a total
     * that changes, a page number that is not the one asked for).
     */
    shape?: (
      page: number,
      meta: Record<string, unknown>,
      rows: unknown[],
    ) => { meta: Record<string, unknown>; rows: unknown[] };
  } | null = null;

  const ref = (name: string) => `${name}-${RUN}-${(seq += 1)}`;
  const found = (record: unknown) => ({
    status: 200,
    body: { data: record, status: 200 },
  });

  async function addWallet() {
    const wawuUserId = randomUUID();
    const customerId = randomUUID();
    seq += 1;
    const accountNumber = `8${String(Date.now()).slice(-7)}${String(seq % 100).padStart(2, '0')}`;
    await prisma.fintavaWallet.create({
      data: { wawuUserId, customerId, walletId: randomUUID(), accountNumber },
    });
    wallets.push(wawuUserId);
    return { wawuUserId, customerId, accountNumber };
  }

  const userWallet = (w: {
    wawuUserId: string;
    accountNumber: string;
  }): LedgerWallet => ({
    kind: 'user',
    wawuUserId: w.wawuUserId,
    accountNumber: w.accountNumber,
  });
  const merchant: LedgerWallet = {
    kind: 'merchant',
    accountNumber: MERCHANT_ACCOUNT,
  };
  const toBank: LedgerCounterparty = {
    kind: 'bank_account',
    name: 'ABC Nigeria Ltd',
    accountNumber: '0000081450',
    bankCode: '100004',
  };

  /** What a sending feature writes when it sends (or loses the answer): a pending out row with our reference. */
  async function sent(o: {
    wallet: LedgerWallet;
    ours: string;
    amountKobo?: number;
    feeKobo?: number;
    counterparty?: LedgerCounterparty;
    category?: 'transfer' | 'bill' | 'purchase';
  }) {
    const r = await ledger.record({
      wallet: o.wallet,
      direction: 'out',
      status: 'pending',
      category: o.category ?? 'transfer',
      amountKobo: o.amountKobo ?? 1000,
      feeKobo: o.feeKobo ?? 0,
      counterparty: o.counterparty ?? null,
      references: { customerReference: o.ours },
      source: 'send',
    });
    return r.entryId;
  }

  /** Moves a row's clock back, as if it was recorded `minutes` ago. */
  async function age(entryId: string, minutes: number) {
    const at = new Date(Date.now() - minutes * MINUTE);
    await prisma.$executeRaw`
      UPDATE "FintavaLedgerEntry"
         SET "createdAt" = ${at}, "updatedAt" = ${at}, "occurredAt" = ${at}
       WHERE "id" = ${entryId}`;
  }

  const row = (id: string) =>
    prisma.fintavaLedgerEntry.findUniqueOrThrow({ where: { id } });

  /** Fintava requests that named this reference (lookup path or history query). */
  const asked = (reference: string) =>
    double.seen.filter((s) => s.path.includes(encodeURIComponent(reference)))
      .length;

  async function deliver(text: string): Promise<string> {
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
    return ids[0].id;
  }

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
      .on('GET', '/txn/merchant', (req) => {
        if (merchantPaging) {
          const paging = merchantPaging;
          const page = Number(req.query.page);
          const take = Number(req.query.take);
          const rows = Array.from({ length: take }, (_, i) =>
            fintavaRecord({
              id: randomUUID(),
              fintava: `FILL-${RUN}-${page}-${i}`,
              ours:
                page === paging.hitPage && i === 0
                  ? paging.ours
                  : `OTHER-${RUN}-${page}-${i}`,
              amount: '10.00',
            }),
          );
          const meta: Record<string, unknown> = {
            page: String(page),
            take: String(take),
            itemCount: take * paging.pages,
            pageCount: paging.pages,
            hasPreviousPage: page > 1,
            hasNextPage: page < paging.pages,
          };
          const shaped = paging.shape
            ? paging.shape(page, meta, rows)
            : { meta, rows };
          return {
            status: 200,
            body: { data: shaped.rows, meta: shaped.meta },
          };
        }
        return {
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
        };
      })
      .on('GET', '/txn', (req) => {
        const rows = customerRows.get(req.query.customerId) ?? [];
        return {
          status: 200,
          delayMs: historyDelays.get(req.query.customerId),
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
    status = moduleRef.get(LedgerStatusService);
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

  describe('a transfer whose webhook is withheld settles correctly within one sweep', () => {
    it("WAWU's send to a person, found by our reference: one sweep completes it, fills Fintava's references, and the late webhook lands on the same row", async () => {
      const a = await addWallet();
      const ours = ref('OURS');
      const fin = ref('FIN');
      const tag = ref('TAG');
      const id = randomUUID();
      const entry = await sent({ wallet: merchant, ours });
      await age(entry, 3);
      byReference.set(
        ours,
        found(fintavaRecord({ id, fintava: fin, ours, amount: '10.00' })),
      );
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

      const counts = await status.sweep();
      expect(counts.settled).toBeGreaterThanOrEqual(1);
      expect(await row(entry)).toMatchObject({
        status: 'completed',
        amountKobo: 1000n,
        fintavaReference: fin,
        tagapayTransRef: tag,
        fintavaTransactionId: id,
        discrepancy: null,
        failureReason: null,
      });
      expect((await row(entry)).completedAt).toBeInstanceOf(Date);

      // The webhook that was withheld turns up after all: the same out row,
      // plus the receiver's in row, never a second debit.
      const e = await deliver(
        w2wDelivery({
          from: MERCHANT_ACCOUNT,
          to: a.accountNumber,
          amount: 10,
          reference: tag,
          customerReference: fin,
        }),
      );
      expect(await consumer.consume(e)).toBe('processed');
      const outs = await prisma.fintavaLedgerEntry.findMany({
        where: { accountNumber: MERCHANT_ACCOUNT, customerReference: ours },
      });
      expect(outs.map((r) => r.id)).toEqual([entry]);
      const ins = await prisma.fintavaLedgerEntry.findMany({
        where: { wawuUserId: a.wawuUserId },
      });
      expect(ins).toHaveLength(1);
      expect(ins[0]).toMatchObject({
        direction: 'in',
        status: 'completed',
        amountKobo: 1000n,
      });

      // Settled rows are not asked about again.
      const before = asked(ours);
      await status.sweep();
      expect(asked(ours)).toBe(before);
    });

    it("a person's bank send the lookup answers {} for: the sender's history finds it, and one sweep completes it", async () => {
      const b = await addWallet();
      const ours = ref('OURS');
      const entry = await sent({
        wallet: userWallet(b),
        ours,
        amountKobo: 10000,
        feeKobo: 3075,
        counterparty: toBank,
      });
      await age(entry, 5);
      byReference.set(ours, { status: 200, body: {} });
      customerRows.set(b.customerId, [
        fintavaRecord({
          id: randomUUID(),
          fintava: ref('FIN'),
          ours,
          amount: '100.00',
        }),
      ]);
      await status.sweep();
      expect(await row(entry)).toMatchObject({
        status: 'completed',
        amountKobo: 10000n,
        feeKobo: 3075n,
        totalKobo: 13075n,
        discrepancy: null,
      });
      expect(
        double.seen.some(
          (s) => s.path === '/txn' && s.query.customerId === b.customerId,
        ),
      ).toBe(true);
    });

    it('a row younger than the check-after time is left to its webhook: the sweep does not ask', async () => {
      const ours = ref('OURS');
      const entry = await sent({ wallet: merchant, ours });
      byReference.set(
        ours,
        found(
          fintavaRecord({
            id: randomUUID(),
            fintava: ref('FIN'),
            ours,
            amount: '10.00',
          }),
        ),
      );
      await status.sweep();
      expect(asked(ours)).toBe(0);
      expect((await row(entry)).status).toBe('pending');
      // Two minutes later it is asked, and settles in that one sweep.
      await status.sweep(new Date(Date.now() + 2 * MINUTE + 1000));
      expect(asked(ours)).toBe(1);
      expect((await row(entry)).status).toBe('completed');
    });

    it("money in to a person, pending from a bank-rail delivery: settled by its own reference's lookup", async () => {
      const a = await addWallet();
      const fin = ref('FIN');
      const r = await ledger.record({
        wallet: userWallet(a),
        direction: 'in',
        status: 'pending',
        category: 'transfer',
        amountKobo: 10000,
        references: { delivery: [fin] },
        source: 'webhook',
      });
      await age(r.entryId, 4);
      byReference.set(
        fin,
        found(
          fintavaRecord({
            id: randomUUID(),
            fintava: fin,
            ours: ref('THEIRS'),
            amount: '100.00',
          }),
        ),
      );
      const c = await status.check(r.entryId);
      expect(c).toMatchObject({ outcome: 'settled', status: 'completed' });
      expect(await row(r.entryId)).toMatchObject({
        direction: 'in',
        status: 'completed',
        // Ours goes only on a sender's own row; the receiving side keeps
        // the sender's reference as another reference.
        customerReference: null,
      });
    });

    it("the sweep's check and the webhook arriving at the same moment, with two more checks: one row, completed once", async () => {
      const b = await addWallet();
      const ours = ref('OURS');
      const fin = ref('FIN');
      const entry = await sent({
        wallet: userWallet(b),
        ours,
        amountKobo: 10000,
        feeKobo: 3075,
        counterparty: toBank,
      });
      await age(entry, 3);
      byReference.set(
        ours,
        found(
          fintavaRecord({
            id: randomUUID(),
            fintava: fin,
            ours,
            amount: '100',
          }),
        ),
      );
      const e = await deliver(
        bankTransferDelivery({
          customerId: b.customerId,
          customerReference: ours,
          reference: fin,
          status: 'SUCCESS',
        }),
      );
      const results = await Promise.all([
        status.check(entry),
        consumer.consume(e),
        status.check(entry),
        status.check(entry),
      ]);
      expect(results[1]).toBe('processed');
      const rows = await prisma.fintavaLedgerEntry.findMany({
        where: { wawuUserId: b.wawuUserId },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: entry,
        status: 'completed',
        totalKobo: 13075n,
        discrepancy: null,
      });
    });
  });

  describe('an unknown outcome stays pending and is never guessed', () => {
    it('PENDING at Fintava, a {} lookup with no history row, or Fintava out of reach: pending, even a day later; asked again only after a rest', async () => {
      const pendingAtFintava = ref('OURS');
      const empty = ref('OURS');
      const down = ref('OURS');
      const ids: string[] = [];
      for (const ours of [pendingAtFintava, empty, down]) {
        const id = await sent({
          wallet: merchant,
          ours,
          counterparty: toBank,
        });
        await age(id, 24 * 60);
        ids.push(id);
      }
      byReference.set(
        pendingAtFintava,
        found(
          fintavaRecord({
            id: randomUUID(),
            fintava: ref('FIN'),
            ours: pendingAtFintava,
            amount: '10.00',
            status: 'PENDING',
          }),
        ),
      );
      byReference.set(empty, { status: 200, body: {} });
      byReference.set(down, {
        status: 502,
        body: '<html>Bad Gateway</html>',
      });
      const checks = await Promise.all(ids.map((id) => status.check(id)));
      expect(checks.map((c) => c.outcome)).toEqual([
        'waiting',
        'waiting',
        'waiting',
      ]);
      expect(checks[0].decision).toEqual({ action: 'wait', why: 'pending' });
      expect(checks[1].decision).toEqual({
        action: 'wait',
        why: 'empty_lookup',
      });
      expect(checks[2].decision?.action).toBe('wait');
      for (const id of ids) {
        expect(await row(id)).toMatchObject({
          status: 'pending',
          failureReason: null,
        });
      }
      // Resting: the next sweep, a moment later, does not ask again.
      const counted = [pendingAtFintava, empty, down].map(asked);
      await status.sweep();
      expect([pendingAtFintava, empty, down].map(asked)).toEqual(counted);
      // After the rest (1 minute, then 2, 4 ...), it is asked again.
      await status.sweep(new Date(Date.now() + MINUTE + 1000));
      expect(asked(empty)).toBeGreaterThan(counted[1]);
      expect((await row(ids[1])).status).toBe('pending');
    });

    it('a figure Fintava sends that cannot be read exactly (3 decimals) is not settled', async () => {
      const ours = ref('OURS');
      const entry = await sent({ wallet: merchant, ours });
      await age(entry, 3);
      byReference.set(
        ours,
        found(
          fintavaRecord({
            id: randomUUID(),
            fintava: ref('FIN'),
            ours,
            amount: '10.001',
          }),
        ),
      );
      const c = await status.check(entry);
      expect(c.outcome).toBe('waiting');
      expect((await row(entry)).status).toBe('pending');
    });

    it('U-2: " 10.00 " in Fintava\'s record is exactly 1000 kobo, so the row settles with no disagreement', async () => {
      const ours = ref('OURS');
      const entry = await sent({ wallet: merchant, ours });
      await age(entry, 3);
      byReference.set(
        ours,
        found(
          fintavaRecord({
            id: randomUUID(),
            fintava: ref('FIN'),
            ours,
            amount: ' 10.00 ',
          }),
        ),
      );
      expect(await status.check(entry)).toMatchObject({
        outcome: 'settled',
        status: 'completed',
      });
      expect(await row(entry)).toMatchObject({
        amountKobo: 1000n,
        discrepancy: null,
      });
    });

    it('round 2: a row of category bill with NO biller counterparty, a day old and unknown to Fintava, is never failed as absent', async () => {
      const ours = ref('OURS');
      const entry = await sent({ wallet: merchant, ours, category: 'bill' });
      await age(entry, 24 * 60);
      const c = await status.check(entry);
      expect(c).toMatchObject({ outcome: 'waiting', decision: null });
      expect(await row(entry)).toMatchObject({
        status: 'pending',
        counterpartyKind: null,
        failureReason: null,
      });
    });

    it('a bill (Fintava takes no reference of ours for bills) that Fintava does not find is never failed', async () => {
      const ours = ref('OURS');
      const entry = await sent({
        wallet: merchant,
        ours,
        category: 'bill',
        counterparty: { kind: 'biller', name: 'Ikeja Electric' },
      });
      await age(entry, 24 * 60);
      const c = await status.check(entry);
      expect(c).toMatchObject({ outcome: 'waiting', decision: null });
      expect((await row(entry)).status).toBe('pending');
    });
  });

  describe('Fintava says it has no such send (its own 404 and no history row)', () => {
    it('within the resend window: pending; past it: failed, no money moved, and the decision MONEY-06 allows is returned, never acted on', async () => {
      const w2w = ref('OURS');
      const bank = ref('OURS');
      const w2wId = await sent({ wallet: merchant, ours: w2w });
      const bankId = await sent({
        wallet: merchant,
        ours: bank,
        counterparty: toBank,
      });
      await age(w2wId, 5);
      await age(bankId, 5);
      // 5 minutes is inside the money timeout plus the 10-minute safety window.
      expect(await status.check(w2wId)).toMatchObject({
        outcome: 'waiting',
        status: 'pending',
        decision: { action: 'wait', why: 'too_soon' },
      });
      await age(w2wId, 11);
      await age(bankId, 11);
      const posts = double.seen.filter((s) => s.method !== 'GET').length;
      expect(await status.check(w2wId)).toMatchObject({
        outcome: 'failed_absent',
        status: 'failed',
        decision: { action: 'resend_same_reference' },
      });
      expect(await status.check(bankId)).toMatchObject({
        outcome: 'failed_absent',
        status: 'failed',
        decision: {
          action: 'resend_new_reference',
          why: 'absent',
          transaction: null,
        },
      });
      for (const id of [w2wId, bankId]) {
        expect(await row(id)).toMatchObject({
          status: 'failed',
          failureReason: LEDGER_ABSENT_FAILURE,
          discrepancy: null,
        });
      }
      // Nothing was sent: the status check only reads.
      expect(double.seen.filter((s) => s.method !== 'GET').length).toBe(posts);
      // Not asked again: it is no longer pending.
      const before = asked(w2w);
      await status.sweep();
      expect(asked(w2w)).toBe(before);
    });

    it('round 2: a resend under the same reference revives the row as a revival, not a disagreement, and the sweep then settles it from Fintava with the webhook withheld', async () => {
      // The verifier's repro (round 1 defect 2): the revival used to go on
      // `discrepancy`, so the sweep skipped the row for ever.
      const ours = ref('OURS');
      const entry = await sent({ wallet: merchant, ours });
      await age(entry, 11);
      expect(await status.check(entry)).toMatchObject({
        outcome: 'failed_absent',
        decision: { action: 'resend_same_reference' },
      });
      // The sending feature resends under the same reference and records it.
      await ledger.record({
        wallet: merchant,
        direction: 'out',
        status: 'pending',
        category: 'transfer',
        amountKobo: 1000,
        references: { customerReference: ours },
        source: 'send',
      });
      const r = await row(entry);
      expect(r).toMatchObject({
        status: 'pending',
        failureReason: null,
        discrepancy: null,
        revivedBy: 'send',
        statusChecks: 0,
        nextCheckAt: null,
      });
      expect(r.revivedAt).toBeInstanceOf(Date);
      // Fintava now has it as SUCCESS; its webhook is withheld.
      byReference.set(
        ours,
        found(
          fintavaRecord({
            id: randomUUID(),
            fintava: ref('FIN'),
            ours,
            amount: '10.00',
          }),
        ),
      );
      // The resend gets its two minutes, as a new row does...
      const before = asked(ours);
      await status.sweep();
      expect(asked(ours)).toBe(before);
      // ...and then one sweep settles it.
      await status.sweep(new Date(Date.now() + 2 * MINUTE + 1000));
      expect(asked(ours)).toBeGreaterThan(before);
      expect(await row(entry)).toMatchObject({
        status: 'completed',
        discrepancy: null,
        revivedBy: 'send',
      });
    });

    it("failed as absent, then Fintava's record of it turns up SUCCESS: completed, recorded as a revival, never a disagreement", async () => {
      const ours = ref('OURS');
      const entry = await sent({ wallet: merchant, ours });
      await age(entry, 11);
      expect((await status.check(entry)).outcome).toBe('failed_absent');
      await ledger.record({
        wallet: merchant,
        direction: 'out',
        status: 'completed',
        category: 'transfer',
        amountKobo: 1000,
        references: { customerReference: ours, fintavaReference: ref('FIN') },
        source: 'lookup',
      });
      const r = await row(entry);
      expect(r).toMatchObject({
        status: 'completed',
        failureReason: null,
        discrepancy: null,
        revivedBy: 'lookup',
      });
      expect(r.completedAt).toBeInstanceOf(Date);
      expect(r.revivedAt).toBeInstanceOf(Date);
    });

    it('round 2: a delivery consumed while the history call is in flight: never failed as absent, and the same end whatever the timing', async () => {
      // The verifier's repro (round 1 defect 3): /txn held back 1.2 s, the
      // delivery consumed at +300 ms. Three timings, one end: pending, no
      // failure, no disagreement, asked again later.
      const ends: unknown[] = [];
      for (const timing of ['during', 'before', 'stored only'] as const) {
        const b = await addWallet();
        const ours = ref('OURS');
        const entry = await sent({
          wallet: userWallet(b),
          ours,
          amountKobo: 10000,
          feeKobo: 3075,
          counterparty: toBank,
        });
        await age(entry, 11);
        const e = await deliver(
          bankTransferDelivery({
            customerId: b.customerId,
            customerReference: ours,
            reference: ref('FIN'),
            status: 'PENDING',
          }),
        );
        let c;
        if (timing === 'during') {
          historyDelays.set(b.customerId, 1200);
          const p = status.check(entry);
          await new Promise((res) => setTimeout(res, 300));
          expect(await consumer.consume(e)).toBe('processed');
          c = await p;
        } else if (timing === 'before') {
          expect(await consumer.consume(e)).toBe('processed');
          c = await status.check(entry);
        } else {
          // Received and stored by MONEY-07's route, not yet consumed.
          c = await status.check(entry);
          expect(await consumer.consume(e)).toBe('processed');
        }
        // Never a resend: a delivery that landed first also makes the row
        // recently touched (too_soon); one that lands during the check makes
        // the absent verdict stand down (pending).
        expect(c).toMatchObject({
          outcome: 'waiting',
          decision: { action: 'wait' },
        });
        const r = await row(entry);
        ends.push({
          status: r.status,
          failureReason: r.failureReason,
          discrepancy: r.discrepancy,
          revivedAt: r.revivedAt,
        });
        expect(r.nextCheckAt).toBeInstanceOf(Date);
      }
      expect(ends).toEqual([
        {
          status: 'pending',
          failureReason: null,
          discrepancy: null,
          revivedAt: null,
        },
        {
          status: 'pending',
          failureReason: null,
          discrepancy: null,
          revivedAt: null,
        },
        {
          status: 'pending',
          failureReason: null,
          discrepancy: null,
          revivedAt: null,
        },
      ]);
    });

    it('round 2: a send Fintava has already shown us (its record found PENDING once) is never failed as absent, even when the lookup later 404s', async () => {
      const ours = ref('OURS');
      const entry = await sent({ wallet: merchant, ours });
      // An earlier check found Fintava's record, still PENDING: its
      // reference and id are now on the row.
      await ledger.record({
        wallet: merchant,
        direction: 'out',
        status: 'pending',
        category: 'transfer',
        amountKobo: 1000,
        references: {
          customerReference: ours,
          fintavaReference: ref('FIN'),
          fintavaTransactionId: randomUUID(),
        },
        source: 'lookup',
      });
      await age(entry, 60);
      // Now the lookup answers 404 and history has no row.
      byReference.delete(ours);
      expect(await status.check(entry)).toMatchObject({
        outcome: 'waiting',
        decision: { action: 'wait', why: 'pending' },
      });
      expect(await row(entry)).toMatchObject({
        status: 'pending',
        failureReason: null,
      });
    });

    it('round 2: a row the version check sees change is not failed as absent (compare-and-set)', async () => {
      const ours = ref('OURS');
      const entry = await sent({ wallet: merchant, ours });
      await age(entry, 11);
      const [{ v }] = await prisma.$queryRaw<Array<{ v: string }>>`
        SELECT xmin::text AS "v" FROM "FintavaLedgerEntry" WHERE "id" = ${entry}`;
      // A send's own note written meanwhile: any write changes the version.
      await prisma.fintavaLedgerEntry.update({
        where: { id: entry },
        data: { note: 'changed' },
      });
      expect(await ledger.markAbsentFailed(entry, v)).toBe(false);
      expect((await row(entry)).status).toBe('pending');
      const [{ v: now }] = await prisma.$queryRaw<Array<{ v: string }>>`
        SELECT xmin::text AS "v" FROM "FintavaLedgerEntry" WHERE "id" = ${entry}`;
      expect(await ledger.markAbsentFailed(entry, now)).toBe(true);
      expect((await row(entry)).failureReason).toBe(LEDGER_ABSENT_FAILURE);
    });

    it('round 2: a history walk cut off at its page limit is not "no row": our send on merchant history page 6 of 8 is never failed', async () => {
      // The verifier's repro (round 1 defect 4).
      const ours = ref('OURS');
      const entry = await sent({ wallet: merchant, ours });
      await age(entry, 11);
      merchantPaging = { pages: 8, hitPage: 6, ours };
      const n0 = double.seen.length;
      let c;
      try {
        c = await status.check(entry);
      } finally {
        merchantPaging = null;
      }
      const pages = double.seen
        .slice(n0)
        .filter((q) => q.path === '/txn/merchant').length;
      expect(pages).toBe(5);
      expect(c).toMatchObject({
        outcome: 'waiting',
        fintava: 'unknown',
        decision: { action: 'wait', why: 'history_incomplete' },
      });
      expect(await row(entry)).toMatchObject({
        status: 'pending',
        failureReason: null,
      });
      // The same send on page 4 of 8 is found by the same walk.
      const ours2 = ref('OURS');
      const two = await sent({ wallet: merchant, ours: ours2 });
      await age(two, 11);
      merchantPaging = { pages: 8, hitPage: 4, ours: ours2 };
      try {
        expect(await status.check(two)).toMatchObject({ outcome: 'settled' });
      } finally {
        merchantPaging = null;
      }
      expect((await row(two)).status).toBe('completed');
    });

    it('a 404 for a reference that is not ours (money in) proves nothing: never failed', async () => {
      const a = await addWallet();
      const fin = ref('FIN');
      const r = await ledger.record({
        wallet: userWallet(a),
        direction: 'in',
        status: 'pending',
        category: 'transfer',
        amountKobo: 1000,
        references: { delivery: [fin] },
        source: 'webhook',
      });
      await age(r.entryId, 24 * 60);
      expect(await status.check(r.entryId)).toMatchObject({
        outcome: 'waiting',
        status: 'pending',
      });
    });
  });

  describe("Fintava's record disagrees with the row: a stop", () => {
    it('another amount: recorded on the row, the status not moved, and the row left for review (not asked again)', async () => {
      const ours = ref('OURS');
      const entry = await sent({ wallet: merchant, ours, amountKobo: 1000 });
      await age(entry, 3);
      byReference.set(
        ours,
        found(
          fintavaRecord({
            id: randomUUID(),
            fintava: ref('FIN'),
            ours,
            amount: '15.00',
          }),
        ),
      );
      expect(await status.check(entry)).toMatchObject({
        outcome: 'disagrees',
        status: 'pending',
      });
      const r = await row(entry);
      expect(r).toMatchObject({
        status: 'pending',
        amountKobo: 1000n,
        discrepancy: 'status check: amountKobo 1000 vs 1500',
      });
      const before = asked(ours);
      await status.sweep(new Date(Date.now() + 2 * 60 * MINUTE));
      expect(asked(ours)).toBe(before);
      // MONEY-10's reconcileEntry is this check now: it settles nothing either.
      expect(await consumer.reconcileEntry(entry)).toEqual({
        state: 'skipped',
        status: null,
      });
      expect((await row(entry)).discrepancy).toBe(
        'status check: amountKobo 1000 vs 1500',
      );
    });

    it('round 2: a delivery with another amount on a pending row records the disagreement and does not settle the status; the sweep then leaves it for review', async () => {
      // The verifier's finding 5 (A4b): MONEY-10's merge used to settle the
      // status from such a delivery and only note the figures. WORKFLOW
      // section 10 makes any disagreement a stop, as the status check does.
      const b = await addWallet();
      const ours = ref('OURS');
      const entry = await sent({
        wallet: userWallet(b),
        ours,
        amountKobo: 10000,
        feeKobo: 3075,
        counterparty: toBank,
      });
      const text = bankTransferDelivery({
        customerId: b.customerId,
        customerReference: ours,
        reference: ref('FIN'),
        status: 'SUCCESS',
      })
        .replace('"amount": 100,', '"amount": 200,')
        .replace('"total": 130.75', '"total": 230.75');
      expect(await consumer.consume(await deliver(text))).toBe('processed');
      const r = await row(entry);
      expect(r).toMatchObject({
        status: 'pending',
        amountKobo: 10000n,
        completedAt: null,
        discrepancy:
          'webhook sighting: status pending vs completed not applied, amountKobo 10000 vs 20000, totalKobo 13075 vs 23075',
      });
      await age(entry, 3);
      const before = asked(ours);
      await status.sweep(new Date(Date.now() + 2 * 60 * MINUTE));
      expect(asked(ours)).toBe(before);
    });

    it('round 3: a sighting with another amount after an absent verdict: a ₦100 row failed as absent goes back to pending, never completed, when a ₦200 SUCCESS delivery names it, and the disagreement is recorded', async () => {
      // The verifier's finding 5 (A4): it used to become completed. Round 2
      // left it failed; round 3 puts it back to pending (Fintava knows the
      // reference, so "no money moved" no longer stands), which is where
      // the same delivery arriving before the absent verdict leaves it.
      const b = await addWallet();
      const ours = ref('OURS');
      const entry = await sent({
        wallet: userWallet(b),
        ours,
        amountKobo: 10000,
        feeKobo: 3075,
        counterparty: toBank,
      });
      await age(entry, 11);
      expect((await status.check(entry)).outcome).toBe('failed_absent');
      const text = bankTransferDelivery({
        customerId: b.customerId,
        customerReference: ours,
        reference: ref('FIN'),
        status: 'SUCCESS',
      })
        .replace('"amount": 100,', '"amount": 200,')
        .replace('"total": 130.75', '"total": 230.75');
      expect(await consumer.consume(await deliver(text))).toBe('processed');
      expect(await row(entry)).toMatchObject({
        status: 'pending',
        failureReason: null,
        completedAt: null,
        amountKobo: 10000n,
        revivedBy: 'webhook',
        discrepancy:
          'webhook sighting: status failed (no record at Fintava) vs completed not applied, failed (no record at Fintava) put back to pending, amountKobo 10000 vs 20000, totalKobo 13075 vs 23075',
      });
      // Held for review: the sweep does not ask it, a check changes nothing.
      expect(await status.check(entry)).toMatchObject({
        outcome: 'disagrees',
        status: 'pending',
      });
      // The same delivery with the same figures does revive it (control).
      const ours2 = ref('OURS');
      const two = await sent({
        wallet: userWallet(b),
        ours: ours2,
        amountKobo: 10000,
        feeKobo: 3075,
        counterparty: toBank,
      });
      await age(two, 11);
      expect((await status.check(two)).outcome).toBe('failed_absent');
      const same = bankTransferDelivery({
        customerId: b.customerId,
        customerReference: ours2,
        reference: ref('FIN'),
        status: 'SUCCESS',
      });
      expect(await consumer.consume(await deliver(same))).toBe('processed');
      expect(await row(two)).toMatchObject({
        status: 'completed',
        discrepancy: null,
        revivedBy: 'webhook',
      });
    });

    it("round 2: a delivery whose amount Fintava's own record contradicts is written pending with the disagreement, not settled", async () => {
      const a = await addWallet();
      const fin = ref('FIN');
      byReference.set(
        fin,
        found(
          fintavaRecord({
            id: randomUUID(),
            fintava: fin,
            ours: null,
            amount: '10.00',
          }),
        ),
      );
      const e = await deliver(
        w2wDelivery({
          from: '0020886993',
          to: a.accountNumber,
          amount: 15,
          reference: fin,
        }),
      );
      expect(await consumer.consume(e)).toBe('processed');
      const rows = await prisma.fintavaLedgerEntry.findMany({
        where: { wawuUserId: a.wawuUserId },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        direction: 'in',
        status: 'pending',
        amountKobo: 1500n,
        discrepancy:
          "webhook sighting: Fintava's record says 1000 kobo, the delivery 1500",
      });
    });

    it('U-1: a completed send that a later delivery calls FAILED stays completed, and the disagreement is recorded', async () => {
      const b = await addWallet();
      const ours = ref('OURS');
      const fin = ref('FIN');
      const entry = await sent({
        wallet: userWallet(b),
        ours,
        amountKobo: 10000,
        feeKobo: 3075,
        counterparty: toBank,
      });
      const ok = await deliver(
        bankTransferDelivery({
          customerId: b.customerId,
          customerReference: ours,
          reference: fin,
          status: 'SUCCESS',
        }),
      );
      expect(await consumer.consume(ok)).toBe('processed');
      expect((await row(entry)).status).toBe('completed');
      const bad = await deliver(
        bankTransferDelivery({
          customerId: b.customerId,
          customerReference: ours,
          reference: fin,
          status: 'FAILED',
        }),
      );
      expect(await consumer.consume(bad)).toBe('processed');
      const r = await row(entry);
      expect(r.status).toBe('completed');
      expect(r.discrepancy).toBe(
        'webhook sighting: status completed vs failed',
      );
    });
  });

  describe('a transfer Fintava reports failed is reversed exactly once', () => {
    it("FAILURE with the reversal withheld: one sweep fails it; repeated and concurrent checks change nothing; WAWU sends nothing back; Fintava's reversal then reverses it once", async () => {
      const b = await addWallet();
      const ours = ref('OURS');
      const fin = ref('FIN');
      const entry = await sent({
        wallet: userWallet(b),
        ours,
        amountKobo: 10000,
        feeKobo: 3075,
        counterparty: toBank,
      });
      await age(entry, 3);
      byReference.set(
        ours,
        found(
          fintavaRecord({
            id: randomUUID(),
            fintava: fin,
            ours,
            amount: '100.00',
            status: 'FAILURE',
          }),
        ),
      );
      const posts = double.seen.filter((s) => s.method !== 'GET').length;
      await status.sweep();
      let r = await row(entry);
      expect(r).toMatchObject({
        status: 'failed',
        failureReason: LEDGER_FINTAVA_FAILURE,
        amountKobo: 10000n,
        totalKobo: 13075n,
        fintavaReference: fin,
        reversedAt: null,
      });

      const again = await Promise.all([
        status.check(entry),
        status.check(entry),
        status.check(entry),
        status.sweep(new Date(Date.now() + 2 * 60 * MINUTE)),
      ]);
      for (const c of again.slice(0, 3)) {
        expect(c).toMatchObject({ outcome: 'skipped', status: 'failed' });
      }
      r = await row(entry);
      expect(r.status).toBe('failed');
      // Never a send, never a credit row written by us.
      expect(double.seen.filter((s) => s.method !== 'GET').length).toBe(posts);
      expect(
        await prisma.fintavaLedgerEntry.count({
          where: { wawuUserId: b.wawuUserId },
        }),
      ).toBe(1);

      // Fintava's reversal arrives twice: two deliveries of the same
      // reversal (one reversalRef; the second spells its status otherwise,
      // so MONEY-07 stores both), consumed at once.
      const tx = ref('TX');
      const revRef = ref('REV');
      const first = await deliver(
        reversalDelivery({
          customerId: b.customerId,
          customerReference: ours,
          transactionReference: tx,
          reversalRef: revRef,
        }),
      );
      const second = await deliver(
        reversalDelivery({
          customerId: b.customerId,
          customerReference: ours,
          transactionReference: tx,
          reversalRef: revRef,
          status: 'SUCCESS',
        }),
      );
      const applied = await Promise.all([
        consumer.consume(first),
        consumer.consume(second),
      ]);
      expect(applied).toEqual(['processed', 'processed']);
      const rows = await prisma.fintavaLedgerEntry.findMany({
        where: { wawuUserId: b.wawuUserId },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: entry,
        direction: 'out',
        status: 'reversed',
        reversalAmountKobo: 10000n,
        reversalChargesKobo: 3075n,
        reversalTotalKobo: 13075n,
      });
      const notes = await prisma.fintavaWebhookEvent.findMany({
        where: { id: { in: [first, second] } },
        select: { note: true },
      });
      expect(
        notes.filter((n) => /marked reversed/.test(n.note ?? '')),
      ).toHaveLength(1);
      expect(
        notes.filter((n) => /was already reversed/.test(n.note ?? '')),
      ).toHaveLength(1);
      expect(rows[0].discrepancy).toBeNull();
      const reversedAt = rows[0].reversedAt;

      // A second reversal under another reversalRef (money back twice?):
      // round 3 records it on the row and changes nothing else.
      const other = ref('REV');
      const third = await deliver(
        reversalDelivery({
          customerId: b.customerId,
          customerReference: ours,
          transactionReference: tx,
          reversalRef: other,
        }),
      );
      expect(await consumer.consume(third)).toBe('processed');
      r = await row(entry);
      expect(r).toMatchObject({
        status: 'reversed',
        reversalReference: revRef,
        reversalAmountKobo: 10000n,
        discrepancy: `reversal sighting ${other}: not applied (already reversed by ${revRef})`,
      });
      expect(r.reversedAt).toEqual(reversedAt);

      // A late SUCCESS delivery, and more sweeps: still reversed, once; the
      // SUCCESS after Fintava's reversal is recorded too (round 3).
      const late = await deliver(
        bankTransferDelivery({
          customerId: b.customerId,
          customerReference: ours,
          reference: fin,
          status: 'SUCCESS',
        }),
      );
      expect(await consumer.consume(late)).toBe('processed');
      expect(await status.check(entry)).toMatchObject({
        outcome: 'skipped',
        status: 'reversed',
      });
      r = await row(entry);
      expect(r.status).toBe('reversed');
      expect(r.reversedAt).toEqual(reversedAt);
      expect(r.discrepancy).toMatch(
        /webhook sighting: status reversed vs completed/,
      );
      expect(double.seen.filter((s) => s.method !== 'GET').length).toBe(posts);
    });

    it('the reversal first, while the row is pending: reversed once, and the sweep does not touch it afterwards', async () => {
      const b = await addWallet();
      const ours = ref('OURS');
      const entry = await sent({
        wallet: userWallet(b),
        ours,
        amountKobo: 10000,
        feeKobo: 3075,
        counterparty: toBank,
      });
      await age(entry, 3);
      const rev = await deliver(
        reversalDelivery({
          customerId: b.customerId,
          customerReference: ours,
          transactionReference: ref('TX'),
          reversalRef: ref('REV'),
        }),
      );
      expect(await consumer.consume(rev)).toBe('processed');
      expect((await row(entry)).status).toBe('reversed');
      byReference.set(
        ours,
        found(
          fintavaRecord({
            id: randomUUID(),
            fintava: ref('FIN'),
            ours,
            amount: '100.00',
            status: 'FAILURE',
          }),
        ),
      );
      await status.sweep();
      expect(asked(ours)).toBe(0);
      expect(await row(entry)).toMatchObject({
        status: 'reversed',
        reversalAmountKobo: 10000n,
      });
    });
  });

  describe('round 2: the schedule is kept on the row, so a backlog never delays a new transfer', () => {
    /** Another server, or this one after a restart: nothing in memory. */
    async function anotherServer() {
      const m = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
          PrismaModule,
          LedgerModule,
        ],
      }).compile();
      const a = m.createNestApplication({ ...HUB_APP_OPTIONS, logger });
      a.useLogger(logger);
      await a.init();
      return { status: m.get(LedgerStatusService), close: () => a.close() };
    }

    const restMinutes = async (id: string, from: Date) => {
      const r = await row(id);
      return {
        checks: r.statusChecks,
        rest:
          r.nextCheckAt === null
            ? null
            : (r.nextCheckAt.getTime() - from.getTime()) / MINUTE,
      };
    };

    it('the rest doubles 1, 2, 4 ... up to 60 minutes, is written on the row, and a restarted server keeps it', async () => {
      const ours = ref('OURS');
      const entry = await sent({ wallet: merchant, ours });
      await age(entry, 3);
      byReference.set(ours, { status: 200, body: {} });
      expect(await restMinutes(entry, new Date())).toEqual({
        checks: 0,
        rest: null,
      });
      const seen: number[] = [];
      let at = new Date();
      for (let i = 0; i < 8; i += 1) {
        expect((await status.check(entry, at)).outcome).toBe('waiting');
        const r = await restMinutes(entry, at);
        expect(r.checks).toBe(i + 1);
        seen.push(r.rest ?? -1);
        at = new Date(at.getTime() + (r.rest ?? 0) * MINUTE);
      }
      expect(seen).toEqual([1, 2, 4, 8, 16, 32, 60, 60]);
      // A restarted server reads the same schedule: not asked before the
      // rest ends, asked once it has.
      const other = await anotherServer();
      try {
        const n = asked(ours);
        await other.status.sweep(new Date(at.getTime() - 1000));
        expect(asked(ours)).toBe(n);
        await other.status.sweep(at);
        expect(asked(ours)).toBeGreaterThan(n);
        expect((await row(entry)).statusChecks).toBe(9);
      } finally {
        await other.close();
      }
      await prisma.fintavaLedgerEntry.update({
        where: { id: entry },
        data: { status: 'failed' },
      });
    });

    it('3,000 day-old rows Fintava cannot settle, and a new SUCCESS send with its webhook withheld: settled in the first sweep it is due, at most 50 rows asked a pass, also on a restarted server; two servers never ask about the same row in one minute', async () => {
      // The verifier's backlog repro (round 1 defect 1): this used to take
      // 39 sweeps behind 400 rows and never settle behind 3,000. The rows
      // are WAWU's sends a day old whose lookup answers {}: Fintava cannot
      // say, so each stays pending and is asked about at most hourly.
      const N = 3000;
      const prefix = `BL-${RUN}-`;
      const old = new Date(Date.now() - 24 * 60 * MINUTE);
      await prisma.$executeRaw`
        INSERT INTO "FintavaLedgerEntry"
               ("id", "walletKind", "accountNumber", "direction", "status",
                "category", "amountKobo", "feeKobo", "totalKobo",
                "customerReference", "source", "occurredAt", "createdAt",
                "updatedAt")
        SELECT gen_random_uuid()::text, 'merchant'::"FintavaLedgerWallet",
               ${MERCHANT_ACCOUNT}, 'out'::"FintavaLedgerDirection",
               'pending'::"FintavaLedgerStatus",
               'transfer'::"FintavaLedgerCategory", 1000, 0, 1000,
               ${prefix} || g, 'send', ${old}::timestamp(3),
               ${old}::timestamp(3), ${old}::timestamp(3)
          FROM generate_series(1, ${N}::int) AS g`;
      await prisma.$executeRaw`
        INSERT INTO "FintavaLedgerReference"
               ("accountNumber", "direction", "value", "kind", "entryId")
        SELECT "accountNumber", "direction", "customerReference", 'ours', "id"
          FROM "FintavaLedgerEntry"
         WHERE "customerReference" LIKE ${prefix + '%'}`;
      for (let i = 1; i <= N; i += 1) {
        byReference.set(`${prefix}${i}`, { status: 200, body: {} });
      }
      const lookupsSince = (n0: number) =>
        double.seen
          .slice(n0)
          .filter((q) => q.path.startsWith('/transaction/reference/'));
      const newSend = async () => {
        const ours = ref('NEW');
        const entry = await sent({ wallet: merchant, ours });
        await age(entry, 3);
        byReference.set(
          ours,
          found(
            fintavaRecord({
              id: randomUUID(),
              fintava: ref('FIN'),
              ours,
              amount: '10.00',
            }),
          ),
        );
        return entry;
      };
      const other = await anotherServer();
      try {
        const base = Date.now();
        // This server: the new send is asked about and settled in the first
        // pass, ahead of every waiting row.
        const first = await newSend();
        let n0 = double.seen.length;
        let c = await status.sweep(new Date(base));
        expect(Object.values(c).reduce((x, y) => x + y, 0)).toBe(50);
        expect(lookupsSince(n0).length).toBeLessThanOrEqual(50);
        expect((await row(first)).status).toBe('completed');
        const claimed = await prisma.fintavaLedgerEntry.findMany({
          where: { customerReference: { startsWith: prefix }, statusChecks: 1 },
          select: { customerReference: true },
        });
        expect(claimed).toHaveLength(49);

        // A restart: another process, nothing in memory. A second new send
        // settles in its first pass too, and the 49 rows asked a moment ago
        // rest (their schedule is on the row), so it asks 50 others.
        const second = await newSend();
        n0 = double.seen.length;
        c = await other.status.sweep(new Date(base + 30_000));
        expect(Object.values(c).reduce((x, y) => x + y, 0)).toBe(50);
        expect((await row(second)).status).toBe('completed');
        const askedNow = new Set(
          lookupsSince(n0).map((q) =>
            decodeURIComponent(q.path.replace('/transaction/reference/', '')),
          ),
        );
        for (const r of claimed) {
          expect(askedNow.has(r.customerReference ?? '')).toBe(false);
        }

        // Both servers at once: 100 different rows, none asked twice, and a
        // third new send settles in that minute.
        const third = await newSend();
        n0 = double.seen.length;
        const both = await Promise.all([
          status.sweep(new Date(base + 2 * MINUTE)),
          other.status.sweep(new Date(base + 2 * MINUTE)),
        ]);
        const asks = lookupsSince(n0)
          .map((q) => q.path)
          .filter((p) => p.includes(encodeURIComponent(prefix)));
        expect(new Set(asks).size).toBe(asks.length);
        expect(
          both.map((x) => Object.values(x).reduce((p, q) => p + q, 0)),
        ).toEqual([50, 50]);
        expect((await row(third)).status).toBe('completed');

        // Every minute after: a new send is settled in the first pass it is
        // due, however the backlog's schedule falls.
        for (let k = 3; k < 8; k += 1) {
          const late = await newSend();
          await status.sweep(new Date(base + k * MINUTE));
          expect((await row(late)).status).toBe('completed');
        }
      } finally {
        await other.close();
        await prisma.$executeRaw`
          DELETE FROM "FintavaLedgerEntry"
           WHERE "customerReference" LIKE ${prefix + '%'}`;
        for (let i = 1; i <= N; i += 1) byReference.delete(`${prefix}${i}`);
      }
    }, 300_000);
  });

  describe('round 3: every disagreement stops, whatever arrives first, and only a complete walk is complete', () => {
    /** A bank-send delivery with the figures given (Fintava's naira). */
    function bank(o: {
      customerId: string;
      ours: string;
      fin: string;
      status: string;
      amount: number;
      charges: number;
      total: number;
    }) {
      return JSON.stringify(
        {
          event: 'customer_bank_transfer',
          data: {
            amount: o.amount,
            vat: 0,
            reference: o.fin,
            customerId: o.customerId,
            availableBalance: 109.52,
            bookedBalance: 109.52,
            status: o.status,
            total: o.total,
            description: 'Payment',
            destination: '81450/100004',
            sessionID: `S-${o.fin}`,
            customerReference: o.ours,
            senderName: 'Bayo Sandbox',
            senderAccountNumber: '0000037726',
            charges: o.charges,
          },
        },
        null,
        2,
      );
    }

    /** A ₦100 bank send, fee ₦30.75, taken to `start` the way it happens. */
    async function bankSend(
      start: 'pending' | 'failed' | 'completed' | 'absent',
      feeKobo = 3075,
    ) {
      const b = await addWallet();
      const ours = ref('OURS');
      const fin = ref('FIN');
      const entry = await sent({
        wallet: userWallet(b),
        ours,
        amountKobo: 10000,
        feeKobo,
        counterparty: toBank,
      });
      if (start === 'failed' || start === 'completed') {
        await age(entry, 3);
        byReference.set(
          ours,
          found(
            fintavaRecord({
              id: randomUUID(),
              fintava: fin,
              ours,
              amount: '100.00',
              status: start === 'failed' ? 'FAILURE' : 'SUCCESS',
            }),
          ),
        );
        expect((await status.check(entry)).outcome).toBe('settled');
      } else if (start === 'absent') {
        await age(entry, 11);
        expect((await status.check(entry)).outcome).toBe('failed_absent');
      }
      return { b, ours, fin, entry };
    }

    it("a reversal is applied only when it gives back the row's amount, fee and total to the kobo, to a row a reversal can follow; every other one is recorded on the row and moves nothing", async () => {
      // The verifier's finding 1 (B4c): each of these used to end reversed
      // with no discrepancy.
      const cases: Array<{
        name: string;
        start: 'pending' | 'failed' | 'completed' | 'absent';
        rev: { amount: number; charges?: number; total: number };
        why: string;
      }> = [
        {
          name: '₦200 back for a ₦100 send',
          start: 'failed',
          rev: { amount: 200, charges: 30.75, total: 230.75 },
          why: 'amountKobo 10000 vs 20000, totalKobo 13075 vs 23075',
        },
        {
          name: '₦100.01 back',
          start: 'failed',
          rev: { amount: 100.01, charges: 30.75, total: 130.76 },
          why: 'amountKobo 10000 vs 10001, totalKobo 13075 vs 13076',
        },
        {
          name: '₦99.99 back',
          start: 'failed',
          rev: { amount: 99.99, charges: 30.75, total: 130.74 },
          why: 'amountKobo 10000 vs 9999, totalKobo 13075 vs 13074',
        },
        {
          name: 'the amount back and Fintava keeps its fee (100, 0, 100)',
          start: 'failed',
          rev: { amount: 100, charges: 0, total: 100 },
          why: 'feeKobo 3075 vs 0, totalKobo 13075 vs 10000',
        },
        {
          name: 'no charges in the reversal',
          start: 'failed',
          rev: { amount: 100, total: 130.75 },
          why: 'feeKobo 3075 vs not reported',
        },
        {
          name: '₦200 back for a pending ₦100 send',
          start: 'pending',
          rev: { amount: 200, charges: 30.75, total: 230.75 },
          why: 'amountKobo 10000 vs 20000, totalKobo 13075 vs 23075',
        },
        {
          name: '₦200 back for a COMPLETED ₦100 send',
          start: 'completed',
          rev: { amount: 200, charges: 30.75, total: 230.75 },
          why: 'amountKobo 10000 vs 20000, totalKobo 13075 vs 23075, the send is completed',
        },
        {
          name: 'the same figures back for a COMPLETED send',
          start: 'completed',
          rev: { amount: 100, charges: 30.75, total: 130.75 },
          why: 'the send is completed',
        },
        {
          name: 'the same figures back for a send failed as absent at Fintava',
          start: 'absent',
          rev: { amount: 100, charges: 30.75, total: 130.75 },
          why: 'the send was failed as absent at Fintava',
        },
      ];
      for (const c of cases) {
        const { b, ours, fin, entry } = await bankSend(c.start);
        const before = await row(entry);
        const revRef = ref('REV');
        const e = await deliver(
          reversalDelivery({
            customerId: b.customerId,
            customerReference: ours,
            transactionReference: fin,
            reversalRef: revRef,
            ...c.rev,
          }).replace(
            c.rev.charges === undefined ? /\s*"charges": [^,]+,/ : /^$/,
            '',
          ),
        );
        expect(await consumer.consume(e)).toBe('processed');
        const note = (
          await prisma.fintavaWebhookEvent.findUniqueOrThrow({
            where: { id: e },
          })
        ).note;
        expect(note).toMatch(/not reversed: the reversal disagrees/);
        const r = await row(entry);
        expect({ case: c.name, ...r }).toMatchObject({
          case: c.name,
          status: before.status,
          failureReason: before.failureReason,
          reversedAt: null,
          reversalReference: null,
          reversalAmountKobo: null,
          reversalTotalKobo: null,
          discrepancy: `reversal sighting ${revRef}: not applied (${c.why})`,
        });
        // Held for review: a pending one is never asked again.
        if (r.status === 'pending') {
          const n = asked(ours);
          expect((await status.check(entry)).outcome).toBe('disagrees');
          await status.sweep(new Date(Date.now() + 2 * 60 * MINUTE));
          expect(asked(ours)).toBe(n);
        }
        // The same reversal again changes nothing and writes no second note.
        const again = await deliver(
          reversalDelivery({
            customerId: b.customerId,
            customerReference: ours,
            transactionReference: fin,
            reversalRef: revRef,
            ...c.rev,
            status: 'SUCCESS',
          }).replace(
            c.rev.charges === undefined ? /\s*"charges": [^,]+,/ : /^$/,
            '',
          ),
        );
        expect(await consumer.consume(again)).toBe('processed');
        expect((await row(entry)).discrepancy).toBe(r.discrepancy);
      }
    });

    it('a reversal with the same figures is applied exactly once: two deliveries of it consumed at once, beside two status checks, on a send Fintava failed; and on one still pending', async () => {
      for (const start of ['failed', 'pending'] as const) {
        const { b, ours, fin, entry } = await bankSend(start);
        const revRef = ref('REV');
        const one = reversalDelivery({
          customerId: b.customerId,
          customerReference: ours,
          transactionReference: fin,
          reversalRef: revRef,
        });
        const first = await deliver(one);
        // The same bytes again: MONEY-07 keeps one row.
        expect(await deliver(one)).toBe(first);
        const second = await deliver(
          reversalDelivery({
            customerId: b.customerId,
            customerReference: ours,
            transactionReference: fin,
            reversalRef: revRef,
            status: 'SUCCESS',
          }),
        );
        expect(second).not.toBe(first);
        const out = await Promise.all([
          consumer.consume(first),
          consumer.consume(second),
          status.check(entry),
          status.check(entry),
        ]);
        expect(out.slice(0, 2)).toEqual(['processed', 'processed']);
        const notes = (
          await prisma.fintavaWebhookEvent.findMany({
            where: { id: { in: [first, second] } },
            select: { note: true },
          })
        ).map((n) => n.note ?? '');
        expect(notes.filter((n) => /marked reversed/.test(n))).toHaveLength(1);
        expect(
          notes.filter((n) => /was already reversed/.test(n)),
        ).toHaveLength(1);
        const rows = await prisma.fintavaLedgerEntry.findMany({
          where: { wawuUserId: b.wawuUserId },
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          id: entry,
          status: 'reversed',
          reversalReference: revRef,
          reversalAmountKobo: 10000n,
          reversalChargesKobo: 3075n,
          reversalTotalKobo: 13075n,
          discrepancy: null,
        });
      }
    });

    it('an empty history page while Fintava says more pages follow is not the end of the walk: the row waits, is never failed as absent and gets no resend advice; so does any page whose figures do not agree', async () => {
      // The verifier's finding 2 (B3): page 1 `data: []` with hasNextPage
      // true and 8 pages was failed as absent after reading 1 page.
      type Shape = NonNullable<NonNullable<typeof merchantPaging>['shape']>;
      const cases: Array<[string, number, Shape, number]> = [
        [
          'page 1 empty, hasNextPage true, 8 pages (the verifier repro)',
          8,
          (p, meta, rows) => ({ meta, rows: p === 1 ? [] : rows }),
          1,
        ],
        [
          'page 3 empty, hasNextPage true, 8 pages',
          8,
          (p, meta, rows) => ({ meta, rows: p === 3 ? [] : rows }),
          3,
        ],
        [
          'page 2 calls itself page 2 of 1, no rows and no next page (past the total)',
          8,
          (p, meta, rows) =>
            p === 2
              ? {
                  meta: {
                    ...meta,
                    itemCount: Number(meta.take),
                    pageCount: 1,
                    hasNextPage: false,
                  },
                  rows: [],
                }
              : { meta, rows },
          2,
        ],
        [
          'the total changes between pages: page 3 says the history has 3 pages and ends there',
          8,
          (p, meta, rows) =>
            p === 3
              ? {
                  meta: {
                    ...meta,
                    itemCount: Number(meta.take) * 3,
                    pageCount: 3,
                    hasNextPage: false,
                  },
                  rows,
                }
              : { meta, rows },
          3,
        ],
        [
          'page 2 answers as page 1 with no next page (not the page asked for)',
          8,
          (p, meta, rows) =>
            p === 2
              ? {
                  meta: {
                    ...meta,
                    page: '1',
                    itemCount: Number(meta.take),
                    pageCount: 1,
                    hasNextPage: false,
                  },
                  rows,
                }
              : { meta, rows },
          2,
        ],
        [
          'one page, no next page, but 5 rows promised and none sent',
          1,
          (_p, meta) => ({
            meta: { ...meta, take: '100', itemCount: 5, pageCount: 1 },
            rows: [],
          }),
          1,
        ],
      ];
      for (const [name, pages, shape, read] of cases) {
        const ours = ref('OURS');
        const entry = await sent({ wallet: merchant, ours });
        await age(entry, 11);
        merchantPaging = { pages, hitPage: 0, ours, shape };
        const n0 = double.seen.length;
        let c;
        try {
          c = await status.check(entry);
        } finally {
          merchantPaging = null;
        }
        const pagesRead = double.seen
          .slice(n0)
          .filter((q) => q.path === '/txn/merchant').length;
        expect({ name, pagesRead, ...c }).toMatchObject({
          name,
          pagesRead: read,
          outcome: 'waiting',
          fintava: 'unknown',
          decision: { action: 'wait', why: 'history_incomplete' },
        });
        expect(await row(entry)).toMatchObject({
          status: 'pending',
          failureReason: null,
        });
      }

      // Controls: a complete walk still shows the send is not there.
      const controls: Array<[string, number, Shape | undefined]> = [
        ['three consistent pages, the last with no next page', 3, undefined],
        [
          'an empty history as the sandbox answers it (page 1 of 0, `sandbox/10-`)',
          1,
          (_p, meta) => ({
            meta: { ...meta, itemCount: 0, pageCount: 0, hasNextPage: false },
            rows: [],
          }),
        ],
      ];
      for (const [name, pages, shape] of controls) {
        const ours = ref('OURS');
        const entry = await sent({ wallet: merchant, ours });
        await age(entry, 11);
        merchantPaging = { pages, hitPage: 0, ours, shape };
        let c;
        try {
          c = await status.check(entry);
        } finally {
          merchantPaging = null;
        }
        expect({ name, ...c }).toMatchObject({
          name,
          outcome: 'failed_absent',
          decision: { action: 'resend_same_reference' },
        });
      }
    });

    it('a fee-only difference ends the same whichever arrives first, the webhook or the sweep: pending, the difference recorded, and left for review', async () => {
      // The verifier's finding 6 (B4b): webhook first left it pending, the
      // sweep first completed it.
      const ends: Record<string, unknown> = {};
      for (const order of ['webhook first', 'sweep first'] as const) {
        const b = await addWallet();
        const ours = ref('OURS');
        const fin = ref('FIN');
        // The sender recorded ₦40; Fintava charges ₦30.75.
        const entry = await sent({
          wallet: userWallet(b),
          ours,
          amountKobo: 10000,
          feeKobo: 4000,
          counterparty: toBank,
        });
        byReference.set(
          ours,
          found(
            fintavaRecord({
              id: randomUUID(),
              fintava: fin,
              ours,
              amount: '100.00',
            }),
          ),
        );
        await age(entry, 5);
        const text = bank({
          customerId: b.customerId,
          ours,
          fin,
          status: 'SUCCESS',
          amount: 100,
          charges: 30.75,
          total: 130.75,
        });
        if (order === 'webhook first') {
          expect(await consumer.consume(await deliver(text))).toBe('processed');
          expect((await status.check(entry)).outcome).toBe('disagrees');
        } else {
          expect((await status.check(entry)).outcome).toBe('settled');
          expect((await row(entry)).status).toBe('completed');
          expect(await consumer.consume(await deliver(text))).toBe('processed');
        }
        const r = await row(entry);
        expect(r.discrepancy).toMatch(
          /feeKobo 4000 vs 3075, totalKobo 14000 vs 13075/,
        );
        const n = asked(ours);
        await status.sweep(new Date(Date.now() + 2 * 60 * MINUTE));
        expect(asked(ours)).toBe(n);
        ends[order] = {
          status: r.status,
          completedAt: r.completedAt,
          held: r.discrepancy !== null,
        };
      }
      expect(ends['webhook first']).toEqual({
        status: 'pending',
        completedAt: null,
        held: true,
      });
      expect(ends['sweep first']).toEqual(ends['webhook first']);
    });

    it('two deliveries with the same status and other amounts both reach the ledger (MONEY-07 keys on the body), in either order the row ends pending with the difference; the same bytes twice stay one', async () => {
      // The verifier's finding 3: SUCCESS ₦100 then SUCCESS ₦200 used to
      // drop the second (same event, reference and status).
      const ends: Record<string, unknown> = {};
      for (const order of ['matching first', 'other amount first'] as const) {
        const b = await addWallet();
        const ours = ref('OURS');
        const fin = ref('FIN');
        const entry = await sent({
          wallet: userWallet(b),
          ours,
          amountKobo: 10000,
          feeKobo: 3075,
          counterparty: toBank,
        });
        const same = bank({
          customerId: b.customerId,
          ours,
          fin,
          status: 'SUCCESS',
          amount: 100,
          charges: 30.75,
          total: 130.75,
        });
        const other = bank({
          customerId: b.customerId,
          ours,
          fin,
          status: 'SUCCESS',
          amount: 200,
          charges: 30.75,
          total: 230.75,
        });
        const texts =
          order === 'matching first' ? [same, other] : [other, same];
        const ids: string[] = [];
        for (const t of texts) {
          const id = await deliver(t);
          expect(ids).not.toContain(id);
          ids.push(id);
          expect(await consumer.consume(id)).toBe('processed');
        }
        // The same bytes again: one row, nothing new for the ledger.
        expect(await deliver(texts[0])).toBe(ids[0]);
        expect(
          await prisma.fintavaWebhookEvent.count({
            where: { dataCustomerReference: ours },
          }),
        ).toBe(2);
        const r = await row(entry);
        expect(r.discrepancy).toMatch(/amountKobo 10000 vs 20000/);
        ends[order] = { status: r.status, completedAt: r.completedAt };
      }
      expect(ends['matching first']).toEqual({
        status: 'pending',
        completedAt: null,
      });
      expect(ends['other amount first']).toEqual(ends['matching first']);
    });

    it('a revival starts the schedule again: a row checked six times and then failed as absent is asked two minutes after its resend, not on its old schedule', async () => {
      // The verifier's surviving mutant: a revival that kept the old
      // `nextCheckAt` and `statusChecks`.
      const ours = ref('OURS');
      const entry = await sent({ wallet: merchant, ours });
      await age(entry, 11);
      byReference.set(ours, { status: 200, body: {} });
      let at = new Date();
      for (let i = 0; i < 6; i += 1) {
        expect((await status.check(entry, at)).outcome).toBe('waiting');
        at = (await row(entry)).nextCheckAt as Date;
      }
      byReference.delete(ours);
      expect((await status.check(entry, at)).outcome).toBe('failed_absent');
      const failed = await row(entry);
      expect(failed.statusChecks).toBe(6);
      expect(failed.nextCheckAt?.getTime()).toBeGreaterThan(
        Date.now() + 60 * MINUTE,
      );
      // The sending feature resends under the same reference.
      await ledger.record({
        wallet: merchant,
        direction: 'out',
        status: 'pending',
        category: 'transfer',
        amountKobo: 1000,
        references: { customerReference: ours },
        source: 'send',
      });
      expect(await row(entry)).toMatchObject({
        status: 'pending',
        revivedBy: 'send',
        statusChecks: 0,
        nextCheckAt: null,
      });
      byReference.set(
        ours,
        found(
          fintavaRecord({
            id: randomUUID(),
            fintava: ref('FIN'),
            ours,
            amount: '10.00',
          }),
        ),
      );
      const before = asked(ours);
      await status.sweep(new Date(Date.now() + 2 * MINUTE + 1000));
      expect(asked(ours)).toBeGreaterThan(before);
      expect((await row(entry)).status).toBe('completed');
    });

    it('two rows of one movement folded into one: a disagreement the folded row held stays on the kept row, which a matching SUCCESS then does not complete', async () => {
      // Two sightings that shared no reference wrote two rows; one of them
      // already holds a disagreement with Fintava.
      const first = ref('A');
      const second = ref('B');
      const kept = await ledger.record({
        wallet: merchant,
        direction: 'out',
        status: 'pending',
        category: 'transfer',
        amountKobo: 1000,
        references: { customerReference: first },
        source: 'send',
      });
      const folded = await ledger.record({
        wallet: merchant,
        direction: 'out',
        status: 'pending',
        category: 'transfer',
        amountKobo: 1000,
        references: { fintavaReference: second },
        source: 'webhook',
      });
      expect(folded.entryId).not.toBe(kept.entryId);
      const older = new Date(Date.now() - MINUTE);
      await prisma.fintavaLedgerEntry.update({
        where: { id: kept.entryId },
        data: { createdAt: older },
      });
      const note = 'status check: amountKobo 1000 vs 1001';
      await ledger.noteDiscrepancy(folded.entryId, note);
      // A SUCCESS that names both, with the row's own figures.
      const r = await ledger.record({
        wallet: merchant,
        direction: 'out',
        status: 'completed',
        category: 'transfer',
        amountKobo: 1000,
        references: { customerReference: first, fintavaReference: second },
        source: 'lookup',
      });
      expect(r.entryId).toBe(kept.entryId);
      expect(
        await prisma.fintavaLedgerEntry.count({
          where: { id: folded.entryId },
        }),
      ).toBe(0);
      const k = await row(kept.entryId);
      expect(k.discrepancy).toContain(note);
      expect(k.status).toBe('pending');
      expect(k.completedAt).toBeNull();
    });

    it('rows holding a disagreement are never claimed: 60 of them, due before everything else, take no slot of a sweep and are never asked', async () => {
      // The verifier's surviving mutant: the claim taking them.
      const held: string[] = [];
      for (let i = 0; i < 60; i += 1) {
        const id = await sent({ wallet: merchant, ours: ref('HELD') });
        held.push(id);
      }
      const oldest = new Date(Date.now() - 2 * 24 * 60 * MINUTE);
      await prisma.$executeRaw`
        UPDATE "FintavaLedgerEntry"
           SET "createdAt" = ${oldest}, "updatedAt" = ${oldest},
               "occurredAt" = ${oldest},
               "discrepancy" = 'status check: amountKobo 1000 vs 1001'
         WHERE "id" = ANY(${held}::text[])`;
      const ours = ref('OURS');
      const entry = await sent({ wallet: merchant, ours });
      const next = new Date(oldest.getTime() + MINUTE);
      await prisma.$executeRaw`
        UPDATE "FintavaLedgerEntry"
           SET "createdAt" = ${next}, "updatedAt" = ${next}, "occurredAt" = ${next}
         WHERE "id" = ${entry}`;
      byReference.set(
        ours,
        found(
          fintavaRecord({
            id: randomUUID(),
            fintava: ref('FIN'),
            ours,
            amount: '10.00',
          }),
        ),
      );
      const counts = await status.sweep();
      expect(counts.disagrees).toBe(0);
      expect((await row(entry)).status).toBe('completed');
      const untouched = await prisma.fintavaLedgerEntry.count({
        where: { id: { in: held }, statusChecks: 0, nextCheckAt: null },
      });
      expect(untouched).toBe(60);
    });
  });

  it('never sends money: the status check holds no call that moves it', () => {
    const src = readFileSync(
      join(__dirname, '..', 'ledger-status.service.ts'),
      'utf8',
    );
    expect(src).not.toMatch(
      /\.(walletToWallet|bankTransfer|merchantBankTransfer|retryWalletToWallet|retryBankTransfer|retryMerchantBankTransfer|buy\w+)\(/,
    );
    expect(double.seen.filter((s) => s.method !== 'GET')).toEqual([]);
  });

  it('logs carry no key, secret or personal data', () => {
    const all = logger.lines.join('\n');
    for (const s of [
      SECRET,
      KEY,
      'Ada Sandbox',
      'ABC Nigeria Ltd',
      'Bayo Sandbox',
    ]) {
      expect(all).not.toContain(s);
    }
  });
});
