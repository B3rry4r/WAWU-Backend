import { createHash, randomInt, randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  FintavaDouble,
  MERCHANT_BALANCE,
} from '../../../test/fintava/fintava-double';
import {
  accountFunded,
  walletToWallet,
} from '../../../test/fintava/fintava-webhook-payloads';
import {
  guardOutbound,
  type OutboundGuard,
} from '../../../test/nuvion/outbound-guard';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WalletBalanceService } from '../../money/balance/wallet-balance.service';
import { LedgerConsumerService } from '../../money/ledger/ledger-consumer.service';
import { LedgerStatusService } from '../../money/ledger/ledger-status.service';
import {
  LedgerProviderConflictError,
  LedgerService,
} from '../../money/ledger/ledger.service';
import { MoneyError } from '../../money/money-error';
import { MoneyModule } from '../../money/money.module';
import { WalletOpeningService } from '../../money/opening/wallet-opening.service';
import {
  DEFAULT_ROW_PROVIDER,
  isRowOf,
  rowProvider,
  rowsOf,
} from '../../wallet-provider/provider-rows';
import {
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import { NuvionWalletProvider } from '../nuvion-wallet-provider';

/**
 * NUV-01, rollback safety (MONEY-20 verifier finding 2), over both adapters
 * against a real database.
 *
 * The rows of a wallet held by one provider stay that provider's when the
 * server is switched to the other: a Nuvion-written wallet, opening and
 * ledger row are left alone by a server switched back to `fintava` (the
 * status sweep, the opening sweep, the balance and the ledger consumer never
 * send their ids to Fintava, never fail, reverse or credit them), and a
 * server on `nuvion` leaves Fintava's rows alone the same way.
 *
 * Fintava is the local stand-in (FintavaDouble); Nuvion is never reached:
 * its adapter's areas send nothing yet, and every connection but loopback is
 * refused (outbound-guard.ts).
 */

jest.setTimeout(90_000);

const RUN = `nuv01rb-${randomUUID().slice(0, 8)}`;
const MINUTE = 60_000;

function digits(n: number): string {
  let out = String(randomInt(1, 10));
  while (out.length < n) out += String(randomInt(0, 10));
  return out;
}

/** Four people: A and B at Nuvion, C and D at Fintava. */
const A = {
  id: randomUUID(),
  customerId: `${RUN}-nA`,
  walletId: `${RUN}-nwA`,
  accountNumber: digits(10),
};
const B = { id: randomUUID(), phone: `+23480${digits(8)}` };
const C = {
  id: randomUUID(),
  customerId: `${RUN}-fC`,
  walletId: `${RUN}-fwC`,
  accountNumber: digits(10),
};
const D = { id: randomUUID(), phone: `+23481${digits(8)}` };
/** E: a wallet and a send from before the column (`provider` null): Fintava's. */
const E = {
  id: randomUUID(),
  customerId: `${RUN}-fE`,
  walletId: `${RUN}-fwE`,
  accountNumber: digits(10),
};
const NUV_REF = `${RUN}-nref`;
const FIN_REF = `${RUN}-fref`;
const OLD_REF = `${RUN}-oref`;

const FINTAVA_ENV: Record<string, string | undefined> = {
  WALLET_PROVIDER: undefined,
  FINTAVA_API_KEY: 'live_test_nuv01_rollback_0123456789FAKEKEY',
  FINTAVA_TIMEOUT_MS: '1500',
  FINTAVA_MONEY_TIMEOUT_MS: '1500',
  FINTAVA_CHECK_TIMEOUT_MS: '1500',
  IDENTITY_HASH_KEY: 'nuv01-rollback-identity-key-0123456789abcdef',
};
const NUVION_ENV: Record<string, string | undefined> = {
  ...FINTAVA_ENV,
  WALLET_PROVIDER: 'nuvion',
  NUVION_BASE_URL: 'https://api.nuvion.dev',
  NUVION_API_KEY: 'nv_test_sk_NUV01rollbackKEY000000000000',
  NUVION_WEBHOOK_SECRET: 'whsec_nuv01_rollback_0123456789',
  NUVION_OPERATIONAL_ACCOUNT_ID: '01HXYZOPERATIONAL000000001',
};

describe('NUV-01: a rollback leaves the other provider rows alone', () => {
  const double = new FintavaDouble();
  let guard: OutboundGuard;
  const saved: Record<string, string | undefined> = {};
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let nuvRow: string;
  let finRow: string;
  let oldRow: string;

  async function boot(env: Record<string, string | undefined>) {
    if (moduleRef) await moduleRef.close();
    for (const [k, v] of Object.entries({
      ...env,
      FINTAVA_BASE_URL: double.baseUrl,
    })) {
      if (!(k in saved)) saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
        MoneyModule,
      ],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    double.reset();
    return moduleRef;
  }

  const entry = (id: string) =>
    prisma.fintavaLedgerEntry.findUniqueOrThrow({ where: { id } });
  const opening = (wawuUserId: string) =>
    prisma.fintavaWalletOpening.findUniqueOrThrow({ where: { wawuUserId } });
  /** Every request the stand-in Fintava received that names `text`. */
  const asked = (text: string) =>
    double.seen.filter((r) => JSON.stringify(r).includes(text));

  beforeAll(async () => {
    guard = guardOutbound();
    await double.start();
    await boot(FINTAVA_ENV);
    const old = new Date(Date.now() - 30 * MINUTE);
    const hash = (s: string) => createHash('sha256').update(s).digest('hex');

    // A and B: written while the server ran Nuvion.
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId: A.id,
        customerId: A.customerId,
        walletId: A.walletId,
        accountNumber: A.accountNumber,
        provider: 'nuvion',
      },
    });
    await prisma.fintavaWalletOpening.create({
      data: {
        wawuUserId: B.id,
        state: 'unknown',
        bvnHash: hash(`${RUN}B`),
        bvnVerifiedAt: old,
        phone: B.phone,
        attemptStartedAt: old,
        provider: 'nuvion',
      },
    });
    // C and D: Fintava's, as every row before NUV-01 (the column's default).
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId: C.id,
        customerId: C.customerId,
        walletId: C.walletId,
        accountNumber: C.accountNumber,
      },
    });
    await prisma.fintavaWalletOpening.create({
      data: {
        wawuUserId: D.id,
        state: 'unknown',
        bvnHash: hash(`${RUN}D`),
        bvnVerifiedAt: old,
        phone: D.phone,
        attemptStartedAt: old,
      },
    });
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId: E.id,
        customerId: E.customerId,
        walletId: E.walletId,
        accountNumber: E.accountNumber,
        provider: null,
      },
    });
    // Every ledger row through the ledger's own writer, which stamps the
    // provider the server runs (SHARED-CHANGES NUV-01 #2, ruling 8).
    const send = async (
      wawuUserId: string,
      accountNumber: string,
      ref: string,
    ) =>
      (
        await moduleRef.get(LedgerService).record({
          wallet: { kind: 'user', wawuUserId, accountNumber },
          direction: 'out',
          status: 'pending',
          category: 'transfer',
          amountKobo: 150_000,
          feeKobo: 1_000,
          counterparty: {
            kind: 'bank_account',
            name: 'Someone',
            accountNumber: digits(10),
            bankCode: '058',
          },
          references: { customerReference: ref },
          source: 'send',
        })
      ).entryId;
    await boot(NUVION_ENV);
    nuvRow = await send(A.id, A.accountNumber, NUV_REF);
    await boot(FINTAVA_ENV);
    finRow = await send(C.id, C.accountNumber, FIN_REF);
    oldRow = await send(E.id, E.accountNumber, OLD_REF);
    expect((await entry(nuvRow)).provider).toBe('nuvion');
    expect((await entry(finRow)).provider).toBe('fintava');
    for (const id of [nuvRow, finRow]) {
      await prisma.fintavaLedgerEntry.update({
        where: { id },
        data: { createdAt: old },
      });
    }
    // A row from before the column.
    await prisma.fintavaLedgerEntry.update({
      where: { id: oldRow },
      data: { createdAt: old, provider: null },
    });
  });

  afterAll(async () => {
    if (prisma) {
      const users = [A.id, B.id, C.id, D.id, E.id];
      await prisma.fintavaLedgerEntry.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.fintavaWebhookEvent.deleteMany({
        where: { reference: { contains: RUN } },
      });
      await prisma.fintavaWalletOpening.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.fintavaWallet.deleteMany({
        where: { wawuUserId: { in: users } },
      });
    }
    if (moduleRef) await moduleRef.close();
    await double.stop();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    guard.restore();
  });

  describe('switched back to fintava, the Nuvion rows are left alone', () => {
    beforeAll(() => boot(FINTAVA_ENV));

    it('the server runs Fintava', () => {
      expect(moduleRef.get<WalletProvider>(WALLET_PROVIDER).name).toBe(
        'fintava',
      );
    });

    it('status sweep: never claims or checks the Nuvion pending send (never failed as absent), while it claims its own', async () => {
      const status = moduleRef.get(LedgerStatusService);
      await status.sweep(new Date());
      const n = await entry(nuvRow);
      expect(n).toMatchObject({
        status: 'pending',
        statusChecks: 0,
        nextCheckAt: null,
        failureReason: null,
        provider: 'nuvion',
      });
      expect((await entry(finRow)).statusChecks).toBe(1);
      // A row from before the column (null) is Fintava's: claimed too.
      expect(await entry(oldRow)).toMatchObject({
        statusChecks: 1,
        provider: null,
      });
      const direct = await status.check(nuvRow, new Date());
      expect(direct).toMatchObject({
        outcome: 'skipped',
        status: 'pending',
        fintava: null,
      });
      expect(direct.why).toBe('recorded by another provider than Fintava');
      expect((await entry(nuvRow)).statusChecks).toBe(0);
      expect(asked(NUV_REF)).toEqual([]);
      expect(asked(A.customerId)).toEqual([]);
    });

    it('opening sweep: never looks up the Nuvion opening, while it asks about its own', async () => {
      const service = moduleRef.get(WalletOpeningService);
      await service.sweep();
      expect(await opening(B.id)).toMatchObject({
        state: 'unknown',
        checkedAt: null,
        attempts: 1,
        provider: 'nuvion',
      });
      expect((await opening(D.id)).checkedAt).not.toBeNull();
      expect(asked(B.phone.slice(4))).toEqual([]);
      expect(asked(D.phone.slice(4)).length).toBeGreaterThan(0);
      expect(await service.reconcile({ ...(await opening(B.id)) })).toBe(
        'nothing_to_do',
      );
    });

    it('balance: the Nuvion wallet is not asked about (503, W6, and Fintava never sees its id); a Fintava wallet is', async () => {
      const balances = moduleRef.get(WalletBalanceService);
      const e: unknown = await balances
        .balance({ wawuUserId: A.id, walletId: A.walletId })
        .catch((err: unknown) => err);
      expect(e).toBeInstanceOf(MoneyError);
      expect((e as MoneyError).getStatus()).toBe(503);
      expect((e as MoneyError).getResponse()).toMatchObject({
        reason: { code: 'provider_unreachable' },
      });
      expect(asked(A.walletId)).toEqual([]);
      await balances
        .balance({ wawuUserId: C.id, walletId: C.walletId })
        .catch(() => null);
      expect(asked(C.walletId).length).toBe(1);
      // A wallet from before the column (null) is Fintava's: asked too.
      await balances
        .balance({ wawuUserId: E.id, walletId: E.walletId })
        .catch(() => null);
      expect(asked(E.walletId).length).toBe(1);
    });

    it('the ledger reads only its own provider rows: lookups, the absent check, a fold and a reversal leave the Nuvion row alone (ruling 8)', async () => {
      const ledger = moduleRef.get(LedgerService);
      expect(
        await ledger.entriesFor(A.accountNumber, 'out', [NUV_REF]),
      ).toEqual([]);
      expect(
        await ledger.entriesFor(C.accountNumber, 'out', [FIN_REF]),
      ).toEqual([finRow]);
      expect(
        await ledger.entriesFor(E.accountNumber, 'out', [OLD_REF]),
      ).toEqual([oldRow]);
      expect(await ledger.debitsFor([NUV_REF, FIN_REF])).toEqual([finRow]);
      expect(await ledger.foreignDebitsFor([NUV_REF, FIN_REF])).toEqual([
        nuvRow,
      ]);
      expect(await ledger.foreignDebitsFor([OLD_REF])).toEqual([]);

      // Never failed as absent at Fintava, even at its current version.
      const [{ v }] = await prisma.$queryRaw<Array<{ v: string }>>`
        SELECT xmin::text AS v FROM "FintavaLedgerEntry" WHERE "id" = ${nuvRow}`;
      expect(await ledger.markAbsentFailed(nuvRow, v)).toBe(false);

      // A Fintava sighting naming the Nuvion row's reference on its side: a
      // stop, never a fold; nothing is written.
      const before = await entry(nuvRow);
      await expect(
        ledger.record({
          wallet: {
            kind: 'user',
            wawuUserId: A.id,
            accountNumber: A.accountNumber,
          },
          direction: 'out',
          status: 'completed',
          category: 'transfer',
          amountKobo: 150_000,
          feeKobo: 1_000,
          references: { customerReference: NUV_REF },
          source: 'send',
        }),
      ).rejects.toBeInstanceOf(LedgerProviderConflictError);
      expect(
        (
          await prisma.fintavaLedgerEntry.findMany({
            where: { wawuUserId: A.id },
          })
        ).map((r) => r.id),
      ).toEqual([nuvRow]);

      // A reversal through the ledger itself finds no debit of its own.
      expect(
        await ledger.applyReversal({
          references: [NUV_REF],
          reversalReference: `${RUN}-rev0`,
          amountKobo: 1500,
          chargesKobo: 10,
          totalKobo: 1510,
          at: new Date(),
        }),
      ).toEqual({ state: 'no_match' });
      expect(await entry(nuvRow)).toEqual(before);
    });

    async function delivery(
      event: string,
      payload: Record<string, unknown>,
      reference: string,
    ) {
      const raw = Buffer.from(JSON.stringify(payload));
      const row = await prisma.fintavaWebhookEvent.create({
        data: {
          event,
          eventRaw: event,
          reference,
          referenceField: 'data.reference',
          fintavaStatus: '',
          rawBody: new Uint8Array(raw),
          payload: payload as never,
          bodySha256: createHash('sha256').update(raw).digest('hex'),
        },
      });
      return row.id;
    }

    it('ledger consumer: a Fintava delivery naming the Nuvion wallet does not credit it', async () => {
      const body = JSON.parse(walletToWallet(RUN)) as {
        data: Record<string, unknown>;
      };
      body.data.target_customer_id = A.customerId;
      body.data.target_customer_accno = A.accountNumber;
      body.data.target_customer_wallet = A.accountNumber;
      const id = await delivery(
        'wallet_to_wallet_transfer_v2',
        body,
        `${RUN}-w2w`,
      );
      // WAWU's merchant account, which the consumer reads to tell it apart.
      double.on('GET', '/merchant/balance', {
        status: 200,
        body: MERCHANT_BALANCE,
      });
      const consumer = moduleRef.get(LedgerConsumerService);
      expect(await consumer.consume(id)).toBe('processed');
      expect(
        (await prisma.fintavaWebhookEvent.findUniqueOrThrow({ where: { id } }))
          .note,
      ).toContain('no WAWU wallet on either side');
      const onA = await prisma.fintavaLedgerEntry.findMany({
        where: { wawuUserId: A.id },
      });
      expect(onA.map((r) => r.id)).toEqual([nuvRow]);
    });

    it('ledger consumer: money in (account_funded) naming the Nuvion customer is not credited to the Nuvion wallet', async () => {
      const body = JSON.parse(accountFunded(RUN)) as {
        data: Record<string, unknown>;
      };
      body.data.userId = A.customerId;
      body.data.beneficiaryAccountNumber = A.accountNumber;
      const id = await delivery('account_funded', body, `${RUN}-fund`);
      const consumer = moduleRef.get(LedgerConsumerService);
      expect(await consumer.consume(id)).toBe('processed');
      expect(
        (await prisma.fintavaWebhookEvent.findUniqueOrThrow({ where: { id } }))
          .note,
      ).toContain('no WAWU wallet on either side');
      const onA = await prisma.fintavaLedgerEntry.findMany({
        where: { wawuUserId: A.id },
      });
      expect(onA.map((r) => r.id)).toEqual([nuvRow]);
    });

    it('ledger consumer: a Fintava reversal naming the Nuvion debit changes nothing and is kept for review', async () => {
      const body = {
        event: 'debit_transfer_reversal',
        data: {
          amount: 1500,
          charges: 10,
          vat: 0,
          customerId: A.customerId,
          customerReference: NUV_REF,
          type: 'CREDIT',
          status: 'success',
          total: 1510,
          transactionReference: `${RUN}-tx`,
          reversalRef: `${RUN}-rev`,
        },
      };
      const id = await delivery('debit_transfer_reversal', body, `${RUN}-rev`);
      const consumer = moduleRef.get(LedgerConsumerService);
      expect(await consumer.consume(id)).toBe('failed');
      expect(
        (await prisma.fintavaWebhookEvent.findUniqueOrThrow({ where: { id } }))
          .note,
      ).toBe(
        'ledger: the reversal names a debit recorded by another provider than Fintava; nothing was changed (review)',
      );
      expect(await entry(nuvRow)).toMatchObject({
        status: 'pending',
        reversedAt: null,
        reversalReference: null,
        discrepancy: null,
      });
    });
  });

  describe('switched to nuvion, the Fintava rows are left alone', () => {
    let nuvion: NuvionWalletProvider;
    beforeAll(async () => {
      await boot(NUVION_ENV);
      nuvion = moduleRef.get<NuvionWalletProvider>(WALLET_PROVIDER);
    });
    afterEach(() => jest.restoreAllMocks());

    it('the server runs Nuvion', () => {
      expect(nuvion).toBeInstanceOf(NuvionWalletProvider);
    });

    it('status sweep: claims only the Nuvion row; the Fintava pending send is not touched and Fintava is not asked', async () => {
      const before = await entry(finRow);
      await moduleRef.get(LedgerStatusService).sweep(new Date());
      const after = await entry(finRow);
      expect(after.statusChecks).toBe(before.statusChecks);
      expect(after.nextCheckAt?.getTime()).toBe(before.nextCheckAt?.getTime());
      expect(after.status).toBe('pending');
      expect((await entry(nuvRow)).statusChecks).toBe(1);
      expect(double.seen).toEqual([]);
    });

    it('the ledger stamps nuvion on what it writes and reads only Nuvion rows (ruling 8)', async () => {
      const ledger = moduleRef.get(LedgerService);
      expect(
        await ledger.entriesFor(A.accountNumber, 'out', [NUV_REF]),
      ).toEqual([nuvRow]);
      expect(
        await ledger.entriesFor(C.accountNumber, 'out', [FIN_REF]),
      ).toEqual([]);
      expect(
        await ledger.entriesFor(E.accountNumber, 'out', [OLD_REF]),
      ).toEqual([]);
      expect(await ledger.debitsFor([NUV_REF, FIN_REF, OLD_REF])).toEqual([
        nuvRow,
      ]);
      expect(
        (await ledger.foreignDebitsFor([NUV_REF, FIN_REF, OLD_REF])).sort(),
      ).toEqual([finRow, oldRow].sort());
      const [{ v }] = await prisma.$queryRaw<Array<{ v: string }>>`
        SELECT xmin::text AS v FROM "FintavaLedgerEntry" WHERE "id" = ${oldRow}`;
      expect(await ledger.markAbsentFailed(oldRow, v)).toBe(false);
      const ref = `${RUN}-nref2`;
      const made = await ledger.record({
        wallet: {
          kind: 'user',
          wawuUserId: A.id,
          accountNumber: A.accountNumber,
        },
        direction: 'in',
        status: 'completed',
        category: 'transfer',
        amountKobo: 5_000,
        feeKobo: 0,
        references: { customerReference: ref },
        source: 'send',
      });
      expect(made.created).toBe(true);
      expect((await entry(made.entryId)).provider).toBe('nuvion');
      // The same movement seen again folds into its own Nuvion row.
      const again = await ledger.record({
        wallet: {
          kind: 'user',
          wawuUserId: A.id,
          accountNumber: A.accountNumber,
        },
        direction: 'in',
        status: 'completed',
        category: 'transfer',
        amountKobo: 5_000,
        feeKobo: 0,
        references: { customerReference: ref },
        source: 'send',
      });
      expect(again).toMatchObject({ entryId: made.entryId, created: false });
      await expect(
        ledger.record({
          wallet: {
            kind: 'user',
            wawuUserId: C.id,
            accountNumber: C.accountNumber,
          },
          direction: 'out',
          status: 'completed',
          category: 'transfer',
          amountKobo: 150_000,
          feeKobo: 1_000,
          references: { customerReference: FIN_REF },
          source: 'send',
        }),
      ).rejects.toBeInstanceOf(LedgerProviderConflictError);
    });

    it('ledger consumer: reads no Fintava delivery; a pending one stays pending, untouched', async () => {
      const body = JSON.parse(walletToWallet(`${RUN}x`)) as Record<
        string,
        unknown
      >;
      const raw = Buffer.from(JSON.stringify(body));
      const row = await prisma.fintavaWebhookEvent.create({
        data: {
          event: 'wallet_to_wallet_transfer_v2',
          reference: `${RUN}-pending`,
          referenceField: 'data.reference',
          fintavaStatus: '',
          rawBody: new Uint8Array(raw),
          payload: body as never,
          bodySha256: createHash('sha256').update(raw).digest('hex'),
        },
      });
      const consumer = moduleRef.get(LedgerConsumerService);
      expect(await consumer.sweep(new Date())).toEqual({
        processed: 0,
        failed: 0,
        waiting: 0,
        skipped: 0,
      });
      expect(await consumer.consume(row.id)).toBe('skipped');
      expect(
        await prisma.fintavaWebhookEvent.findUniqueOrThrow({
          where: { id: row.id },
        }),
      ).toMatchObject({
        processingStatus: 'pending',
        note: null,
      });
    });

    it('opening sweep: the Fintava opening is not looked up at Nuvion; the Nuvion one is', async () => {
      const find = jest.spyOn(nuvion, 'findCustomerByPhone');
      const before = await opening(D.id);
      await moduleRef.get(WalletOpeningService).sweep();
      expect((await opening(D.id)).checkedAt?.getTime()).toBe(
        before.checkedAt?.getTime(),
      );
      expect(find.mock.calls.map((c) => c[0])).toEqual([B.phone]);
      expect(double.seen).toEqual([]);
    });

    it('balance: the Fintava wallet is not asked about at Nuvion (503); the Nuvion one is', async () => {
      const get = jest.spyOn(nuvion, 'getBalance');
      const balances = moduleRef.get(WalletBalanceService);
      const e: unknown = await balances
        .balance({ wawuUserId: C.id, walletId: C.walletId })
        .catch((err: unknown) => err);
      expect((e as MoneyError).getStatus()).toBe(503);
      expect(get).not.toHaveBeenCalled();
      await balances
        .balance({ wawuUserId: A.id, walletId: A.walletId })
        .catch(() => null);
      expect(get.mock.calls).toEqual([[{ walletId: A.walletId }]]);
      expect(double.seen).toEqual([]);
    });
  });

  describe('which provider a row is, null included (the column default)', () => {
    it('null is Fintava, never another provider; anything else unknown is no provider', () => {
      expect(DEFAULT_ROW_PROVIDER).toBe('fintava');
      expect(rowProvider(null)).toBe('fintava');
      expect(rowProvider(undefined)).toBe('fintava');
      expect(rowProvider(' NUVION ')).toBe('nuvion');
      expect(rowProvider('flutterwave')).toBe('other');
      expect(isRowOf('fintava', null)).toBe(true);
      expect(isRowOf('nuvion', null)).toBe(false);
      expect(isRowOf('nuvion', 'nuvion')).toBe(true);
      expect(isRowOf('fintava', 'nuvion')).toBe(false);
      expect(rowsOf('fintava')).toEqual({
        OR: [{ provider: 'fintava' }, { provider: null }],
      });
      expect(rowsOf('nuvion')).toEqual({ OR: [{ provider: 'nuvion' }] });
    });
  });

  it('no connection left this machine (Nuvion and Fintava hosts alike)', () => {
    expect(guard.violations).toEqual([]);
  });
});
