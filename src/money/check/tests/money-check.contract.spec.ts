import { randomUUID } from 'node:crypto';
import { type LoggerService } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Prisma } from '../../../../generated/prisma/client';
import { FintavaBooks } from '../../../../test/fintava/fintava-books-standin';
import { WawuIdMailDouble } from '../../../../test/money/wawu-id-mail-double';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../../wallet-provider/wallet-provider.interface';
import { WalletProviderError } from '../../../wallet-provider/wallet-provider-error';
import { MoneyModule } from '../../money.module';
import { LEDGER_ABSENT_FAILURE } from '../../ledger/ledger.service';
import { parseArgs, summaryOf } from '../money-check-cli';
import { MoneyCheckSettings } from '../money-check-config';
import { MoneyCheckScope } from '../money-check-scope';
import {
  MoneyCheckService,
  type RunOptions,
  type RunOutcome,
} from '../money-check.service';
import type { Finding, MoneyCheckReport } from '../money-check-types';

/**
 * The nightly check (task MONEY-16) end to end on a real database: the real
 * MoneyModule, the real Fintava adapter and client over a socket to a
 * stand-in for Fintava's books (test/fintava/fintava-books-standin.ts), and
 * WAWU ID's mail route played by a local double. Each test plants one
 * difference on one side only and checks the night reports it, or builds a
 * clean night and checks it says so.
 *
 * The spec owns only the rows it writes (every reference starts with this
 * run's prefix) and the scope narrows the check to them, so the other specs'
 * rows in a shared database cannot change a result.
 */

const RUN = `m16${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PREFIX = `m16-${RUN}-`;
const HOUR = 3_600_000;
const MIN = 60_000;

jest.setTimeout(120_000);

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

/** Only the rows this spec wrote. */
class SpecScope extends MoneyCheckScope {
  users: string[] = [];
  failWalletQuery = false;
  walletWhere(): Prisma.FintavaWalletWhereInput {
    if (this.failWalletQuery) throw new Error('planted failure');
    return { wawuUserId: { in: this.users } };
  }
  ledgerWhere(): Prisma.FintavaLedgerEntryWhereInput {
    return { customerReference: { startsWith: PREFIX } };
  }
  paymentWhere(): Prisma.WalletPaymentWhereInput {
    return { customerReference: { startsWith: PREFIX } };
  }
  holdWhere(): Prisma.WalletHoldWhereInput {
    return { payment: { customerReference: { startsWith: PREFIX } } };
  }
}

interface Wallet {
  wawuUserId: string;
  customerId: string;
  walletId: string;
  accountNumber: string;
}

describe('the nightly check against the wallet provider (MONEY-16)', () => {
  const books = new FintavaBooks();
  const mail = new WawuIdMailDouble();
  const logger = new QuietLogger();
  const scope = new SpecScope();
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let service: MoneyCheckService;
  let provider: WalletProvider;
  let cfg: MoneyCheckSettings;
  const saved: Record<string, string | undefined> = {};
  const profiles: string[] = [];
  let seq = 0;
  let nightNo = 0;
  const usedAccounts = new Set<string>();

  const ago = (ms: number) => new Date(Date.now() - ms);
  const acct = (): string => {
    for (;;) {
      const a = String(
        1_000_000_000 + Math.floor(Math.random() * 8_999_999_999),
      );
      if (!usedAccounts.has(a)) {
        usedAccounts.add(a);
        return a;
      }
    }
  };
  const night = (): string => {
    nightNo += 1;
    const year = 2090 + Math.floor(nightNo / 336);
    const month = 1 + (Math.floor(nightNo / 28) % 12);
    const day = 1 + (nightNo % 28);
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  };
  const ref = (): string => `${PREFIX}${(seq += 1)}`;

  async function wallet(
    balanceKobo: number,
    over: { provider?: string } = {},
  ): Promise<Wallet> {
    const w: Wallet = {
      wawuUserId: randomUUID(),
      customerId: randomUUID(),
      walletId: randomUUID(),
      accountNumber: acct(),
    };
    await prisma.fintavaWallet.create({
      data: { ...w, provider: over.provider ?? 'fintava' },
    });
    scope.users.push(w.wawuUserId);
    books.addWallet({
      customerId: w.customerId,
      walletId: w.walletId,
      accountNumber: w.accountNumber,
      availableKobo: balanceKobo,
    });
    return w;
  }

  interface RowOver {
    wallet?: Wallet;
    direction: 'in' | 'out';
    amountKobo: number;
    feeKobo?: number;
    status?: 'pending' | 'completed' | 'failed' | 'reversed';
    wawuFeeKobo?: number;
    ref?: string;
    ageMs?: number;
    discrepancy?: string;
    bank?: boolean;
    failureReason?: string;
    provider?: string | null;
    category?: 'transfer' | 'top_up' | 'purchase' | 'earning' | 'refund';
  }

  /** One ledger row (the wallet's, or WAWU's own account when no wallet is given). */
  async function row(over: RowOver): Promise<{ id: string; ref: string }> {
    const id = randomUUID();
    const reference = over.ref ?? ref();
    const at = ago(over.ageMs ?? 10 * HOUR);
    const account = over.wallet?.accountNumber ?? books.merchant.accountNumber;
    const fee = over.feeKobo ?? 0;
    await prisma.fintavaLedgerEntry.create({
      data: {
        id,
        walletKind: over.wallet ? 'user' : 'merchant',
        wawuUserId: over.wallet?.wawuUserId ?? null,
        accountNumber: account,
        direction: over.direction,
        status: over.status ?? 'completed',
        category: over.category ?? 'transfer',
        amountKobo: BigInt(over.amountKobo),
        feeKobo: BigInt(fee),
        totalKobo: BigInt(
          over.amountKobo + (over.direction === 'out' ? fee : 0),
        ),
        wawuFeeKobo:
          over.wawuFeeKobo === undefined ? null : BigInt(over.wawuFeeKobo),
        counterpartyKind: over.bank ? 'bank_account' : null,
        customerReference: reference,
        failureReason: over.failureReason ?? null,
        discrepancy: over.discrepancy ?? null,
        source: 'send',
        occurredAt: at,
        createdAt: at,
        provider: over.provider === undefined ? 'fintava' : over.provider,
        references: {
          create: [
            {
              accountNumber: account,
              direction: over.direction,
              value: reference,
              kind: 'ours',
            },
          ],
        },
      },
    });
    return { id, ref: reference };
  }

  /** A debit as Fintava shows it, for the holder (a wallet's customer, or WAWU's own account). */
  function theirs(
    holder: Wallet | 'merchant',
    reference: string,
    amountKobo: number,
    over: {
      status?: string;
      ageMs?: number;
      merchantCommKobo?: number | null;
    } = {},
  ) {
    return books.addDebit({
      holder: holder === 'merchant' ? 'merchant' : holder.customerId,
      amountKobo,
      ourReference: reference,
      status: over.status ?? 'SUCCESS',
      createdAt: ago(over.ageMs ?? 10 * HOUR).toISOString(),
      ...(over.merchantCommKobo === undefined
        ? {}
        : { merchantCommKobo: over.merchantCommKobo }),
    });
  }

  /** A send both sides agree on: the ledger row and Fintava's debit. */
  async function send(
    w: Wallet,
    amountKobo: number,
    over: Partial<RowOver> = {},
  ): Promise<{ id: string; ref: string; debitId: string }> {
    const r = await row({ wallet: w, direction: 'out', amountKobo, ...over });
    const d = theirs(w, r.ref, amountKobo, { ageMs: over.ageMs });
    return { ...r, debitId: d.id };
  }

  async function run(over: RunOptions = {}): Promise<RunOutcome> {
    return service.runNight({
      night: night(),
      windowFrom: ago(48 * HOUR),
      ...over,
    });
  }

  async function report(over: RunOptions = {}): Promise<MoneyCheckReport> {
    const outcome = await run(over);
    if (outcome.state !== 'finished') {
      throw new Error(`the run ${outcome.state}`);
    }
    return outcome.report;
  }

  const all = (r: MoneyCheckReport): Finding[] => [...r.mismatches, ...r.look];
  const kinds = (r: MoneyCheckReport): string[] =>
    all(r)
      .map((f) => `${f.check}:${f.kind}`)
      .sort();
  const refsOf = (r: MoneyCheckReport, kind: string): string[] =>
    all(r)
      .filter((f) => f.kind === kind)
      .map((f) => f.ref);

  /** A creator whose account exists, so money owed to them is not owed to nobody. */
  async function liveCreator(): Promise<string> {
    const id = randomUUID();
    await prisma.userProfile.create({
      data: { wawuUserId: id, accountType: 'creator' },
    });
    profiles.push(id);
    return id;
  }

  async function payment(
    over: {
      status?: string;
      kind?: string;
      ref?: string;
      payer?: string | null;
      payee?: string | null;
      priceKobo?: number;
      reviewSince?: Date | null;
      chargeReviewSince?: Date | null;
      debitReviewSince?: Date | null;
      discrepancy?: string | null;
      ageMs?: number;
      provider?: string;
      /** Leave the ledger rows a completed payment makes unwritten. */
      rows?: false;
    } = {},
  ) {
    const id = randomUUID();
    const price = over.priceKobo ?? 100_000;
    const at = ago(over.ageMs ?? 10 * HOUR);
    const payee = over.payee === undefined ? await liveCreator() : over.payee;
    const payeeShare = payee ? Math.floor((price * 8500) / 10_000) : 0;
    const status = over.status ?? 'completed';
    const payer = over.payer === undefined ? randomUUID() : over.payer;
    const reference = over.ref ?? ref();
    if (status === 'completed' && over.rows !== false) {
      // The two rows a completed payment leaves: WAWU's account in, the payer's wallet out.
      await row({
        direction: 'in',
        amountKobo: price,
        ref: reference,
        ageMs: over.ageMs,
        provider: over.provider,
      });
      if (payer) {
        const buyer = {
          wawuUserId: payer,
          customerId: randomUUID(),
          walletId: randomUUID(),
          accountNumber: acct(),
        };
        await row({
          wallet: buyer,
          direction: 'out',
          amountKobo: price,
          feeKobo: 2325,
          ref: reference,
          ageMs: over.ageMs,
          provider: over.provider,
        });
      }
    }
    return prisma.walletPayment.create({
      data: {
        id,
        payerWawuUserId: payer,
        kind: over.kind ?? 'paid_dm',
        targetId: randomUUID(),
        title: 'A paid question',
        payeeWawuUserId: payee,
        priceKobo: BigInt(price),
        providerFeeKobo: 2325n,
        wawuFeeKobo: 0n,
        totalKobo: BigInt(price + 2325),
        payeeShareKobo: BigInt(payeeShare),
        wawuShareKobo: BigInt(price - payeeShare),
        customerReference: reference,
        merchantAccountNumber: books.merchant.accountNumber,
        provider: over.provider ?? 'fintava',
        status,
        reviewSince: over.reviewSince ?? null,
        chargeReviewSince: over.chargeReviewSince ?? null,
        debitReviewSince: over.debitReviewSince ?? null,
        discrepancy: over.discrepancy ?? null,
        createdAt: at,
        completedAt: status === 'completed' ? at : null,
      },
    });
  }

  async function hold(
    p: {
      id: string;
      payerWawuUserId: string | null;
      payeeWawuUserId: string | null;
      priceKobo: bigint;
      payeeShareKobo: bigint;
      wawuShareKobo: bigint;
      kind: string;
    },
    over: {
      status?: 'held' | 'released' | 'refunded';
      action?: 'release' | 'refund' | null;
      reviewSince?: Date | null;
      sentAt?: Date | null;
      actionAt?: Date | null;
      waiting?: string | null;
      ref?: string | null;
      transferKobo?: number | null;
      settledAt?: Date | null;
      provider?: string;
    } = {},
  ) {
    const status = over.status ?? 'held';
    return prisma.walletHold.create({
      data: {
        paymentId: p.id,
        payerWawuUserId: p.payerWawuUserId,
        payeeWawuUserId: p.payeeWawuUserId,
        kind: p.kind,
        targetId: randomUUID(),
        title: 'A paid question',
        releaseCondition: 'dm_answered',
        amountKobo: p.priceKobo,
        payeeShareKobo: p.payeeShareKobo,
        wawuShareKobo: p.wawuShareKobo,
        merchantAccountNumber: books.merchant.accountNumber,
        provider: over.provider ?? 'fintava',
        status,
        heldAt: ago(20 * HOUR),
        settledAt:
          status === 'held' ? null : (over.settledAt ?? ago(10 * HOUR)),
        refundedKobo: status === 'refunded' ? p.priceKobo : null,
        action:
          over.action ??
          (status === 'held'
            ? null
            : status === 'released'
              ? 'release'
              : 'refund'),
        actionAt:
          over.actionAt ??
          (status === 'held' && !over.action ? null : ago(11 * HOUR)),
        transferKobo:
          over.transferKobo === undefined
            ? status === 'held'
              ? null
              : status === 'released'
                ? p.payeeShareKobo
                : p.priceKobo
            : over.transferKobo === null
              ? null
              : BigInt(over.transferKobo),
        customerReference: over.ref === undefined ? null : over.ref,
        reviewSince: over.reviewSince ?? null,
        sentAt: over.sentAt ?? null,
        waiting: over.waiting ?? null,
      },
    });
  }

  async function wipe(): Promise<void> {
    await prisma.moneyCheckRun.deleteMany({});
    await prisma.fintavaLedgerEntry.deleteMany({
      where: { customerReference: { startsWith: PREFIX } },
    });
    await prisma.walletHold.deleteMany({
      where: { payment: { customerReference: { startsWith: PREFIX } } },
    });
    await prisma.walletPayment.deleteMany({
      where: { customerReference: { startsWith: PREFIX } },
    });
    await prisma.fintavaWallet.deleteMany({
      where: { wawuUserId: { in: scope.users } },
    });
    await prisma.userProfile.deleteMany({
      where: { wawuUserId: { in: profiles } },
    });
    scope.users = [];
    scope.failWalletQuery = false;
    profiles.length = 0;
    books.wallets.clear();
    books.debits.length = 0;
    books.fail.clear();
    books.ascending = false;
    books.unknownIds.clear();
    books.seen.length = 0;
    books.merchant.availableKobo = 0;
    mail.mailed.length = 0;
    mail.refuse.clear();
    mail.refuseAll = null;
    logger.lines.length = 0;
  }

  beforeAll(async () => {
    await books.start();
    await mail.start();
    const env: Record<string, string> = {
      FINTAVA_BASE_URL: books.baseUrl,
      FINTAVA_API_KEY: 'live_test_m16_0123456789FAKEKEY',
      FEE_QUOTE_KEY: 'm16-test-fee-quote-key-0123456789abcdef0123',
      FINTAVA_WEBHOOK_SECRET: 'whsec_local_m16_Qv7Lp3Xc9Ty2Hb5Jn',
      WAWU_ID_BASE_URL: mail.baseUrl,
      WAWU_ID_INTERNAL_SERVICE_KEY: 'm16-service-key-not-secret',
      PAYMENT_REVIEW_AFTER_HOURS: '',
      LEDGER_CONFIRM_WINDOW_HOURS: '',
    };
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    cfg = new MoneyCheckSettings({
      get: (key: string) =>
        ({
          MONEY_CHECK_CALL_GAP_MS: '0',
          MONEY_CHECK_RECIPIENT_WAWU_IDS: 'owner-one,owner-two',
        })[key],
    } as never);
    cfg.recheckMs = [0, 0];
    cfg.retryMs = [0];
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
        MoneyModule,
      ],
    })
      .overrideProvider(MoneyCheckSettings)
      .useValue(cfg)
      .overrideProvider(MoneyCheckScope)
      .useValue(scope)
      .setLogger(logger)
      .compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    service = moduleRef.get(MoneyCheckService);
    provider = moduleRef.get<WalletProvider>(WALLET_PROVIDER);
  });

  afterAll(async () => {
    if (prisma) await wipe();
    if (moduleRef) await moduleRef.close();
    await books.stop();
    await mail.stop();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(async () => {
    await wipe();
    books.merchant.availableKobo = 10_000_000;
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------

  describe('a clean night', () => {
    it('reports zero mismatches and says how many wallets it checked', async () => {
      const a = await wallet(70_000);
      const b = await wallet(25_000);
      await wallet(0);
      await row({
        wallet: a,
        direction: 'in',
        amountKobo: 100_000,
        category: 'top_up',
      });
      await send(a, 30_000);
      await row({ wallet: b, direction: 'in', amountKobo: 30_000 });
      await send(b, 5_000);
      // WAWU's own account: a debit both sides have.
      const m = await row({ direction: 'out', amountKobo: 8_000 });
      theirs('merchant', m.ref, 8_000);

      const outcome = await run();
      expect(outcome.state).toBe('finished');
      if (outcome.state !== 'finished') return;
      const r = outcome.report;
      expect(r.verdict).toBe('clean');
      expect(r.wallets).toEqual({ total: 3, checked: 3, notChecked: {} });
      expect(r.mismatches).toEqual([]);
      expect(r.look).toEqual([]);
      expect(r.checks.map((c2) => [c2.id, c2.state])).toEqual([
        ['movements', 'ok'],
        ['merchant_movements', 'ok'],
        ['balances', 'ok'],
        ['held_money', 'ok'],
        ['merchant_charges', 'ok'],
        ['ledger_rows', 'ok'],
        ['payments', 'ok'],
        ['holds', 'ok'],
      ]);
      expect(r.checks.find((x) => x.id === 'balances')?.checked).toBe(3);
      expect(r.checks.find((x) => x.id === 'movements')?.checked).toBe(2);

      const stored = await prisma.moneyCheckRun.findUniqueOrThrow({
        where: { id: outcome.runId },
      });
      expect(stored).toMatchObject({
        status: 'finished',
        verdict: 'clean',
        walletsTotal: 3,
        walletsChecked: 3,
        mismatchCount: 0,
        lookCount: 0,
        provider: 'fintava',
      });
      // A clean night is told to the owners too: silence must never mean clean.
      expect(mail.mailed.map((x) => x.userId).sort()).toEqual([
        'owner-one',
        'owner-two',
      ]);
      expect(mail.mailed[0].serviceKey).toBe('m16-service-key-not-secret');
      expect(mail.mailed[0].body).toMatchObject({
        verdict: 'clean',
        walletsChecked: 3,
        walletsTotal: 3,
        mismatchCount: 0,
        items: [],
      });
      expect(stored.emailedAt).not.toBeNull();
      expect(stored.emailedTo.sort()).toEqual(['owner-one', 'owner-two']);
    });

    it('never changes a ledger row, a hold, a payment or a wallet', async () => {
      const a = await wallet(1);
      await row({ wallet: a, direction: 'in', amountKobo: 100_000 });
      const lost = await send(a, 5_000);
      await prisma.fintavaLedgerEntry.update({
        where: { id: lost.id },
        data: { amountKobo: 5_001n },
      });
      theirs(a, ref(), 9_999); // only at Fintava
      const p = await payment({ status: 'pending', reviewSince: new Date() });
      await hold(p, { status: 'held' });
      const snap = async () =>
        JSON.stringify(
          await Promise.all([
            prisma.fintavaLedgerEntry.findMany({
              where: { customerReference: { startsWith: PREFIX } },
              orderBy: { id: 'asc' },
            }),
            prisma.walletHold.findMany({
              orderBy: { id: 'asc' },
              where: { paymentId: p.id },
            }),
            prisma.walletPayment.findMany({
              orderBy: { id: 'asc' },
              where: { customerReference: { startsWith: PREFIX } },
            }),
            prisma.fintavaWallet.findMany({
              where: { wawuUserId: { in: scope.users } },
              orderBy: { wawuUserId: 'asc' },
            }),
          ]),
          (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v),
        );
      const before = await snap();
      const r = await report();
      expect(r.verdict).toBe('differences');
      expect(await snap()).toBe(before);
    });
  });

  // -------------------------------------------------------------------------

  describe('a difference between the ledger and Fintava', () => {
    it('reports a debit that only Fintava has', async () => {
      const a = await wallet(70_000);
      await row({ wallet: a, direction: 'in', amountKobo: 100_000 });
      await send(a, 30_000);
      const stray = theirs(a, `${PREFIX}stray`, 12_300);
      books.wallets.get(a.walletId)!.availableKobo = 70_000 - 12_300;
      const r = await report();
      expect(r.verdict).toBe('differences');
      const f = r.mismatches.find((x) => x.kind === 'provider_only');
      expect(f).toMatchObject({
        check: 'movements',
        ref: `${PREFIX}stray`,
        amountKobo: '12300',
      });
      // The same money is missing from the ledger's balance too.
      expect(refsOf(r, 'balance_differs')).toEqual([a.walletId]);
      void stray;
    });

    it('reports a send that only our ledger has', async () => {
      const a = await wallet(100_000);
      await row({ wallet: a, direction: 'in', amountKobo: 100_000 });
      const lost = await row({
        wallet: a,
        direction: 'out',
        amountKobo: 40_000,
      });
      // Fintava has no record: its balance is unchanged at 100,000, ours says 60,000.
      const r = await report();
      expect(r.verdict).toBe('differences');
      expect(kinds(r)).toEqual([
        'balances:balance_differs',
        'movements:ledger_only',
      ]);
      expect(refsOf(r, 'ledger_only')).toEqual([lost.id]);
    });

    it('reports a wrong amount on a send both sides have', async () => {
      const a = await wallet(70_000);
      await row({ wallet: a, direction: 'in', amountKobo: 100_000 });
      const s = await send(a, 30_000);
      // The ledger was altered: it now says 30,500 left. Fintava still says 30,000.
      await prisma.fintavaLedgerEntry.update({
        where: { id: s.id },
        data: { amountKobo: 30_500n, totalKobo: 30_500n },
      });
      const r = await report();
      expect(r.verdict).toBe('differences');
      const f = r.mismatches.find((x) => x.kind === 'amount_differs');
      expect(f).toMatchObject({
        ref: s.id,
        amountKobo: '30500',
        otherKobo: '30000',
      });
      expect(refsOf(r, 'balance_differs')).toEqual([a.walletId]);
    });

    it('reports an altered test row the next run (the capability check)', async () => {
      const a = await wallet(70_000);
      await row({ wallet: a, direction: 'in', amountKobo: 100_000 });
      const s = await send(a, 30_000);
      const tonight = night();
      const clean = await report({ night: tonight });
      expect(clean.verdict).toBe('clean');

      // Somebody alters the row: the next run reports it.
      await prisma.fintavaLedgerEntry.update({
        where: { id: s.id },
        data: { status: 'failed' },
      });
      const next = await report({ night: tonight, again: true });
      expect(next.verdict).toBe('differences');
      expect(refsOf(next, 'status_differs')).toEqual([s.id]);
      expect(refsOf(next, 'balance_differs')).toEqual([a.walletId]);
    });

    it('reports a status that cannot be true on both sides', async () => {
      const a = await wallet(100_000);
      await row({ wallet: a, direction: 'in', amountKobo: 100_000 });
      const completedHere = await row({
        wallet: a,
        direction: 'out',
        amountKobo: 10_000,
      });
      theirs(a, completedHere.ref, 10_000, { status: 'FAILURE' });
      const r = await report();
      expect(kinds(r)).toContain('movements:status_differs');
      expect(refsOf(r, 'status_differs')).toEqual([completedHere.id]);
    });

    it('leaves a movement too new to judge for tomorrow', async () => {
      const a = await wallet(100_000);
      await row({ wallet: a, direction: 'in', amountKobo: 100_000 });
      await send(a, 10_000, { ageMs: 5 * MIN });
      books.wallets.get(a.walletId)!.availableKobo = 90_000;
      const r = await report();
      expect(r.verdict).toBe('clean');
      expect(r.notices.too_new_to_judge?.count).toBe(1);
    });

    it('a pending record Fintava keeps for a refused send is a notice, not a mismatch', async () => {
      const a = await wallet(100_000);
      await row({ wallet: a, direction: 'in', amountKobo: 100_000 });
      theirs(a, `${PREFIX}refused`, 10_000, { status: 'PENDING' });
      const r = await report();
      expect(r.verdict).toBe('clean');
      expect(r.notices.provider_pending_not_in_ledger).toEqual({
        count: 1,
        amountKobo: '10000',
      });
    });

    it("Fintava's own charges to WAWU are a notice with their sum, not a mismatch", async () => {
      books.addDebit({
        holder: 'merchant',
        amountKobo: 500,
        ourReference: null,
        transType: 'BVNCHARGE',
        createdAt: ago(10 * HOUR).toISOString(),
      });
      const r = await report();
      expect(r.verdict).toBe('clean');
      expect(r.notices.provider_charges_to_wawu).toEqual({
        count: 1,
        amountKobo: '500',
      });
    });

    it("reads WAWU's own account the same way", async () => {
      const m = await row({ direction: 'out', amountKobo: 8_000 });
      theirs('merchant', m.ref, 9_000); // wrong amount
      theirs('merchant', `${PREFIX}merchant-only`, 4_000); // only at Fintava
      await row({ direction: 'out', amountKobo: 2_000 }); // only in the ledger
      const r = await report();
      expect(r.verdict).toBe('differences');
      expect(
        all(r)
          .filter((f) => f.check === 'merchant_movements')
          .map((f) => f.kind)
          .sort(),
      ).toEqual(['amount_differs', 'ledger_only', 'provider_only']);
    });

    it('stops reading a long history at the first page that reaches before the window', async () => {
      const a = await wallet(0);
      await row({ wallet: a, direction: 'in', amountKobo: 10_000_000 });
      for (let i = 0; i < 30; i += 1)
        await send(a, 1_000, { ageMs: (11 + i / 10) * HOUR });
      for (let i = 0; i < 150; i += 1)
        await send(a, 1_000, { ageMs: (100 + i) * HOUR });
      books.wallets.get(a.walletId)!.availableKobo = 10_000_000 - 180_000;
      const r = await report({ windowFrom: ago(48 * HOUR) });
      expect(r.verdict).toBe('clean');
      expect(r.checks.find((c) => c.id === 'movements')?.checked).toBe(30);
      expect(books.seen.filter((x) => x === 'GET /txn')).toHaveLength(1);
    });

    it('reads a little past the start of the window, so a row on its edge finds its pair', async () => {
      const a = await wallet(0);
      await row({ wallet: a, direction: 'in', amountKobo: 10_000_000 });
      // A page of 100 that reaches an hour before the window starts...
      for (let i = 0; i < 100; i += 1) {
        await send(a, 1_000, { ageMs: (47.9 + (i * 1.1) / 100) * HOUR });
      }
      // ...and, on the next page, a debit Fintava timed two hours before the
      // window that the ledger timed inside it.
      const edge = await row({
        wallet: a,
        direction: 'out',
        amountKobo: 1_000,
        ageMs: 47.99 * HOUR,
      });
      theirs(a, edge.ref, 1_000, { ageMs: 50 * HOUR });
      books.wallets.get(a.walletId)!.availableKobo = 10_000_000 - 101_000;
      const r = await report({ windowFrom: ago(48 * HOUR) });
      expect(r.mismatches).toEqual([]);
      expect(r.verdict).toBe('clean');
    });

    it('reads a history that is not newest first to its end, and still calls nothing missing that is there', async () => {
      books.ascending = true;
      const a = await wallet(0);
      await row({ wallet: a, direction: 'in', amountKobo: 10_000_000 });
      for (let i = 0; i < 30; i += 1)
        await send(a, 1_000, { ageMs: (11 + i / 10) * HOUR });
      for (let i = 0; i < 150; i += 1)
        await send(a, 1_000, { ageMs: (100 + i) * HOUR });
      books.wallets.get(a.walletId)!.availableKobo = 10_000_000 - 180_000;
      const r = await report({ windowFrom: ago(48 * HOUR) });
      expect(r.verdict).toBe('clean');
      expect(r.checks.find((c) => c.id === 'movements')?.checked).toBe(30);
      expect(books.seen.filter((x) => x === 'GET /txn')).toHaveLength(2);
    });

    it('reads a long history across pages and still finds the one difference in it', async () => {
      const a = await wallet(0);
      await row({ wallet: a, direction: 'in', amountKobo: 10_000_000 });
      for (let i = 0; i < 230; i += 1)
        await send(a, 1_000, { ageMs: (11 + i / 100) * HOUR });
      theirs(a, `${PREFIX}deep`, 777, { ageMs: 11.5 * HOUR });
      books.wallets.get(a.walletId)!.availableKobo = 10_000_000 - 230_000 - 777;
      const r = await report();
      expect(refsOf(r, 'provider_only')).toEqual([`${PREFIX}deep`]);
      expect(r.wallets.checked).toBe(1);
      expect(
        books.seen.filter((s) => s.startsWith('GET /txn')).length,
      ).toBeGreaterThanOrEqual(3);
    });
  });

  // -------------------------------------------------------------------------

  describe("WAWU's charge on a send (R-10, OPS-09)", () => {
    async function feeSend(
      w: Wallet,
      commKobo: number | null,
      feeKobo = 1_000,
    ) {
      const r = await row({
        wallet: w,
        direction: 'out',
        amountKobo: 50_000,
        feeKobo: feeKobo + 4_000,
        wawuFeeKobo: feeKobo,
      });
      const d = theirs(w, r.ref, 50_000, { merchantCommKobo: commKobo });
      return { ...r, debitId: d.id };
    }

    it("is clean when the provider's own record shows the charge paid to WAWU", async () => {
      const a = await wallet(100_000 - 55_000);
      await row({ wallet: a, direction: 'in', amountKobo: 100_000 });
      await feeSend(a, 1_000);
      const r = await report();
      expect(r.verdict).toBe('clean');
      expect(r.checks.find((c) => c.id === 'merchant_charges')).toMatchObject({
        state: 'ok',
        checked: 1,
      });
    });

    it('reports a transfer whose merchant charge did not land (the capability check)', async () => {
      const a = await wallet(100_000 - 55_000);
      await row({ wallet: a, direction: 'in', amountKobo: 100_000 });
      const s = await feeSend(a, null);
      const r = await report();
      expect(r.verdict).toBe('differences');
      expect(r.mismatches).toEqual([
        expect.objectContaining({
          check: 'merchant_charges',
          kind: 'merchant_charge_missing',
          ref: s.id,
          amountKobo: '1000',
        }),
      ]);
    });

    it('reports a charge that landed at another figure, and a charge of nothing', async () => {
      const a = await wallet(100_000 - 110_000 + 100_000);
      await row({ wallet: a, direction: 'in', amountKobo: 100_000 });
      const low = await feeSend(a, 500);
      const zero = await feeSend(a, 0);
      const r = await report();
      expect(refsOf(r, 'merchant_charge_differs').sort()).toEqual(
        [low.id, zero.id].sort(),
      );
      const f = r.mismatches.find((x) => x.ref === low.id);
      expect(f).toMatchObject({ amountKobo: '1000', otherKobo: '500' });
    });

    it('does not look up a send that carries no WAWU fee', async () => {
      const a = await wallet(100_000 - 50_000);
      await row({ wallet: a, direction: 'in', amountKobo: 100_000 });
      await send(a, 50_000);
      await report();
      expect(books.seen.some((x) => x.startsWith('GET /transaction/id'))).toBe(
        false,
      );
    });

    it('says so when it could not read the record, never clean', async () => {
      const a = await wallet(100_000 - 55_000);
      await row({ wallet: a, direction: 'in', amountKobo: 100_000 });
      const s = await feeSend(a, 1_000);
      // Fintava answers an unknown id with data: null.
      books.unknownIds.add(s.debitId);
      const r = await report();
      expect(r.verdict).toBe('incomplete');
      expect(r.checks.find((c) => c.id === 'merchant_charges')?.state).toBe(
        'incomplete',
      );
    });
  });

  // -------------------------------------------------------------------------

  describe('the money held for payers and payees (R-19)', () => {
    it('reports held money that is not where it should be', async () => {
      const p = await payment({ priceKobo: 100_000 });
      await hold(p, { status: 'held' });
      const p2 = await payment({ priceKobo: 50_000 });
      await hold(p2, { status: 'held' });
      books.merchant.availableKobo = 149_999;
      const r = await report();
      expect(r.verdict).toBe('differences');
      const f = r.mismatches.find((x) => x.kind === 'held_money_short');
      expect(f).toMatchObject({
        check: 'held_money',
        amountKobo: '150000',
        otherKobo: '149999',
      });
      expect(r.held).toMatchObject({
        openCount: 2,
        openKobo: '150000',
        requiredKobo: '150000',
        merchantAvailableKobo: '149999',
      });
    });

    it("is clean when WAWU's account holds at least what the open holds need", async () => {
      const p = await payment({ priceKobo: 100_000 });
      await hold(p, { status: 'held' });
      // WAWU\'s own 15% and fees sit in the same account: more is right.
      books.merchant.availableKobo = 100_000;
      expect((await report()).verdict).toBe('clean');
      const p2 = await payment({ priceKobo: 40_000 });
      await hold(p2, { status: 'held' });
      books.merchant.availableKobo = 9_999_999;
      expect((await report()).verdict).toBe('clean');
    });

    it('does not count the part of a hold whose move was handed to the provider', async () => {
      const p = await payment({ priceKobo: 100_000 });
      await hold(p, {
        status: 'held',
        action: 'release',
        sentAt: ago(10 * MIN),
        actionAt: ago(20 * MIN),
        transferKobo: 85_000,
        ref: `${PREFIX}rel`,
      });
      books.merchant.availableKobo = 15_000; // the 85,000 has already left
      const r = await report();
      expect(r.held.requiredKobo).toBe('15000');
      expect(refsOf(r, 'held_money_short')).toEqual([]);
    });

    it('reports a hold that is not in the ledger: a held payment with no hold', async () => {
      const p = await payment({ kind: 'event_ticket' });
      const r = await report();
      expect(r.verdict).toBe('differences');
      expect(r.mismatches).toEqual([
        expect.objectContaining({
          check: 'held_money',
          kind: 'hold_missing',
          ref: p.id,
        }),
      ]);
    });

    it('does not ask for a hold for a payment of another kind, or one still pending', async () => {
      await payment({ kind: 'tip' });
      await payment({ kind: 'paid_dm', status: 'pending' });
      expect((await report()).mismatches).toEqual([]);
    });

    it("reports a settled hold whose move left no completed row on WAWU's account", async () => {
      const gone = await payment({ priceKobo: 100_000 });
      await hold(gone, { status: 'released', ref: `${PREFIX}rel-gone` });
      const pending = await payment({ priceKobo: 100_000 });
      const hp = await hold(pending, {
        status: 'refunded',
        ref: `${PREFIX}ref-pending`,
      });
      await row({
        direction: 'out',
        amountKobo: 100_000,
        status: 'pending',
        ref: `${PREFIX}ref-pending`,
      });
      const marked = await payment({ priceKobo: 100_000 });
      await hold(marked, { status: 'released', ref: `${PREFIX}rel-marked` });
      await row({
        direction: 'out',
        amountKobo: 85_000,
        ref: `${PREFIX}rel-marked`,
        discrepancy: 'fee 1 vs 2',
      });
      const fine = await payment({ priceKobo: 100_000 });
      await hold(fine, { status: 'released', ref: `${PREFIX}rel-fine` });
      const ok = await row({
        direction: 'out',
        amountKobo: 85_000,
        ref: `${PREFIX}rel-fine`,
      });
      theirs('merchant', ok.ref, 85_000);
      const r = await report();
      const holdRows = r.mismatches.filter((m) => m.kind === 'hold_move_row');
      expect(holdRows).toHaveLength(3);
      expect(holdRows.map((m) => m.detail).join(' ')).toMatch(/no ledger row/);
      expect(holdRows.map((m) => m.detail).join(' ')).toMatch(/is pending/);
      expect(holdRows.map((m) => m.detail).join(' ')).toMatch(
        /marked as disagreeing/,
      );
      void hp;
    });

    it('leaves a hold that nothing is owed on and a hold of another provider out', async () => {
      const none = await payment({ payee: null, priceKobo: 10_000 });
      await hold(none, { status: 'released', transferKobo: null, ref: null });
      const other = await payment({ provider: 'nuvion' });
      await hold(other, { status: 'held', provider: 'nuvion' });
      books.merchant.availableKobo = 0;
      const r = await report();
      expect(r.mismatches).toEqual([]);
      expect(r.held.openCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------------

  describe('what a person has to look at', () => {
    it('lists a payment in review: silence from the provider never ends a payment (G-480)', async () => {
      const stuck = await payment({
        status: 'pending',
        reviewSince: ago(2 * HOUR),
        ageMs: 80 * HOUR,
      });
      const fresh = await payment({ status: 'pending', ageMs: 2 * HOUR });
      const r = await report();
      expect(r.verdict).toBe('needs_a_look');
      expect(r.mismatches).toEqual([]);
      expect(refsOf(r, 'payment_in_review')).toEqual([stuck.id]);
      expect(all(r).some((f) => f.ref === fresh.id)).toBe(false);
      expect(r.look[0].detail).toMatch(/stays pending until a person decides/);
    });

    it('lists a pending payment past the review bound that is not in review: the sweep is not working', async () => {
      const lost = await payment({ status: 'pending', ageMs: 90 * HOUR });
      const r = await report();
      expect(refsOf(r, 'payment_pending_old')).toEqual([lost.id]);
    });

    it('lists a payment whose charge was not believed, one debited above the quote, and one paid twice', async () => {
      const a = await payment({ chargeReviewSince: ago(HOUR) });
      const b = await payment({ debitReviewSince: ago(HOUR) });
      const c = await payment({
        discrepancy:
          'paid twice for one item: payments x, y were open together',
      });
      const r = await report();
      expect(refsOf(r, 'payment_charge_review')).toEqual([a.id]);
      expect(refsOf(r, 'payment_debit_above_quote')).toEqual([b.id]);
      expect(refsOf(r, 'payment_paid_twice')).toEqual([c.id]);
      expect(r.mismatches.map((m) => m.kind)).not.toContain(
        'payment_in_review',
      );
    });

    it('counts a payment that completed below the quote as a notice, not a look', async () => {
      await payment({
        discrepancy:
          'debit differs from the quote: Fintava took 100000 kobo (fee 0), quoted 102325 kobo (fee 2325)',
      });
      const r = await report();
      expect(r.look).toEqual([]);
      expect(r.notices.payments_differ_from_quote?.count).toBe(1);
    });

    it('lists a hold in review, a move that was never confirmed, and one that has waited too long', async () => {
      const review = await payment();
      const hr = await hold(review, {
        status: 'held',
        reviewSince: ago(HOUR),
        action: 'release',
        actionAt: ago(5 * HOUR),
      });
      const stuck = await payment();
      const hs = await hold(stuck, {
        status: 'held',
        action: 'refund',
        sentAt: ago(100 * HOUR),
        actionAt: ago(101 * HOUR),
        ref: `${PREFIX}ref-stuck`,
      });
      const funds = await payment();
      const hf = await hold(funds, {
        status: 'held',
        action: 'release',
        actionAt: ago(90 * HOUR),
        waiting: 'funds',
      });
      const young = await payment();
      await hold(young, {
        status: 'held',
        action: 'release',
        actionAt: ago(3 * HOUR),
        waiting: 'funds',
      });
      books.merchant.availableKobo = 99_999_999;
      const r = await report();
      expect(r.verdict).toBe('needs_a_look');
      expect(refsOf(r, 'hold_in_review')).toEqual([hr.id]);
      expect(refsOf(r, 'hold_move_stuck')).toEqual([hs.id]);
      expect(refsOf(r, 'hold_waiting_past_limit')).toEqual([hf.id]);
    });

    it('lists money owed to a deleted payee, and only counts one whose payee has not opened a wallet yet (R-11, G-461)', async () => {
      const gone = randomUUID();
      const waiting = await liveCreator();
      const pg = await payment({ payee: gone, priceKobo: 100_000 });
      const hg = await hold(pg, {
        status: 'held',
        action: 'release',
        actionAt: ago(HOUR),
        waiting: 'payee_wallet',
      });
      const pw = await payment({ payee: waiting, priceKobo: 200_000 });
      await hold(pw, {
        status: 'held',
        action: 'release',
        actionAt: ago(200 * HOUR),
        waiting: 'payee_wallet',
      });
      books.merchant.availableKobo = 99_999_999;
      const r = await report();
      expect(refsOf(r, 'hold_payee_deleted')).toEqual([hg.id]);
      expect(r.look.find((f) => f.ref === hg.id)?.amountKobo).toBe('85000');
      expect(r.notices.holds_waiting_for_payee_wallet).toEqual({
        count: 1,
        amountKobo: '170000',
      });
      expect(all(r).some((f) => f.kind === 'hold_waiting_past_limit')).toBe(
        false,
      );
    });

    it("leaves a settled hold and another provider's payment out of the list", async () => {
      const settled = await payment();
      await hold(settled, {
        status: 'refunded',
        reviewSince: ago(HOUR),
        transferKobo: null,
        ref: null,
      });
      await payment({
        status: 'pending',
        reviewSince: ago(HOUR),
        provider: 'nuvion',
        ageMs: 100 * HOUR,
      });
      const r = await report();
      expect(r.look).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------

  describe("the ledger's own stops", () => {
    it('reports a row the ledger marked as disagreeing with the provider', async () => {
      const a = await wallet(100_000);
      await row({ wallet: a, direction: 'in', amountKobo: 100_000 });
      const marked = await send(a, 0 + 1_000, {
        discrepancy: 'amountKobo 1000 vs 1100',
      });
      books.wallets.get(a.walletId)!.availableKobo = 99_000;
      const r = await report();
      expect(r.verdict).toBe('differences');
      expect(r.mismatches).toEqual([
        expect.objectContaining({
          kind: 'ledger_discrepancy',
          ref: marked.id,
          check: 'ledger_rows',
        }),
      ]);
      expect(r.mismatches[0].detail).not.toMatch(/1100/);
    });

    it('lists a row pending past the confirm window and a failed bank send nobody saw come back', async () => {
      const a = await wallet(100_000);
      await row({ wallet: a, direction: 'in', amountKobo: 100_000 });
      const old = await row({
        wallet: a,
        direction: 'out',
        amountKobo: 5_000,
        status: 'pending',
        ageMs: 80 * HOUR,
      });
      theirs(a, old.ref, 5_000, { status: 'PENDING', ageMs: 80 * HOUR });
      const failed = await row({
        wallet: a,
        direction: 'out',
        amountKobo: 7_000,
        status: 'failed',
        bank: true,
        ageMs: 80 * HOUR,
        failureReason: 'Fintava reports this transfer failed.',
      });
      theirs(a, failed.ref, 7_000, { status: 'FAILURE', ageMs: 80 * HOUR });
      // A failed send that Fintava never recorded (the ledger's own reading) is not one to chase.
      await row({
        wallet: a,
        direction: 'out',
        amountKobo: 3_000,
        status: 'failed',
        bank: true,
        ageMs: 80 * HOUR,
        failureReason: LEDGER_ABSENT_FAILURE,
      });
      const r = await report({ windowFrom: ago(200 * HOUR) });
      expect(refsOf(r, 'ledger_pending_old')).toEqual([old.id]);
      expect(refsOf(r, 'failed_send_no_reversal')).toEqual([failed.id]);
      // The pending row and the failed bank send may or may not have left: the balance may sit in the range.
      expect(r.mismatches).toEqual([]);
    });

    it('reports a completed payment whose ledger rows are missing, pending or marked', async () => {
      const a = await wallet(500_000);
      const none = await payment({ payer: a.wawuUserId, rows: false });
      const half = await payment({ payer: a.wawuUserId, rows: false });
      await row({
        direction: 'in',
        amountKobo: 100_000,
        ref: half.customerReference,
      });
      const whole = await payment({ payer: a.wawuUserId, rows: false });
      await row({
        direction: 'in',
        amountKobo: 100_000,
        ref: whole.customerReference,
      });
      await row({
        wallet: a,
        direction: 'out',
        amountKobo: 100_000,
        ref: whole.customerReference,
      });
      const anon = await payment({ payer: null, rows: false });
      await row({
        direction: 'in',
        amountKobo: 100_000,
        ref: anon.customerReference,
      });
      const r = await report();
      const rowsProblems = r.mismatches.filter(
        (m) => m.kind === 'payment_rows',
      );
      expect(rowsProblems.map((m) => m.ref).sort()).toEqual(
        [none.id, half.id].sort(),
      );
      expect(rowsProblems.find((m) => m.ref === none.id)?.detail).toMatch(
        /no row on WAWU's account; no row on the payer's wallet/,
      );
      expect(rowsProblems.find((m) => m.ref === half.id)?.detail).toMatch(
        /no row on the payer's wallet/,
      );
    });
  });

  // -------------------------------------------------------------------------

  describe('a night is made once, by one process, and never half-reported as clean', () => {
    it('is made once: the same night asked again is already done', async () => {
      const n = night();
      const first = await run({ night: n });
      const second = await run({ night: n });
      expect(first.state).toBe('finished');
      expect(second.state).toBe('already_done');
      expect(await prisma.moneyCheckRun.count()).toBe(1);
      expect(mail.mailed).toHaveLength(2);
    });

    it('is made once when three processes ask at the same moment', async () => {
      const a = await wallet(0);
      await row({ wallet: a, direction: 'in', amountKobo: 1_000 });
      books.wallets.get(a.walletId)!.availableKobo = 1_000;
      const n = night();
      const outcomes = await Promise.all([
        run({ night: n }),
        run({ night: n }),
        run({ night: n }),
      ]);
      expect(outcomes.filter((o) => o.state === 'finished')).toHaveLength(1);
      expect(
        outcomes.filter(
          (o) => o.state === 'busy' || o.state === 'already_done',
        ),
      ).toHaveLength(2);
      expect(await prisma.moneyCheckRun.count()).toBe(1);
      expect(mail.mailed).toHaveLength(2);
      expect(
        books.seen.filter((x) => x.startsWith('GET /customer/wallet/balance')),
      ).toHaveLength(1);
    });

    it('leaves a night another process is working on alone', async () => {
      const n = night();
      const id = randomUUID();
      await prisma.moneyCheckRun.create({
        data: {
          id,
          provider: 'fintava',
          night: n,
          status: 'running',
          startedAt: ago(MIN),
          leaseUntil: new Date(Date.now() + 5 * MIN),
        },
      });
      expect(await run({ night: n })).toEqual({ state: 'busy', runId: id });
      const after = await prisma.moneyCheckRun.findUniqueOrThrow({
        where: { id },
      });
      expect(after).toMatchObject({ status: 'running', attempt: 1 });
    });

    it('takes over a run that died, and makes it again', async () => {
      const n = night();
      const id = randomUUID();
      await prisma.moneyCheckRun.create({
        data: {
          id,
          provider: 'fintava',
          night: n,
          status: 'running',
          startedAt: ago(40 * MIN),
          leaseUntil: ago(30 * MIN),
        },
      });
      const outcome = await run({ night: n });
      expect(outcome).toMatchObject({ state: 'finished', runId: id });
      const after = await prisma.moneyCheckRun.findUniqueOrThrow({
        where: { id },
      });
      expect(after).toMatchObject({
        status: 'finished',
        attempt: 2,
        verdict: 'clean',
      });
      expect(await prisma.moneyCheckRun.count()).toBe(1);
    });

    it('does not take a run whose owner extended it a moment after it was read as expired', async () => {
      const n = night();
      const id = randomUUID();
      await prisma.moneyCheckRun.create({
        data: {
          id,
          provider: 'fintava',
          night: n,
          status: 'running',
          startedAt: ago(40 * MIN),
          leaseUntil: ago(MIN),
        },
      });
      const real = prisma.moneyCheckRun.findUnique.bind(prisma.moneyCheckRun);
      let slowOwner = true;
      jest.spyOn(prisma.moneyCheckRun, 'findUnique').mockImplementation(((
        args: never,
      ) => {
        const read = real(args);
        if (!slowOwner) return read;
        slowOwner = false;
        // The owner was only slow: it keeps its lease right after this read.
        return read.then(async (row: unknown) => {
          await prisma.moneyCheckRun.update({
            where: { id },
            data: { leaseUntil: new Date(Date.now() + 10 * MIN) },
          });
          return row;
        });
      }) as never);
      expect(await run({ night: n })).toEqual({ state: 'busy', runId: id });
      const after = await prisma.moneyCheckRun.findUniqueOrThrow({
        where: { id },
      });
      expect(after).toMatchObject({ status: 'running', attempt: 1 });
      expect(mail.mailed).toHaveLength(0);
    });

    it('drops a run another process took while it worked, and says nothing', async () => {
      const a = await wallet(0);
      books.wallets.get(a.walletId)!.availableKobo = 0;
      const n = night();
      const real = provider.getBalance.bind(provider);
      jest.spyOn(provider, 'getBalance').mockImplementation(async (w) => {
        // Another process takes the run (its lease had run out) and starts try two.
        await prisma.moneyCheckRun.updateMany({
          where: { night: n },
          data: { attempt: { increment: 1 } },
        });
        return real(w);
      });
      const outcome = await run({ night: n });
      expect(outcome.state).toBe('busy');
      const after = await prisma.moneyCheckRun.findFirstOrThrow({
        where: { night: n },
      });
      expect(after).toMatchObject({
        status: 'running',
        attempt: 2,
        verdict: null,
      });
      expect(mail.mailed).toHaveLength(0);
    });

    it('retries a night that fails, after its rest, and reports it as not finished after three tries', async () => {
      scope.failWalletQuery = true;
      const n = night();
      const first = await run({ night: n });
      expect(first).toMatchObject({ state: 'failed' });
      let r = await prisma.moneyCheckRun.findFirstOrThrow({
        where: { night: n },
      });
      expect(r).toMatchObject({ status: 'failed', attempt: 1, verdict: null });
      expect(r.failure).toContain('planted failure');
      // It rests before the next try.
      expect((await run({ night: n })).state).toBe('busy');
      expect(r.leaseUntil.getTime()).toBeGreaterThan(Date.now() + 10 * MIN);

      for (const attempt of [2, 3]) {
        await prisma.moneyCheckRun.update({
          where: { id: r.id },
          data: { leaseUntil: ago(MIN) },
        });
        const o = await run({ night: n });
        r = await prisma.moneyCheckRun.findFirstOrThrow({
          where: { night: n },
        });
        if (attempt === 2) {
          expect(o.state).toBe('failed');
          expect(r).toMatchObject({ status: 'failed', attempt: 2 });
        } else {
          expect(o).toMatchObject({ state: 'given_up', verdict: 'incomplete' });
        }
      }
      expect(r).toMatchObject({
        status: 'finished',
        verdict: 'incomplete',
        attempt: 3,
      });
      expect(r.failure).toContain('planted failure');
      const stored = r.report as unknown as MoneyCheckReport;
      expect(stored.verdict).toBe('incomplete');
      expect(stored.checks.every((c) => c.state === 'incomplete')).toBe(true);
      // Told, not silent: the owners are told the night could not be made.
      expect(mail.mailed).toHaveLength(2);
      expect(mail.mailed[0].body).toMatchObject({ verdict: 'incomplete' });
      // And it is over: no more tries for this night.
      expect((await run({ night: n })).state).toBe('already_done');
    });

    it('makes a night that died on its last try incomplete, not clean', async () => {
      const n = night();
      const id = randomUUID();
      await prisma.moneyCheckRun.create({
        data: {
          id,
          provider: 'fintava',
          night: n,
          status: 'running',
          attempt: 3,
          startedAt: ago(40 * MIN),
          leaseUntil: ago(30 * MIN),
        },
      });
      expect(await run({ night: n })).toMatchObject({
        state: 'given_up',
        verdict: 'incomplete',
      });
      expect(
        (await prisma.moneyCheckRun.findUniqueOrThrow({ where: { id } }))
          .verdict,
      ).toBe('incomplete');
      expect(mail.mailed[0].body).toMatchObject({ verdict: 'incomplete' });
    });

    it('lets a person make it by hand whatever the tries, and again for a night that finished', async () => {
      const n = night();
      const id = randomUUID();
      await prisma.moneyCheckRun.create({
        data: {
          id,
          provider: 'fintava',
          night: n,
          status: 'failed',
          attempt: 3,
          startedAt: ago(40 * MIN),
          leaseUntil: ago(30 * MIN),
        },
      });
      const o = await run({ night: n, byHand: true });
      expect(o).toMatchObject({ state: 'finished', runId: id });
      expect(
        (await prisma.moneyCheckRun.findUniqueOrThrow({ where: { id } }))
          .attempt,
      ).toBe(4);
      expect((await run({ night: n, byHand: true })).state).toBe(
        'already_done',
      );
      const again = await run({ night: n, byHand: true, again: true });
      expect(again.state).toBe('finished');
      expect(
        (
          await prisma.moneyCheckRun.findMany({
            where: { night: n },
            orderBy: { sequence: 'asc' },
          })
        ).map((x) => [x.sequence, x.status, x.byHand]),
      ).toEqual([
        [1, 'finished', true],
        [2, 'finished', true],
      ]);
    });

    it('keeps a run finished when handing its report on fails', async () => {
      jest
        .spyOn(service, 'deliver')
        .mockRejectedValue(new Error('database gone'));
      const outcome = await run();
      expect(outcome.state).toBe('finished');
      if (outcome.state !== 'finished') return;
      const stored = await prisma.moneyCheckRun.findUniqueOrThrow({
        where: { id: outcome.runId },
      });
      expect(stored).toMatchObject({
        status: 'finished',
        verdict: 'clean',
        emailedAt: null,
      });
      expect(logger.lines.join('\n')).toMatch(/was not handed on/);
      jest.restoreAllMocks();
      // The minute tick hands it on.
      await service.sendDue(new Date(Date.now() + MIN));
      expect(mail.mailed).toHaveLength(2);
    });

    it('refuses a night that is not a date', async () => {
      await expect(service.runNight({ night: '2026-13-45' })).rejects.toThrow(
        RangeError,
      );
      await expect(service.runNight({ night: 'tonight' })).rejects.toThrow(
        /date/,
      );
    });
  });

  // -------------------------------------------------------------------------

  describe('what the provider cannot answer is not checked, never clean', () => {
    const notSupported = (operation: string) =>
      new WalletProviderError({
        kind: 'not_supported',
        provider: 'nuvion',
        operation,
      });

    it('says "not checked" for a provider that cannot list debits, and checks what it can', async () => {
      const a = await wallet(1_000);
      const b = await wallet(2_000);
      await row({ wallet: a, direction: 'in', amountKobo: 1_000 });
      await row({ wallet: b, direction: 'in', amountKobo: 2_000 });
      const list = jest
        .spyOn(provider, 'listTransactions')
        .mockRejectedValue(notSupported('list transactions'));
      const r = await report();
      expect(r.verdict).toBe('incomplete');
      expect(r.wallets).toEqual({
        total: 2,
        checked: 0,
        notChecked: { not_supported: 2 },
      });
      const state = (id: string) => r.checks.find((c) => c.id === id)!;
      expect(state('movements')).toMatchObject({ state: 'not_checked' });
      expect(state('movements').note).toMatch(
        /cannot list a wallet's debits yet/,
      );
      expect(state('merchant_movements').state).toBe('not_checked');
      expect(state('balances').state).toBe('ok');
      // One refusal teaches the run: it does not ask every wallet.
      expect(list).toHaveBeenCalledTimes(2);
    });

    it('is not_checked when nothing can be compared with the provider', async () => {
      await wallet(1_000);
      jest
        .spyOn(provider, 'listTransactions')
        .mockRejectedValue(notSupported('list transactions'));
      jest
        .spyOn(provider, 'getBalance')
        .mockRejectedValue(notSupported('get balance'));
      jest
        .spyOn(provider, 'getPlatformAccount')
        .mockRejectedValue(notSupported('get platform account'));
      const r = await report();
      expect(r.verdict).toBe('not_checked');
      expect(
        r.checks
          .filter((c) => c.state === 'not_checked')
          .map((c) => c.id)
          .sort(),
      ).toEqual(['balances', 'held_money', 'merchant_movements', 'movements']);
      expect(r.wallets.checked).toBe(0);
    });

    it('asks the provider nothing when it is not set up on this server, and still lists what a person must look at', async () => {
      await wallet(1_000);
      await wallet(2_000);
      jest.spyOn(provider, 'configured', 'get').mockReturnValue(false);
      const stuck = await payment({
        status: 'pending',
        reviewSince: ago(HOUR),
        ageMs: 80 * HOUR,
      });
      const r = await report();
      expect(r.verdict).toBe('not_checked');
      expect(books.seen).toEqual([]);
      expect(r.wallets).toEqual({
        total: 2,
        checked: 0,
        notChecked: { not_set_up: 2 },
      });
      expect(refsOf(r, 'payment_in_review')).toEqual([stuck.id]);
      expect(r.checks.find((c) => c.id === 'balances')?.note).toMatch(
        /is not set up on this server/,
      );
    });

    it('leaves a wallet it cannot read out of "checked" and checks the others', async () => {
      const a = await wallet(100_000);
      await wallet(5);
      await row({ wallet: a, direction: 'in', amountKobo: 50_000 }); // the ledger says 50,000, Fintava 100,000
      // Fintava does not know the second wallet at all.
      for (const [id, w] of [...books.wallets]) {
        if (w.availableKobo === 5) books.wallets.delete(id);
      }
      const r = await report();
      expect(r.verdict).toBe('differences');
      expect(r.wallets).toEqual({
        total: 2,
        checked: 1,
        notChecked: { unreadable: 1 },
      });
      expect(refsOf(r, 'balance_differs')).toEqual([a.walletId]);
      expect(r.checks.find((c) => c.id === 'balances')?.note).toMatch(
        /1 wallets could not be read/,
      );
    });

    it('is incomplete, not clean, when a wallet cannot be read and nothing else differs', async () => {
      await wallet(0);
      books.wallets.clear();
      const r = await report();
      expect(r.verdict).toBe('incomplete');
      expect(r.wallets.checked).toBe(0);
    });

    it('asks again when the provider fails once', async () => {
      const a = await wallet(0);
      books.fail.set('/customer/wallet/balance', 503);
      const r = await report();
      expect(r.verdict).toBe('clean');
      expect(r.wallets.checked).toBe(1);
      expect(
        books.seen.filter((x) => x.startsWith('GET /customer/wallet/balance')),
      ).toHaveLength(2);
      void a;
    });

    it('stops reading when the key is refused and says how far it got', async () => {
      await wallet(1);
      await wallet(2);
      await wallet(3);
      const auth = new WalletProviderError({
        kind: 'auth',
        provider: 'fintava',
        operation: 'wallet balance',
      });
      jest.spyOn(provider, 'getBalance').mockRejectedValue(auth);
      const r = await report();
      expect(r.verdict).toBe('incomplete');
      expect(r.wallets.total).toBe(3);
      expect(r.wallets.checked).toBe(0);
      expect(r.wallets.notChecked.unreadable).toBeGreaterThanOrEqual(1);
      expect(r.wallets.notChecked.not_reached).toBeGreaterThanOrEqual(1);
      expect(
        (r.wallets.notChecked.unreadable ?? 0) +
          (r.wallets.notChecked.not_reached ?? 0),
      ).toBe(3);
    });

    it('does not compare a wallet whose ledger kept moving while it was read', async () => {
      const a = await wallet(999_999);
      const m = await row({ wallet: a, direction: 'in', amountKobo: 1_000 });
      const real = provider.getBalance.bind(provider);
      jest.spyOn(provider, 'getBalance').mockImplementation(async (w) => {
        await prisma.fintavaLedgerEntry.update({
          where: { id: m.id },
          data: { note: String(Math.random()) },
        });
        return real(w);
      });
      const r = await report();
      expect(r.mismatches).toEqual([]);
      expect(r.verdict).toBe('incomplete');
      expect(r.wallets.notChecked).toEqual({ moving: 1 });
    });

    it('confirms a difference before it reports it, and does not report a blip', async () => {
      const a = await wallet(1_000);
      await row({ wallet: a, direction: 'in', amountKobo: 1_000 });
      const real = provider.getBalance.bind(provider);
      let calls = 0;
      jest.spyOn(provider, 'getBalance').mockImplementation(async (w) => {
        calls += 1;
        const b = await real(w);
        // The first read is wrong; the next ones are right.
        return calls === 1 ? { ...b, availableKobo: 1n, bookedKobo: 1n } : b;
      });
      const r = await report();
      expect(r.verdict).toBe('clean');
      expect(calls).toBe(2);
    });

    it('says a history longer than the pages it reads is incomplete, and does not call a send missing for it', async () => {
      const a = await wallet(0);
      await row({ wallet: a, direction: 'in', amountKobo: 1_000_000 });
      for (let i = 0; i < 120; i += 1)
        await send(a, 100, { ageMs: (11 + i / 100) * HOUR });
      await row({
        wallet: a,
        direction: 'out',
        amountKobo: 777,
        ageMs: 30 * HOUR,
      });
      books.wallets.get(a.walletId)!.availableKobo = 1_000_000 - 12_000 - 777;
      const was = cfg.historyPages;
      (cfg as { historyPages: number }).historyPages = 1;
      try {
        const r = await report({ windowFrom: ago(48 * HOUR) });
        expect(r.wallets.notChecked).toEqual({ history_incomplete: 1 });
        expect(r.verdict).toBe('incomplete');
        expect(r.mismatches.filter((m) => m.kind === 'ledger_only')).toEqual(
          [],
        );
        expect(r.checks.find((c) => c.id === 'movements')?.note).toMatch(
          /longer than the pages read/,
        );
      } finally {
        (cfg as { historyPages: number }).historyPages = was;
      }
    });

    it('stops at its time limit and says which wallets it did not reach', async () => {
      await wallet(0);
      await wallet(0);
      const was = cfg.maxRunMs;
      (cfg as { maxRunMs: number }).maxRunMs = -1_000;
      try {
        const r = await report();
        expect(r.verdict).toBe('incomplete');
        expect(r.wallets).toEqual({
          total: 2,
          checked: 0,
          notChecked: { not_reached: 2 },
        });
      } finally {
        (cfg as { maxRunMs: number }).maxRunMs = was;
      }
    });

    it('acts only on the rows of the provider this server runs', async () => {
      const mine = await wallet(1_000);
      await row({ wallet: mine, direction: 'in', amountKobo: 1_000 });
      const other = await wallet(123, { provider: 'nuvion' });
      await row({
        wallet: other,
        direction: 'in',
        amountKobo: 999_999,
        provider: 'nuvion',
      });
      await row({
        wallet: other,
        direction: 'out',
        amountKobo: 5,
        provider: 'nuvion',
        discrepancy: 'x',
      });
      // A row written before the provider column existed is Fintava's.
      const legacy = await wallet(2_000);
      await row({
        wallet: legacy,
        direction: 'in',
        amountKobo: 2_000,
        provider: null,
      });
      const r = await report();
      expect(r.verdict).toBe('clean');
      expect(r.wallets).toEqual({ total: 2, checked: 2, notChecked: {} });
      expect(books.seen.some((x) => x.includes(other.walletId))).toBe(false);
    });
  });

  // -------------------------------------------------------------------------

  describe('the window', () => {
    it('reads back to the look-back limit on the first run, and back past the last finished run after', async () => {
      const first = await service.runNight({ night: night() });
      expect(first.state).toBe('finished');
      if (first.state !== 'finished') return;
      const startedAt = Date.parse(first.report.startedAt);
      expect(Date.parse(first.report.windowFrom!)).toBe(
        startedAt - 35 * 24 * HOUR,
      );
      const second = await service.runNight({ night: night() });
      if (second.state !== 'finished') throw new Error('not finished');
      expect(Date.parse(second.report.windowFrom!)).toBe(
        Date.parse(first.report.windowTo) - 96 * HOUR,
      );
    });

    it('does not move past a run that could not read everything', async () => {
      const a = await wallet(0);
      books.wallets.delete(a.walletId);
      const first = await service.runNight({ night: night() });
      if (first.state !== 'finished') throw new Error('not finished');
      expect(first.verdict).toBe('incomplete');
      books.addWallet({
        customerId: a.customerId,
        walletId: a.walletId,
        accountNumber: a.accountNumber,
        availableKobo: 0,
      });
      const second = await service.runNight({ night: night() });
      if (second.state !== 'finished') throw new Error('not finished');
      expect(Date.parse(second.report.windowFrom!)).toBe(
        Date.parse(second.report.startedAt) - 35 * 24 * HOUR,
      );
    });
  });

  // -------------------------------------------------------------------------

  describe('telling the owners', () => {
    it('hands each owner the facts through WAWU ID: counts, references and kobo, nothing that names a person', async () => {
      const a = await wallet(1_000_000);
      await row({ wallet: a, direction: 'in', amountKobo: 100_000 });
      theirs(a, `${PREFIX}only-theirs`, 4_000);
      const p = await payment({
        status: 'pending',
        reviewSince: ago(HOUR),
        ageMs: 80 * HOUR,
      });
      const r = await report();
      expect(r.verdict).toBe('differences');
      const body = mail.mailed[0].body;
      expect(body).toMatchObject({
        provider: 'fintava',
        verdict: 'differences',
        walletsTotal: 1,
        walletsChecked: 1,
      });
      expect(body.mismatchCount).toBeGreaterThanOrEqual(2);
      expect(body.lookCount).toBe(1);
      const text = JSON.stringify(body);
      expect(text).toContain(`${PREFIX}only-theirs`);
      expect(text).toContain(p.id);
      for (const w of [
        a.accountNumber,
        books.merchant.accountNumber,
        books.merchant.accountName,
      ]) {
        expect(text).not.toContain(w);
      }
      expect(text).not.toMatch(/\+234|\b0[789]\d{9}\b/);
      expect(text).not.toContain(String.fromCharCode(0x2014));
      expect(mail.mailed.map((x) => JSON.stringify(x.body))).toEqual([
        text,
        text,
      ]);
    });

    it('tries again for an owner WAWU ID would not take, and never mails the first twice', async () => {
      mail.refuse.set('owner-two', 404);
      const first = await run();
      if (first.state !== 'finished') throw new Error('not finished');
      let r = await prisma.moneyCheckRun.findUniqueOrThrow({
        where: { id: first.runId },
      });
      expect(r.emailedTo).toEqual(['owner-one']);
      expect(r.emailedAt).toBeNull();
      expect(r.emailAttempts).toBe(1);
      expect(r.nextEmailAt!.getTime()).toBeGreaterThan(Date.now() + 5 * MIN);
      expect(mail.mailed.map((x) => x.userId)).toEqual(['owner-one']);

      // Not yet due.
      await service.sendDue(new Date(Date.now() + MIN));
      expect(mail.mailed).toHaveLength(1);

      mail.refuse.clear();
      await service.sendDue(new Date(Date.now() + 15 * MIN));
      expect(mail.mailed.map((x) => x.userId)).toEqual([
        'owner-one',
        'owner-two',
      ]);
      r = await prisma.moneyCheckRun.findUniqueOrThrow({
        where: { id: first.runId },
      });
      expect(r.emailedAt).not.toBeNull();
      expect(r.emailedTo.sort()).toEqual(['owner-one', 'owner-two']);
      // Done: nothing more is sent.
      await service.sendDue(new Date(Date.now() + 24 * HOUR));
      expect(mail.mailed).toHaveLength(2);
    });

    it('keeps the report when WAWU ID has no such route yet, and tries again until it has', async () => {
      mail.refuseAll = 404;
      const o = await run();
      if (o.state !== 'finished') throw new Error('not finished');
      const r = await prisma.moneyCheckRun.findUniqueOrThrow({
        where: { id: o.runId },
      });
      expect(r).toMatchObject({
        status: 'finished',
        verdict: 'clean',
        emailedAt: null,
        emailAttempts: 1,
      });
      expect(r.report).not.toBeNull();
      expect(r.nextEmailAt).not.toBeNull();
      expect(logger.lines.join('\n')).toMatch(
        /was not taken for one recipient/,
      );
      mail.refuseAll = null;
      await service.sendDue(new Date(Date.now() + 15 * MIN));
      expect(mail.mailed).toHaveLength(2);
    });

    it('makes the run and logs it when nobody is named to be told', async () => {
      const was = cfg.recipients;
      (cfg as { recipients: readonly string[] }).recipients = [];
      try {
        const a = await wallet(0);
        theirs(a, `${PREFIX}x`, 1_000);
        const o = await run();
        expect(o.state).toBe('finished');
        expect(mail.mailed).toHaveLength(0);
        expect(logger.lines.join('\n')).toMatch(/no recipient is set/);
        expect(logger.lines.join('\n')).toMatch(/money check .* differences/);
      } finally {
        (cfg as { recipients: readonly string[] }).recipients = was;
      }
    });

    it('mails a report once even when two processes hand it on together', async () => {
      const o = await run();
      if (o.state !== 'finished') throw new Error('not finished');
      await prisma.moneyCheckRun.update({
        where: { id: o.runId },
        data: { emailedAt: null, emailedTo: [], nextEmailAt: null },
      });
      mail.mailed.length = 0;
      await Promise.all([service.deliver(o.runId), service.deliver(o.runId)]);
      expect(mail.mailed.map((x) => x.userId).sort()).toEqual([
        'owner-one',
        'owner-two',
      ]);
    });
  });

  // -------------------------------------------------------------------------

  describe('the schedule', () => {
    const at = (iso: string) => new Date(iso);

    it('is due from its hour in Lagos until the catch-up ends, and not before or after', () => {
      const was = cfg.minuteOfDay;
      (cfg as { minuteOfDay: number | null }).minuteOfDay = 150; // 02:30
      try {
        expect(service.dueNight(at('2026-10-12T01:29:00Z'))).toBeNull();
        expect(service.dueNight(at('2026-10-12T01:30:00Z'))).toBe('2026-10-12');
        expect(service.dueNight(at('2026-10-12T07:29:00Z'))).toBe('2026-10-12');
        expect(service.dueNight(at('2026-10-12T07:31:00Z'))).toBeNull();
        expect(service.dueNight(at('2026-10-12T22:00:00Z'))).toBeNull();
        (cfg as { minuteOfDay: number | null }).minuteOfDay = null;
        expect(service.dueNight(at('2026-10-12T02:00:00Z'))).toBeNull();
      } finally {
        (cfg as { minuteOfDay: number | null }).minuteOfDay = was;
      }
    });

    it("makes tonight's run once when its time comes, and not again that night", async () => {
      const a = await wallet(0);
      const was = cfg.minuteOfDay;
      const now = new Date();
      const lagosMinute = (d: Date) => {
        const p = new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Africa/Lagos',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        }).format(d);
        const [h, m] = p.split(':').map(Number);
        return h * 60 + m;
      };
      (cfg as { minuteOfDay: number | null }).minuteOfDay = Math.max(
        0,
        lagosMinute(now) - 5,
      );
      try {
        await service.tick(now);
        const rows = await prisma.moneyCheckRun.findMany({});
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          status: 'finished',
          verdict: 'clean',
          walletsChecked: 1,
        });
        expect(mail.mailed).toHaveLength(2);
        await service.tick(new Date(now.getTime() + MIN));
        expect(await prisma.moneyCheckRun.count()).toBe(1);
        expect(mail.mailed).toHaveLength(2);
        (cfg as { minuteOfDay: number | null }).minuteOfDay = 24 * 60 - 1;
        // Before its hour: nothing new.
        await prisma.moneyCheckRun.deleteMany({});
        await service.tick(new Date(Date.UTC(2026, 9, 12, 0, 0, 0)));
        expect(await prisma.moneyCheckRun.count()).toBe(0);
      } finally {
        (cfg as { minuteOfDay: number | null }).minuteOfDay = was;
      }
      void a;
    });
  });

  // -------------------------------------------------------------------------

  describe('what the database refuses, whatever the code does', () => {
    const base = (over: Record<string, unknown>) => ({
      id: randomUUID(),
      provider: 'fintava',
      night: night(),
      startedAt: new Date(),
      leaseUntil: new Date(),
      ...over,
    });

    it('refuses a status or a verdict it does not know, and a night that is not a date', async () => {
      await expect(
        prisma.moneyCheckRun.create({ data: base({ status: 'done' }) }),
      ).rejects.toThrow();
      await expect(
        prisma.moneyCheckRun.create({
          data: base({
            status: 'finished',
            verdict: 'fine',
            report: {},
            finishedAt: new Date(),
          }),
        }),
      ).rejects.toThrow();
      await expect(
        prisma.moneyCheckRun.create({ data: base({ night: 'tonight' }) }),
      ).rejects.toThrow();
    });

    it('refuses a finished run without its time, verdict or report, and an unfinished run with a verdict', async () => {
      const finished = {
        status: 'finished',
        verdict: 'clean',
        report: {},
        finishedAt: new Date(),
      };
      for (const missing of ['verdict', 'report', 'finishedAt']) {
        const data = { ...finished, [missing]: undefined };
        await expect(
          prisma.moneyCheckRun.create({ data: base(data) }),
        ).rejects.toThrow();
      }
      await expect(
        prisma.moneyCheckRun.create({
          data: base({ status: 'running', verdict: 'clean' }),
        }),
      ).rejects.toThrow();
      await expect(
        prisma.moneyCheckRun.create({ data: base(finished) }),
      ).resolves.toMatchObject({ status: 'finished' });
    });

    it('refuses a second row for one provider, night and sequence', async () => {
      const n = night();
      await prisma.moneyCheckRun.create({ data: base({ night: n }) });
      await expect(
        prisma.moneyCheckRun.create({ data: base({ night: n }) }),
      ).rejects.toThrow();
      await expect(
        prisma.moneyCheckRun.create({ data: base({ night: n, sequence: 2 }) }),
      ).resolves.toBeDefined();
      await expect(
        prisma.moneyCheckRun.create({
          data: base({ night: n, provider: 'nuvion' }),
        }),
      ).resolves.toBeDefined();
    });
  });

  // -------------------------------------------------------------------------

  describe('by hand (npm run money:check)', () => {
    it('reads --night and --again, and refuses anything else', () => {
      expect(parseArgs([])).toEqual({ again: false });
      expect(parseArgs(['--night=2026-10-12', '--again'])).toEqual({
        night: '2026-10-12',
        again: true,
      });
      expect(() => parseArgs(['--force'])).toThrow(/Unknown argument --force/);
    });

    it('summarises a run in one line of counts, with no finding in it', async () => {
      const a = await wallet(0);
      theirs(a, `${PREFIX}by-hand`, 1_000);
      const outcome = await service.runNight({
        night: night(),
        byHand: true,
        windowFrom: ago(48 * HOUR),
      });
      const summary = summaryOf(outcome);
      expect(summary).toMatchObject({
        state: 'finished',
        verdict: 'differences',
        walletsChecked: 1,
        walletsTotal: 1,
        mismatches: 1,
        look: 0,
      });
      expect(JSON.stringify(summary)).not.toContain(`${PREFIX}by-hand`);
      expect(summaryOf({ state: 'busy', runId: 'x' })).toEqual({
        state: 'busy',
        runId: 'x',
      });
    });
  });
});
