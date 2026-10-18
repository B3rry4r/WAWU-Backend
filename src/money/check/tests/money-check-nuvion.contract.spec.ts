import { randomUUID } from 'node:crypto';
import { type LoggerService } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Prisma } from '../../../../generated/prisma/client';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { statementTransaction } from '../../../nuvion/areas/reconcile';
import {
  WALLET_PROVIDER,
  type ProviderPage,
  type ProviderTransaction,
  type WalletProvider,
} from '../../../wallet-provider/wallet-provider.interface';
import { chargeDifferenceNote } from '../../ledger/ledger-notes';
import { PaymentSettings } from '../../payments/payment-config';
import { MoneyCheckMailer } from '../money-check-mailer';
import { MoneyCheckSettings } from '../money-check-config';
import { MoneyCheckScope } from '../money-check-scope';
import { MoneyCheckService } from '../money-check.service';
import type { Finding, MoneyCheckReport } from '../money-check-types';

/**
 * FIX-67 round 2: the nightly check on Nuvion, end to end on a real database.
 * The provider is a small books that lists a holder's lines the way Nuvion's
 * statement does (a direction on each line, the running balance, WAWU's fee as
 * a transfer of its own), each line made by the adapter's own reader
 * (`statementTransaction`), so a credit is a credit and a fee leg is marked as
 * the real adapter marks it. A night built from moves both sides agree on is
 * clean (credits, the fee legs, the opening balance of WAWU's account all
 * included); each other test plants ONE difference on one side and names the
 * finding it must make.
 *
 * Nothing here reaches any provider, Nuvion or otherwise, or any host.
 */

const RUN = `f67r2${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PREFIX = `f67r2-${RUN}-`;
const HOUR = 3_600_000;
/** Nights this run makes are in a year of its own, and it deletes only those. */
const NIGHT_YEAR = 2200 + Math.floor(Math.random() * 7000);
const OPENING = 100_000_000n;
const MERCHANT_ACCOUNT = `7${Math.floor(Math.random() * 900_000_000 + 100_000_000)}`;

jest.setTimeout(120_000);

class QuietLogger implements LoggerService {
  log() {}
  error() {}
  warn() {}
  debug() {}
  verbose() {}
  fatal() {}
}

class SpecScope extends MoneyCheckScope {
  users: string[] = [];
  walletWhere(): Prisma.FintavaWalletWhereInput {
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

/** What a Nuvion statement holds for one account, oldest first. */
interface Line {
  at: number;
  direction: 'in' | 'out';
  amount: number;
  fee: number;
  reference: string;
  status?: string;
}

/** The provider's side: accounts with an opening balance and their lines. */
class Books {
  readonly accounts = new Map<string, { opening: number; lines: Line[] }>();
  /** False: the statement's lines carry no running balance. */
  statesBalance = true;
  open(key: string, opening = 0): void {
    this.accounts.set(key, { opening, lines: [] });
  }
  add(key: string, line: Line): void {
    this.accounts.get(key)!.lines.push(line);
  }
  drop(key: string, reference: string): void {
    const a = this.accounts.get(key)!;
    a.lines = a.lines.filter((l) => l.reference !== reference);
  }
  balance(key: string): number {
    const a = this.accounts.get(key)!;
    return a.lines
      .filter((l) => (l.status ?? 'completed') === 'completed')
      .reduce(
        (n, l) => n + (l.direction === 'in' ? l.amount : -(l.amount + l.fee)),
        a.opening,
      );
  }
  /** Newest first, as the adapter's walk gives them. */
  statement(key: string): ProviderTransaction[] {
    const a = this.accounts.get(key)!;
    const sorted = [...a.lines].sort((x, y) => x.at - y.at);
    let running = a.opening;
    const out: ProviderTransaction[] = [];
    sorted.forEach((l, i) => {
      const done = (l.status ?? 'completed') === 'completed';
      if (done)
        running += l.direction === 'in' ? l.amount : -(l.amount + l.fee);
      out.push(
        statementTransaction({
          transferId:
            `01TEST${String(i).padStart(10, '0')}${key.slice(-8).replace(/\W/g, 'X')}`
              .slice(0, 26)
              .padEnd(26, 'X'),
          direction: l.direction,
          amountKobo: l.amount,
          feeKobo: l.fee,
          balanceAfterKobo: this.statesBalance ? running : null,
          status: l.status ?? 'completed',
          outcome:
            (l.status ?? 'completed') === 'completed' ? 'completed' : 'pending',
          currency: 'NGN',
          reference: l.reference,
          createdAt: new Date(l.at),
        }),
      );
    });
    return out.reverse();
  }
}

describe('FIX-67: the nightly check on Nuvion, credits and fee legs and WAWU account included', () => {
  const books = new Books();
  const scope = new SpecScope();
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let service: MoneyCheckService;
  let cfg: MoneyCheckSettings;
  let seq = 0;
  let nightNo = 0;
  let clock = 0;
  const walletOf = new Map<string, string>();
  const usedAccounts = new Set<string>();

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
  const nightsMade = new Set<string>();
  const night = (): string => {
    nightNo += 1;
    const made = `${NIGHT_YEAR + Math.floor(nightNo / 336)}-${String(1 + (Math.floor(nightNo / 28) % 12)).padStart(2, '0')}-${String(1 + (nightNo % 28)).padStart(2, '0')}`;
    nightsMade.add(made);
    return made;
  };
  const ref = (): string => `${PREFIX}${(seq += 1)}`;
  /** Each move is one second after the last, ten hours ago: oldest first, all settled. */
  const tick = (): number => (clock += 1_000);

  /** The provider double the service reads: the real shape of the seam's reads. */
  const provider = {
    name: 'nuvion',
    label: 'Nuvion',
    configured: true,
    wawuFeeLeg: true,
    getBalance: ({ walletId }: { walletId: string }) => {
      const key = walletOf.get(walletId)!;
      const b = BigInt(books.balance(key));
      return Promise.resolve({ availableKobo: b, bookedKobo: b });
    },
    getPlatformAccount: () => {
      const b = BigInt(books.balance('merchant'));
      return Promise.resolve({
        accountNumber: MERCHANT_ACCOUNT,
        accountName: 'WAWU',
        availableKobo: b,
        bookedKobo: b,
      });
    },
    listTransactions: (
      holder: { kind: string; customerId?: string },
      opts?: { page?: number; take?: number },
    ): Promise<ProviderPage<ProviderTransaction>> => {
      const all = books.statement(
        holder.kind === 'merchant' ? 'merchant' : holder.customerId!,
      );
      // Pages of `take` lines, newest first, as the adapter's walk gives them.
      const take = opts?.take ?? all.length;
      const page = opts?.page ?? 1;
      return Promise.resolve({
        items: all.slice((page - 1) * take, page * take),
        hasNextPage: page * take < all.length,
      });
    },
    findTransactionById: () => Promise.resolve({ state: 'unknown' as const }),
  } as unknown as WalletProvider;

  async function wallet(): Promise<Wallet> {
    const w: Wallet = {
      wawuUserId: randomUUID(),
      customerId: randomUUID(),
      walletId: randomUUID(),
      accountNumber: acct(),
    };
    await prisma.fintavaWallet.create({ data: { ...w, provider: 'nuvion' } });
    scope.users.push(w.wawuUserId);
    books.open(w.customerId, 0);
    walletOf.set(w.walletId, w.customerId);
    return w;
  }

  interface Side {
    /** A wallet, or null for WAWU's own account. */
    who: Wallet | null;
    direction: 'in' | 'out';
    amount: number;
    /** The provider's charge on the line (a debit's). */
    fee?: number;
    /** WAWU's fee as the ledger row records it. */
    wawuFee?: number;
    /** What the ledger row holds as the provider's charge. */
    providerFee?: number;
    reference: string;
    at: number;
    status?: 'completed' | 'pending' | 'failed' | 'reversed';
    bank?: boolean;
    discrepancy?: string;
    /** Leave one side unwritten, to plant a difference. */
    ledger?: boolean;
    line?: boolean;
    /**
     * The date the ledger row carries, when it is not the provider's line's:
     * a row recorded long after the move, say. The row is then also left
     * untouched since that date.
     */
    ledgerAt?: number;
  }

  /** One side of a move: its ledger row and the provider's line. */
  async function side(s: Side): Promise<string> {
    const id = randomUUID();
    const key = s.who ? s.who.customerId : 'merchant';
    const account = s.who ? s.who.accountNumber : MERCHANT_ACCOUNT;
    const fee = s.fee ?? 0;
    const wawu = s.wawuFee ?? 0;
    if (s.ledger !== false) {
      await prisma.fintavaLedgerEntry.create({
        data: {
          id,
          walletKind: s.who ? 'user' : 'merchant',
          wawuUserId: s.who?.wawuUserId ?? null,
          accountNumber: account,
          direction: s.direction,
          status: s.status ?? 'completed',
          category: 'transfer',
          amountKobo: BigInt(s.amount),
          feeKobo: BigInt(s.direction === 'out' ? fee + wawu : 0),
          providerFeeKobo:
            s.providerFee === undefined ? null : BigInt(s.providerFee),
          wawuFeeKobo: s.direction === 'out' ? BigInt(wawu) : null,
          totalKobo: BigInt(
            s.amount + (s.direction === 'out' ? fee + wawu : 0),
          ),
          counterpartyKind: s.bank ? 'bank_account' : null,
          customerReference: s.reference,
          discrepancy: s.discrepancy ?? null,
          source: 'send',
          occurredAt: new Date(s.ledgerAt ?? s.at),
          createdAt: new Date(s.ledgerAt ?? s.at),
          ...(s.ledgerAt === undefined
            ? {}
            : { updatedAt: new Date(s.ledgerAt) }),
          provider: 'nuvion',
          references: {
            create: [
              {
                accountNumber: account,
                direction: s.direction,
                value: s.reference,
                kind: 'ours',
              },
            ],
          },
        },
      });
    }
    if (s.line !== false) {
      books.add(key, {
        at: s.at,
        direction: s.direction,
        amount: s.amount,
        fee,
        reference: s.reference,
        ...(s.status === 'pending' ? { status: 'pending' } : {}),
      });
    }
    return id;
  }

  /** A move between two accounts both sides agree on. */
  async function move(
    from: Wallet | null,
    to: Wallet | null,
    amount: number,
    ledgerOffsetMs?: number,
  ): Promise<string> {
    const reference = ref();
    const at = tick();
    const ledgerAt =
      ledgerOffsetMs === undefined ? undefined : at + ledgerOffsetMs;
    await side({
      who: from,
      direction: 'out',
      amount,
      fee: 100,
      reference,
      at,
      ledgerAt,
    });
    await side({ who: to, direction: 'in', amount, reference, at, ledgerAt });
    return reference;
  }

  /** The money in: an inflow the provider credited and the ledger booked. */
  async function inflow(to: Wallet, amount: number): Promise<void> {
    await side({
      who: to,
      direction: 'in',
      amount,
      reference: ref(),
      at: tick(),
    });
  }

  /**
   * A wallet-to-wallet send with WAWU's fee: the send, the person's credit,
   * and the fee as its own transfer to WAWU's account (FIX-52, FIX-66).
   */
  async function sendWithFee(
    from: Wallet,
    to: Wallet,
    amount: number,
    wawuFee: number,
  ): Promise<{ reference: string; sendRow: string }> {
    const reference = ref();
    const at = tick();
    const sendRow = await side({
      who: from,
      direction: 'out',
      amount,
      fee: 100,
      wawuFee,
      providerFee: 100,
      reference,
      at,
    });
    await side({ who: to, direction: 'in', amount, reference, at });
    // The fee's own transfer: the sender's debit (the ledger holds it inside the
    // send's row) and WAWU's credit (the ledger's row of its own, FIX-66).
    books.add(from.customerId, {
      at: at + 1,
      direction: 'out',
      amount: wawuFee,
      fee: 0,
      reference: `${reference}-fee`,
    });
    await side({
      who: null,
      direction: 'in',
      amount: wawuFee,
      reference: `${reference}-fee`,
      at: at + 1,
    });
    return { reference, sendRow };
  }

  async function run(hours = 48): Promise<MoneyCheckReport> {
    const outcome = await service.runNight({
      night: night(),
      windowFrom: new Date(Date.now() - hours * HOUR),
    });
    if (outcome.state !== 'finished') {
      throw new Error(`the run ${outcome.state}`);
    }
    return outcome.report;
  }

  const kinds = (r: MoneyCheckReport): string[] =>
    [...r.mismatches, ...r.look]
      .map((f: Finding) => `${f.check}:${f.kind}`)
      .sort();

  /** The usual day: money in, a send with a fee, a payment to WAWU, WAWU pays out. */
  async function aDay(): Promise<{
    a: Wallet;
    b: Wallet;
    sent: { reference: string; sendRow: string };
    pay: string;
    out: string;
  }> {
    const a = await wallet();
    const b = await wallet();
    await inflow(a, 5_000_000);
    const sent = await sendWithFee(a, b, 100_000, 1_000);
    const pay = await move(a, null, 200_000);
    const out = await move(null, b, 150_000);
    return { a, b, sent, pay, out };
  }

  beforeAll(async () => {
    clock = Date.now() - 10 * HOUR;
    books.open('merchant', Number(OPENING));
    cfg = new MoneyCheckSettings({
      get: (key: string) =>
        ({
          MONEY_CHECK_CALL_GAP_MS: '0',
          MONEY_CHECK_SETTLE_MINUTES: '5',
        })[key],
    } as never);
    cfg.recheckMs = [0, 0];
    cfg.retryMs = [0];
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
      ],
      providers: [
        MoneyCheckService,
        { provide: WALLET_PROVIDER, useValue: provider },
        { provide: MoneyCheckSettings, useValue: cfg },
        { provide: MoneyCheckScope, useValue: scope },
        { provide: PaymentSettings, useValue: { reviewAfterHours: 72 } },
        { provide: MoneyCheckMailer, useValue: {} },
      ],
    })
      .setLogger(new QuietLogger())
      .compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    service = moduleRef.get(MoneyCheckService);
  });

  async function wipe(): Promise<void> {
    // Only what this run made: its own nights, its own references, its own
    // wallets and accounts (G-FIX-80 F4: another spec shares this database).
    await prisma.moneyCheckRun.deleteMany({
      where: { provider: 'nuvion', night: { in: [...nightsMade] } },
    });
    await prisma.fintavaLedgerEntry.deleteMany({
      where: { customerReference: { startsWith: PREFIX } },
    });
    await prisma.fintavaWallet.deleteMany({
      where: { wawuUserId: { in: scope.users } },
    });
    // Whatever sits on an account this spec made, by account as well as by
    // reference, so nothing of it is left for another spec's database to read.
    await prisma.fintavaLedgerEntry.deleteMany({
      where: { accountNumber: { in: [...usedAccounts, MERCHANT_ACCOUNT] } },
    });
    scope.users = [];
    books.statesBalance = true;
    books.accounts.clear();
    walletOf.clear();
    books.open('merchant', Number(OPENING));
    clock = Date.now() - 10 * HOUR;
  }

  afterAll(async () => {
    if (prisma) {
      await wipe();
      // Nothing of this run may be left in the database for another spec.
      const left = await prisma.fintavaLedgerEntry.count({
        where: {
          OR: [
            { customerReference: { startsWith: PREFIX } },
            { accountNumber: { in: [...usedAccounts, MERCHANT_ACCOUNT] } },
          ],
        },
      });
      const runs = await prisma.moneyCheckRun.count({
        where: { provider: 'nuvion', night: { in: [...nightsMade] } },
      });
      expect({ left, runs }).toEqual({ left: 0, runs: 0 });
    }
    if (moduleRef) await moduleRef.close();
  });

  beforeEach(wipe);

  it('says clean, and has compared every wallet and WAWU account line by line', async () => {
    const { a, b } = await aDay();
    expect(a.customerId).not.toBe(b.customerId);
    const r = await run();
    expect(r.mismatches).toEqual([]);
    expect(r.look).toEqual([]);
    expect(r.verdict).toBe('clean');
    expect(r.wallets).toEqual({ total: 2, checked: 2, notChecked: {} });
    const checked = (id: string) => r.checks.find((c) => c.id === id)?.checked;
    // A: the send, its fee leg and the payment (debits) and the inflow
    // (a credit). B: the send and the payout (credits).
    expect(checked('movements')).toBe(6);
    // WAWU's account: the fee credit, the payment credit, the payout debit.
    expect(checked('merchant_movements')).toBe(3);
    // Two wallets and WAWU's account.
    expect(checked('balances')).toBe(3);
    expect(checked('merchant_charges')).toBe(1);
    expect(r.checks.every((c) => c.state === 'ok')).toBe(true);
  });

  it('names a send the ledger never wrote: the debit, the fee leg and the balance', async () => {
    const { sent } = await aDay();
    await prisma.fintavaLedgerEntry.delete({ where: { id: sent.sendRow } });
    const r = await run();
    expect(r.verdict).toBe('differences');
    expect(kinds(r)).toEqual(
      [
        'balances:balance_differs',
        'movements:provider_only',
        'movements:provider_only',
      ].sort(),
    );
    const refs = r.mismatches.filter((f) => f.kind === 'provider_only');
    expect(refs.map((f) => f.detail).sort()).toEqual([
      'The provider shows this debit completed and the ledger has no row for it.',
      'The provider shows this debit completed and the ledger has no row for it.',
    ]);
  });

  it('names a wrong amount on a credit', async () => {
    const a = await wallet();
    await inflow(a, 5_000_000);
    const reference = ref();
    const at = tick();
    await side({
      who: a,
      direction: 'in',
      amount: 70_000,
      reference,
      at,
      line: false,
    });
    books.add(a.customerId, {
      at,
      direction: 'in',
      amount: 60_000,
      fee: 0,
      reference,
    });
    const r = await run();
    expect(kinds(r)).toEqual([
      'balances:balance_differs',
      'movements:amount_differs',
    ]);
    expect(r.mismatches.find((f) => f.kind === 'amount_differs')).toMatchObject(
      {
        amountKobo: '70000',
        otherKobo: '60000',
      },
    );
  });

  it('names a line the provider has and nobody wrote, a debit and a credit', async () => {
    const { a, b } = await aDay();
    books.add(a.customerId, {
      at: tick(),
      direction: 'out',
      amount: 7_000,
      fee: 0,
      reference: ref(),
    });
    books.add(b.customerId, {
      at: tick(),
      direction: 'in',
      amount: 9_000,
      fee: 0,
      reference: ref(),
    });
    const r = await run();
    expect(kinds(r)).toEqual([
      'balances:balance_differs',
      'balances:balance_differs',
      'movements:provider_only',
      'movements:provider_only',
    ]);
    expect(
      r.mismatches.map((f) => f.detail).filter((d) => d.includes('credit')),
    ).toHaveLength(1);
  });

  it('names a ledger row the provider never saw, on a credit', async () => {
    const { b } = await aDay();
    await side({
      who: b,
      direction: 'in',
      amount: 12_000,
      reference: ref(),
      at: tick(),
      line: false,
    });
    const r = await run();
    expect(kinds(r)).toEqual([
      'balances:balance_differs',
      'movements:ledger_only',
    ]);
  });

  it("names WAWU's account short of its ledger, and above it", async () => {
    await aDay();
    // A merchant credit the ledger holds and the provider never made.
    await side({
      who: null,
      direction: 'in',
      amount: 33_000,
      reference: ref(),
      at: tick(),
      line: false,
    });
    const short = await run();
    expect(kinds(short)).toEqual([
      'balances:balance_differs',
      'merchant_movements:ledger_only',
    ]);
    const finding = short.mismatches.find((f) => f.ref === 'wawu-account');
    expect(finding?.detail).toContain('33000 kobo less in WAWU');

    await wipe();
    await aDay();
    // WAWU's account received money the ledger knows nothing of.
    books.add('merchant', {
      at: tick(),
      direction: 'in',
      amount: 21_000,
      fee: 0,
      reference: ref(),
    });
    const above = await run();
    expect(kinds(above)).toEqual([
      'balances:balance_differs',
      'merchant_movements:provider_only',
    ]);
    expect(
      above.mismatches.find((f) => f.ref === 'wawu-account')?.detail,
    ).toContain('21000 kobo more in WAWU');
  });

  it('names a fee that was charged on a send and never moved', async () => {
    const { sent } = await aDay();
    books.drop(Array.from(walletOf.values())[0], `${sent.reference}-fee`);
    books.drop('merchant', `${sent.reference}-fee`);
    const r = await run();
    expect(r.verdict).toBe('differences');
    expect(kinds(r)).toEqual([
      'balances:balance_differs',
      'balances:balance_differs',
      'merchant_charges:merchant_charge_missing',
      'merchant_movements:ledger_only',
    ]);
  });

  it('names a fee transfer that moved another sum than the ledger charged', async () => {
    const { sent } = await aDay();
    const key = Array.from(walletOf.values())[0];
    books.drop(key, `${sent.reference}-fee`);
    books.add(key, {
      at: tick(),
      direction: 'out',
      amount: 900,
      fee: 0,
      reference: `${sent.reference}-fee`,
    });
    const r = await run();
    expect(kinds(r)).toContain('merchant_charges:merchant_charge_differs');
    expect(r.verdict).toBe('differences');
  });

  it('counts a charge the provider stated, which the ledger row holds with its note, apart', async () => {
    const a = await wallet();
    await inflow(a, 5_000_000);
    const reference = ref();
    await side({
      who: a,
      direction: 'out',
      amount: 80_000,
      fee: 4_000,
      providerFee: 4_000,
      reference,
      at: tick(),
      bank: true,
      discrepancy: chargeDifferenceNote('Nuvion', 4_000, 2_500),
    });
    const r = await run();
    expect(r.mismatches).toEqual([]);
    expect(r.verdict).toBe('clean');
    expect(r.notices.ledger_charge_explained).toEqual({ count: 1 });
  });

  it('keeps a row whose figures differ from the provider as a difference', async () => {
    const a = await wallet();
    await inflow(a, 5_000_000);
    await side({
      who: a,
      direction: 'out',
      amount: 80_000,
      fee: 4_000,
      // The row holds a charge the provider's record does not state.
      providerFee: 2_500,
      reference: ref(),
      at: tick(),
      bank: true,
      discrepancy: chargeDifferenceNote('Nuvion', 2_500, 2_500),
    });
    const r = await run();
    expect(r.notices.ledger_charge_explained).toBeUndefined();
    expect(kinds(r)).toContain('ledger_rows:ledger_discrepancy');
  });

  it('reads a fee given back as the return of the send, not a credit nobody wrote', async () => {
    const a = await wallet();
    await inflow(a, 5_000_000);
    const reference = ref();
    const at = tick();
    // The send did not stand: the ledger row is failed; the fee went and came back.
    await side({
      who: a,
      direction: 'out',
      amount: 100_000,
      fee: 100,
      wawuFee: 1_000,
      reference,
      at,
      status: 'failed',
      line: false,
    });
    books.add(a.customerId, {
      at: at + 1,
      direction: 'out',
      amount: 1_000,
      fee: 0,
      reference: `${reference}-fee`,
    });
    books.add(a.customerId, {
      at: at + 2,
      direction: 'in',
      amount: 1_000,
      fee: 0,
      reference: `${reference}-fee-back`,
    });
    await side({
      who: null,
      direction: 'in',
      amount: 1_000,
      reference: `${reference}-fee`,
      at: at + 1,
    });
    await side({
      who: null,
      direction: 'out',
      amount: 1_000,
      reference: `${reference}-fee-back`,
      at: at + 2,
    });
    const r = await run();
    expect(r.mismatches).toEqual([]);
    expect(r.notices.fee_given_back).toEqual({ count: 1, amountKobo: '1000' });
  });

  // -------------------------------------------------------------------------
  // FIX-80: launch-length history, and a move that was reversed or returned
  // -------------------------------------------------------------------------

  /** WAWU payments from a wallet, one each `stepMs`, both sides agreeing. */
  async function payments(
    from: Wallet,
    count: number,
    firstAt: number,
    stepMs: number,
  ): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      const reference = ref();
      const at = Math.round(firstAt + i * stepMs);
      await side({
        who: from,
        direction: 'out',
        amount: 1_000 + i,
        reference,
        at,
      });
      await side({
        who: null,
        direction: 'in',
        amount: 1_000 + i,
        reference,
        at,
      });
    }
  }

  /**
   * An account that has outlived the window: a wallet funded long ago, 130
   * payments to WAWU a day and a half back (more than one page of the
   * statement), then today's moves inside a 12 hour window.
   */
  async function longLived(): Promise<{ a: Wallet; b: Wallet }> {
    const a = await wallet();
    const b = await wallet();
    await side({
      who: a,
      direction: 'in',
      amount: 90_000_000,
      reference: ref(),
      at: Date.now() - 60 * HOUR,
    });
    await payments(a, 130, Date.now() - 36 * HOUR, 60_000);
    await move(a, null, 200_000);
    await move(null, b, 150_000);
    return { a, b };
  }

  it("reads WAWU's account clean when its history is longer than the window (G-FIX-67 F1)", async () => {
    await longLived();
    const r = await run(12);
    expect(r.mismatches).toEqual([]);
    expect(r.verdict).toBe('clean');
    // Two wallets and WAWU's account were all compared.
    expect(r.checks.find((c) => c.id === 'balances')?.checked).toBe(3);
    expect(r.notices.wawu_balance_not_compared).toBeUndefined();
  });

  it("still names a shortfall in WAWU's account inside that window", async () => {
    await longLived();
    await side({
      who: null,
      direction: 'in',
      amount: 33_000,
      reference: ref(),
      at: tick(),
      line: false,
    });
    const r = await run(12);
    expect(kinds(r)).toEqual([
      'balances:balance_differs',
      'merchant_movements:ledger_only',
    ]);
    expect(
      r.mismatches.find((f) => f.ref === 'wawu-account')?.detail,
    ).toContain('33000 kobo less in WAWU');
  });

  it("still names money in WAWU's account the ledger never knew, inside that window", async () => {
    await longLived();
    books.add('merchant', {
      at: tick(),
      direction: 'in',
      amount: 21_000,
      fee: 0,
      reference: ref(),
    });
    const r = await run(12);
    expect(kinds(r)).toEqual([
      'balances:balance_differs',
      'merchant_movements:provider_only',
    ]);
    expect(
      r.mismatches.find((f) => f.ref === 'wawu-account')?.detail,
    ).toContain('21000 kobo more in WAWU');
  });

  /**
   * Many payments to WAWU in one go, both sides written in bulk. `skewMs`
   * dates the ledger row that far from its provider line, per payment.
   */
  async function bulkPayments(
    from: Wallet,
    count: number,
    firstAt: number,
    stepMs: number,
    skewMs: (i: number) => number = () => 0,
  ): Promise<void> {
    const entries: Prisma.FintavaLedgerEntryCreateManyInput[] = [];
    const references: Prisma.FintavaLedgerReferenceCreateManyInput[] = [];
    for (let i = 0; i < count; i += 1) {
      const reference = ref();
      const at = Math.round(firstAt + i * stepMs);
      const amount = 1_000 + (i % 50);
      const ledgerAt = new Date(at + skewMs(i));
      for (const out of [true, false]) {
        const id = randomUUID();
        const account = out ? from.accountNumber : MERCHANT_ACCOUNT;
        entries.push({
          id,
          walletKind: out ? 'user' : 'merchant',
          wawuUserId: out ? from.wawuUserId : null,
          accountNumber: account,
          direction: out ? 'out' : 'in',
          status: 'completed',
          category: 'transfer',
          amountKobo: BigInt(amount),
          feeKobo: 0n,
          wawuFeeKobo: out ? 0n : null,
          totalKobo: BigInt(amount),
          customerReference: reference,
          source: 'send',
          occurredAt: ledgerAt,
          createdAt: ledgerAt,
          updatedAt: ledgerAt,
          provider: 'nuvion',
        });
        references.push({
          accountNumber: account,
          direction: out ? 'out' : 'in',
          value: reference,
          kind: 'ours',
          entryId: id,
        });
      }
      books.add(from.customerId, {
        at,
        direction: 'out',
        amount,
        fee: 0,
        reference,
      });
      books.add('merchant', {
        at,
        direction: 'in',
        amount,
        fee: 0,
        reference,
      });
    }
    await prisma.fintavaLedgerEntry.createMany({ data: entries });
    await prisma.fintavaLedgerReference.createMany({ data: references });
  }

  /**
   * WAWU's account at launch volume: one payment every 30 seconds for the
   * 8 hours before the 12 hour window opens, so that in the part of the
   * statement that is read there is never a quiet minute, and two moves inside
   * the window. `skewed`: the ledger dates the last 30 payments 9 hours after
   * their lines, and the two moves 9 hours before theirs.
   */
  async function busy(skewed = false): Promise<{ a: Wallet; b: Wallet }> {
    const a = await wallet();
    const b = await wallet();
    await side({
      who: a,
      direction: 'in',
      amount: 90_000_000,
      reference: ref(),
      at: Date.now() - 60 * HOUR,
    });
    const windowFrom = Date.now() - 12 * HOUR;
    await bulkPayments(
      a,
      960,
      windowFrom - 8 * HOUR,
      30_000,
      skewed ? (i) => (i >= 930 ? 9 * HOUR : 0) : undefined,
    );
    await move(a, null, 200_000, skewed ? -9 * HOUR : undefined);
    await move(null, b, 150_000, skewed ? -9 * HOUR : undefined);
    return { a, b };
  }

  it("reads WAWU's account clean, and compares it, when it is busy every 30 seconds (G-FIX-80-1)", async () => {
    await busy();
    const r = await run(12);
    expect(r.mismatches).toEqual([]);
    expect(r.verdict).toBe('clean');
    // Two wallets and WAWU's account were all compared.
    expect(r.checks.find((c) => c.id === 'balances')?.checked).toBe(3);
    expect(r.notices.wawu_balance_not_compared).toBeUndefined();
  });

  it("names a shortfall in a busy account's compared stretch", async () => {
    await busy();
    await side({
      who: null,
      direction: 'in',
      amount: 33_000,
      reference: ref(),
      at: tick(),
      line: false,
    });
    const r = await run(12);
    expect(r.verdict).toBe('differences');
    expect(kinds(r)).toEqual([
      'balances:balance_differs',
      'merchant_movements:ledger_only',
    ]);
    expect(
      r.mismatches.find((f) => f.ref === 'wawu-account')?.detail,
    ).toContain('33000 kobo less in WAWU');
  });

  it("names a surplus in a busy account's compared stretch", async () => {
    await busy();
    books.add('merchant', {
      at: tick(),
      direction: 'in',
      amount: 21_000,
      fee: 0,
      reference: ref(),
    });
    const r = await run(12);
    expect(r.verdict).toBe('differences');
    expect(kinds(r)).toEqual([
      'balances:balance_differs',
      'merchant_movements:provider_only',
    ]);
    expect(
      r.mismatches.find((f) => f.ref === 'wawu-account')?.detail,
    ).toContain('21000 kobo more in WAWU');
  });

  it('reads clean when the ledger dates rows hours from their provider lines, either side of the cut (G-FIX-67 F3)', async () => {
    await busy(true);
    const r = await run(12);
    expect(r.mismatches).toEqual([]);
    expect(r.verdict).toBe('clean');
    expect(r.checks.find((c) => c.id === 'balances')?.checked).toBe(3);
    expect(r.notices.wawu_balance_not_compared).toBeUndefined();
  });

  it("reads a payout the bank returned days after it, from before the window, as clean for WAWU's account", async () => {
    const a = await wallet();
    await side({
      who: a,
      direction: 'in',
      amount: 90_000_000,
      reference: ref(),
      at: Date.now() - 60 * HOUR,
    });
    await payments(a, 130, Date.now() - 36 * HOUR, 60_000);
    // WAWU's bank payout 30 hours ago, returned inside the window.
    const sent = ref();
    await side({
      who: null,
      direction: 'out',
      amount: 100_000,
      fee: 2_500,
      providerFee: 2_500,
      reference: sent,
      at: Date.now() - 30 * HOUR,
      bank: true,
      status: 'reversed',
    });
    books.add('merchant', {
      at: tick(),
      direction: 'in',
      amount: 102_500,
      fee: 0,
      reference: `${sent}_reversal`,
    });
    const r = await run(12);
    expect(r.mismatches).toEqual([]);
    expect(r.verdict).toBe('clean');
    expect(r.checks.find((c) => c.id === 'balances')?.checked).toBe(2);
  });

  it("says the night is incomplete, never clean, when the statement states no balance for WAWU's account", async () => {
    await aDay();
    books.statesBalance = false;
    const r = await run();
    expect(r.mismatches).toEqual([]);
    expect(r.verdict).toBe('incomplete');
    const balances = r.checks.find((c) => c.id === 'balances');
    expect(balances?.state).toBe('incomplete');
    expect(balances?.note).toContain("WAWU's account balance was not compared");
    expect(r.notices.wawu_balance_not_compared).toEqual({ count: 1 });
  });

  it("says the night is incomplete, never clean, when WAWU's statement is longer than the pages read", async () => {
    await busy();
    const pages = cfg.historyPages;
    // Two pages are 200 lines, 100 minutes of the burst: they do not reach back
    // past the start of the window.
    (cfg as { historyPages: number }).historyPages = 2;
    try {
      const r = await run(12);
      expect(r.verdict).toBe('incomplete');
      const balances = r.checks.find((c) => c.id === 'balances');
      expect(balances?.state).toBe('incomplete');
      expect(balances?.note).toContain(
        "WAWU's account balance was not compared: its statement is longer than the pages read",
      );
    } finally {
      (cfg as { historyPages: number }).historyPages = pages;
    }
  });

  /** A wallet-to-wallet send that was reversed: both lines, both returns. */
  async function reversedSend(
    a: Wallet,
    b: Wallet,
    opts: { returned?: boolean; returnedKobo?: number } = {},
  ): Promise<string> {
    const reference = ref();
    const at = tick();
    await side({
      who: a,
      direction: 'out',
      amount: 100_000,
      fee: 100,
      reference,
      at,
      status: 'reversed',
    });
    await side({
      who: b,
      direction: 'in',
      amount: 100_000,
      reference,
      at,
      status: 'reversed',
    });
    if (opts.returned !== false) {
      books.add(a.customerId, {
        at: at + 1_000,
        direction: 'in',
        amount: opts.returnedKobo ?? 100_100,
        fee: 0,
        reference: `${reference}_reversal`,
      });
      books.add(b.customerId, {
        at: at + 1_000,
        direction: 'out',
        amount: 100_000,
        fee: 0,
        reference: `${reference}_reversal`,
      });
    }
    return reference;
  }

  /** A bank send that Nuvion returned: the debit, then the credit of the money back. */
  async function returnedBankSend(
    a: Wallet,
    opts: {
      ledger?: 'reversed' | 'completed';
      returnedKobo?: number | null;
    } = {},
  ): Promise<string> {
    const reference = ref();
    const at = tick();
    await side({
      who: a,
      direction: 'out',
      amount: 100_000,
      fee: 2_500,
      providerFee: 2_500,
      reference,
      at,
      bank: true,
      status: opts.ledger ?? 'reversed',
    });
    if (opts.returnedKobo !== null) {
      books.add(a.customerId, {
        at: at + 60_000,
        direction: 'in',
        amount: opts.returnedKobo ?? 102_500,
        fee: 0,
        reference: `${reference}_reversal`,
      });
    }
    return reference;
  }

  it('reads a reversed WAWU send as clean: its lines and the money back (G-FIX-67-4)', async () => {
    const a = await wallet();
    const b = await wallet();
    await inflow(a, 5_000_000);
    await reversedSend(a, b);
    const r = await run();
    expect(r.mismatches).toEqual([]);
    expect(r.look).toEqual([]);
    expect(r.verdict).toBe('clean');
    expect(r.notices.reversal_returned).toEqual({
      count: 2,
      amountKobo: '200100',
    });
  });

  it('reads a bank send the bank returned as clean (G-FIX-67-4)', async () => {
    const a = await wallet();
    await inflow(a, 5_000_000);
    await returnedBankSend(a);
    const r = await run();
    expect(r.mismatches).toEqual([]);
    expect(r.verdict).toBe('clean');
    expect(r.notices.reversal_returned).toEqual({
      count: 1,
      amountKobo: '102500',
    });
  });

  it('names a reversal the provider never returned, on a WAWU send and on a bank send', async () => {
    const a = await wallet();
    const b = await wallet();
    await inflow(a, 5_000_000);
    await reversedSend(a, b, { returned: false });
    const sent = await run();
    expect(sent.verdict).toBe('differences');
    expect(kinds(sent)).toEqual(
      [
        'balances:balance_differs',
        'balances:balance_differs',
        'movements:status_differs',
        'movements:status_differs',
      ].sort(),
    );
    expect(sent.notices.reversal_returned).toBeUndefined();

    await wipe();
    const c = await wallet();
    await inflow(c, 5_000_000);
    await returnedBankSend(c, { returnedKobo: null });
    const bank = await run();
    expect(bank.verdict).toBe('differences');
    expect(kinds(bank)).toEqual([
      'balances:balance_differs',
      'movements:status_differs',
    ]);
  });

  it('names a bank send that came back for less than it took', async () => {
    const a = await wallet();
    await inflow(a, 5_000_000);
    await returnedBankSend(a, { returnedKobo: 50_000 });
    const r = await run();
    expect(r.verdict).toBe('differences');
    expect(kinds(r)).toContain('movements:status_differs');
    expect(kinds(r)).toContain('balances:balance_differs');
  });

  it('names a return the ledger never recorded: the bank sent it back and the row says completed', async () => {
    const a = await wallet();
    await inflow(a, 5_000_000);
    await returnedBankSend(a, { ledger: 'completed' });
    const r = await run();
    expect(r.verdict).toBe('differences');
    expect(kinds(r)).toContain('movements:provider_only');
    expect(kinds(r)).toContain('balances:balance_differs');
  });

  it('keeps an explained charge explained after its line has left the window (G-FIX-67-5)', async () => {
    const a = await wallet();
    await inflow(a, 5_000_000);
    await side({
      who: a,
      direction: 'out',
      amount: 80_000,
      fee: 4_000,
      providerFee: 4_000,
      reference: ref(),
      at: Date.now() - 40 * HOUR,
      bank: true,
      discrepancy: chargeDifferenceNote('Nuvion', 4_000, 2_500),
    });
    const r = await run(12);
    expect(r.mismatches).toEqual([]);
    expect(r.verdict).toBe('clean');
    expect(r.notices.ledger_charge_explained).toEqual({ count: 1 });
  });
});
