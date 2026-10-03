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
        status: 'success',
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

    it('a sighting of that reference later (a resend under it, or a record Fintava did not serve before) undoes the inferred failure, and says so on the row', async () => {
      const ours = ref('OURS');
      const entry = await sent({ wallet: merchant, ours });
      await age(entry, 11);
      expect((await status.check(entry)).outcome).toBe('failed_absent');
      // The sender resends under the same reference: its row is pending again.
      await ledger.record({
        wallet: merchant,
        direction: 'out',
        status: 'pending',
        category: 'transfer',
        amountKobo: 1000,
        references: { customerReference: ours },
        source: 'send',
      });
      let r = await row(entry);
      expect(r).toMatchObject({ status: 'pending', failureReason: null });
      expect(r.discrepancy).toMatch(
        /status failed \(no record at Fintava\) vs pending/,
      );
      // A row with a recorded disagreement is left for review by the sweep.
      expect((await status.check(entry)).outcome).toBe('disagrees');

      // The other way: failed as absent, then Fintava's record turns up SUCCESS.
      const ours2 = ref('OURS');
      const two = await sent({ wallet: merchant, ours: ours2 });
      await age(two, 11);
      expect((await status.check(two)).outcome).toBe('failed_absent');
      await ledger.record({
        wallet: merchant,
        direction: 'out',
        status: 'completed',
        category: 'transfer',
        amountKobo: 1000,
        references: { customerReference: ours2, fintavaReference: ref('FIN') },
        source: 'lookup',
      });
      r = await row(two);
      expect(r).toMatchObject({ status: 'completed', failureReason: null });
      expect(r.completedAt).toBeInstanceOf(Date);
      expect(r.discrepancy).toMatch(
        /status failed \(no record at Fintava\) vs completed/,
      );
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

      // Fintava's reversal arrives (twice, under two reversal references).
      const first = await deliver(
        reversalDelivery({
          customerId: b.customerId,
          customerReference: ours,
          transactionReference: ref('TX'),
          reversalRef: ref('REV'),
        }),
      );
      const second = await deliver(
        reversalDelivery({
          customerId: b.customerId,
          customerReference: ours,
          transactionReference: ref('TX'),
          reversalRef: ref('REV'),
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
      const reversedAt = rows[0].reversedAt;

      // A late SUCCESS delivery, and more sweeps: still reversed, once.
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
