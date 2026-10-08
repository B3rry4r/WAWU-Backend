import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '../../../../generated/prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { WalletProviderError } from '../../../wallet-provider/wallet-provider-error';
import { providerLimitError } from '../../../wallet-provider/wallet-provider-limit';
import type {
  ProviderTransferReceipt,
  ProviderWalletTransferInput,
  WalletProviderName,
} from '../../../wallet-provider/wallet-provider.interface';
import type { MoneyErrorReason } from '../../dto/money-error.dto';
import type { FeeQuoteQueryDto } from '../../dto/money-request.dto';
import { FEE_CONFIG_KEYS, FeeSettings } from '../../fees/fee-config';
import { FeeQuoteService } from '../../fees/fee-quote.service';
import { MoneyFeesController } from '../../fees/money-fees.controller';
import { NUVION_FEE_CONFIG_KEYS } from '../../fees/nuvion-fee-config';
import { MoneyError } from '../../money-error';
import { limitReached } from '../limit-reached';
import {
  limitConfigKey,
  type MoneyLimitKind,
  MoneyLimitSettings,
} from '../money-limit-config';
import type { MoneyLimitName } from '../money-limit-names';
import { MoneyLimits, type MovementInput } from '../money-limits.service';

/**
 * WAWU's limits over a real ledger (task NUV-07): what counts toward a Lagos
 * day and month, the per-person lock that stops two movements passing one
 * limit together, and the capability check "a movement above a set limit
 * answers limit_reached, before any call" through the flow every
 * money-moving service follows (docs/contract/CONVENTIONS.md section 11):
 * `assertMayMove` in the transaction that writes the pending ledger row,
 * then the provider, its failures answered with `toHttpException()`.
 *
 * Nuvion is stood in at the seam by a provider that records each call.
 * Nothing here reaches any provider's host. The figures are the spec's own.
 */

const NOW = new Date('2026-10-15T10:00:00.000Z'); // 11:00 in Lagos
const TODAY = new Date('2026-10-15T09:00:00.000Z');
const LAST_LAGOS_MOMENT_YESTERDAY = new Date('2026-10-14T22:59:59.999Z');
const LAGOS_MIDNIGHT_TODAY = new Date('2026-10-14T23:00:00.000Z');
const LAST_LAGOS_MOMENT_LAST_MONTH = new Date('2026-09-30T22:59:59.999Z');
const LAGOS_FIRST_OF_MONTH = new Date('2026-09-30T23:00:00.000Z');

const FEES = {
  [NUVION_FEE_CONFIG_KEYS.bookTransfer]: '100',
  [NUVION_FEE_CONFIG_KEYS.bankPayout]: '200',
  [NUVION_FEE_CONFIG_KEYS.inflow]: '0',
};

let prisma: PrismaService;
const users: string[] = [];

function person(): string {
  const id = randomUUID();
  users.push(id);
  return id;
}

let seq = 0;
function nuban(): string {
  seq += 1;
  return `9${String(Date.now()).slice(-6)}${String(seq).padStart(3, '0')}`;
}

type Row = {
  kind:
    | 'wawu_transfer'
    | 'bank_transfer'
    | 'purchase'
    | 'hold'
    | 'bill'
    | 'paid_bill';
  amountKobo: number;
  at: Date;
  status?: 'pending' | 'completed' | 'failed' | 'reversed';
  direction?: 'in' | 'out';
  linkKind?: string | null;
};

function rowData(
  wawuUserId: string | null,
  r: Row,
): Prisma.FintavaLedgerEntryUncheckedCreateInput {
  const category =
    r.kind === 'wawu_transfer' || r.kind === 'bank_transfer'
      ? 'transfer'
      : r.kind === 'paid_bill'
        ? 'purchase'
        : r.kind;
  const counterpartyKind =
    r.kind === 'wawu_transfer'
      ? 'wawu_user'
      : r.kind === 'bank_transfer'
        ? 'bank_account'
        : r.kind === 'bill'
          ? 'biller'
          : 'wawu';
  return {
    walletKind: wawuUserId === null ? 'merchant' : 'user',
    wawuUserId,
    accountNumber: nuban(),
    direction: r.direction ?? 'out',
    status: r.status ?? 'completed',
    category,
    amountKobo: BigInt(r.amountKobo),
    totalKobo: BigInt(r.amountKobo),
    counterpartyKind,
    linkKind: r.kind === 'paid_bill' ? 'bill' : (r.linkKind ?? null),
    source: 'send',
    occurredAt: r.at,
  };
}

async function ledger(wawuUserId: string | null, rows: Row[]): Promise<void> {
  for (const r of rows) {
    await prisma.fintavaLedgerEntry.create({ data: rowData(wawuUserId, r) });
  }
}

function limits(
  env: Record<string, string>,
  provider: WalletProviderName = 'fintava',
): MoneyLimits {
  const config = new ConfigService(env);
  return new MoneyLimits(
    new MoneyLimitSettings(config),
    prisma,
    { name: provider },
    config,
  );
}

async function refusal(
  p: Promise<unknown>,
): Promise<MoneyErrorReason & { status: number }> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(MoneyError);
    const err = e as MoneyError;
    const res = err.getResponse() as { reason: MoneyErrorReason };
    return { ...res.reason, status: err.getStatus() };
  }
  throw new Error('expected a refusal');
}

const key = limitConfigKey;

beforeAll(() => {
  prisma = new PrismaService();
});

afterAll(async () => {
  await prisma.fintavaLedgerEntry.deleteMany({
    where: { wawuUserId: { in: users } },
  });
  await prisma.fintavaLedgerEntry.deleteMany({
    where: { walletKind: 'merchant', narration: 'nuv07-spec' },
  });
  await prisma.$disconnect();
});

describe('NUV-07: what counts toward a limit, from the ledger', () => {
  it("a person's own pending and completed movements of the kind, out of their wallet, by amount, in the Lagos day and month", async () => {
    const a = person();
    const b = person();
    await ledger(a, [
      { kind: 'wawu_transfer', amountKobo: 100, at: TODAY },
      { kind: 'wawu_transfer', amountKobo: 200, at: TODAY, status: 'pending' },
      { kind: 'wawu_transfer', amountKobo: 400, at: TODAY, status: 'failed' },
      { kind: 'wawu_transfer', amountKobo: 800, at: TODAY, status: 'reversed' },
      { kind: 'wawu_transfer', amountKobo: 1600, at: TODAY, direction: 'in' },
      { kind: 'wawu_transfer', amountKobo: 3200, at: LAGOS_MIDNIGHT_TODAY },
      {
        kind: 'wawu_transfer',
        amountKobo: 6400,
        at: LAST_LAGOS_MOMENT_YESTERDAY,
      },
      { kind: 'wawu_transfer', amountKobo: 12800, at: LAGOS_FIRST_OF_MONTH },
      {
        kind: 'wawu_transfer',
        amountKobo: 25600,
        at: LAST_LAGOS_MOMENT_LAST_MONTH,
      },
      { kind: 'bank_transfer', amountKobo: 51200, at: TODAY },
      {
        kind: 'purchase',
        amountKobo: 102400,
        at: TODAY,
        linkKind: 'content_unlock',
      },
      { kind: 'purchase', amountKobo: 204800, at: TODAY },
      { kind: 'hold', amountKobo: 409600, at: TODAY, linkKind: 'paid_dm' },
      { kind: 'paid_bill', amountKobo: 819200, at: TODAY },
      { kind: 'bill', amountKobo: 1638400, at: TODAY },
    ]);
    // Somebody else's, and WAWU's own account, never count for a.
    await ledger(b, [
      { kind: 'wawu_transfer', amountKobo: 3_276_800, at: TODAY },
    ]);
    await prisma.fintavaLedgerEntry.create({
      data: {
        ...rowData(null, {
          kind: 'wawu_transfer',
          amountKobo: 6_553_600,
          at: TODAY,
        }),
        narration: 'nuv07-spec',
      },
    });

    const l = limits({});
    const moved = (kind: MoneyLimitKind, since: Date) =>
      l.movedSince(prisma, { wawuUserId: a, kind }, since);
    expect(await moved('wawu_transfer', LAGOS_MIDNIGHT_TODAY)).toBe(
      BigInt(100 + 200 + 3200),
    );
    expect(await moved('wawu_transfer', LAGOS_FIRST_OF_MONTH)).toBe(
      BigInt(100 + 200 + 3200 + 6400 + 12800),
    );
    expect(await moved('bank_transfer', LAGOS_MIDNIGHT_TODAY)).toBe(51200n);
    expect(await moved('purchase', LAGOS_MIDNIGHT_TODAY)).toBe(
      BigInt(102400 + 204800 + 409600),
    );
    expect(await moved('bill', LAGOS_MIDNIGHT_TODAY)).toBe(
      BigInt(819200 + 1638400),
    );
  });
});

describe('NUV-07: daily and monthly limits', () => {
  it('today: up to the limit passes, a kobo past it is limit_reached naming daily', async () => {
    const a = person();
    await ledger(a, [
      { kind: 'bank_transfer', amountKobo: 300_000, at: TODAY },
      {
        kind: 'bank_transfer',
        amountKobo: 900_000,
        at: LAST_LAGOS_MOMENT_YESTERDAY,
      },
    ]);
    const l = limits({ [key('bank_transfer', 'daily')]: '1000000' });
    const move = (amountKobo: number) =>
      l.assertMayMove(
        { wawuUserId: a, kind: 'bank_transfer', amountKobo },
        { now: NOW },
      );
    await expect(move(700_000)).resolves.toBeUndefined();
    expect(await refusal(move(700_001))).toMatchObject({
      status: 403,
      code: 'limit_reached',
      limit: 'daily',
    });
  });

  it('this month: the same, naming monthly, while today is still within its own limit', async () => {
    const a = person();
    await ledger(a, [
      { kind: 'purchase', amountKobo: 4_000_000, at: LAGOS_FIRST_OF_MONTH },
      {
        kind: 'purchase',
        amountKobo: 9_000_000,
        at: LAST_LAGOS_MOMENT_LAST_MONTH,
      },
    ]);
    const l = limits({
      [key('purchase', 'daily')]: '2000000',
      [key('purchase', 'monthly')]: '5000000',
    });
    const move = (amountKobo: number) =>
      l.assertMayMove(
        { wawuUserId: a, kind: 'purchase', amountKobo },
        { now: NOW },
      );
    await expect(move(1_000_000)).resolves.toBeUndefined();
    expect((await refusal(move(1_000_001))).limit).toBe('monthly');
    expect((await refusal(move(2_000_001))).limit).toBe('daily');
  });

  it('the quote can show where today stands (withinDailyLimit, remainingTodayKobo)', async () => {
    const a = person();
    await ledger(a, [
      { kind: 'wawu_transfer', amountKobo: 250_000, at: TODAY },
    ]);
    const l = limits({ [key('wawu_transfer', 'daily')]: '1000000' });
    const at = (amountKobo: number) =>
      l.dailyStanding(
        { wawuUserId: a, kind: 'wawu_transfer', amountKobo },
        NOW,
      );
    expect(await at(750_000)).toEqual({
      withinDailyLimit: true,
      remainingTodayKobo: 750_000,
    });
    expect(await at(750_001)).toEqual({
      withinDailyLimit: false,
      remainingTodayKobo: 750_000,
    });
    expect(
      await limits({}).dailyStanding(
        { wawuUserId: a, kind: 'wawu_transfer', amountKobo: 1 },
        NOW,
      ),
    ).toEqual({ withinDailyLimit: true, remainingTodayKobo: null });
  });
});

describe('NUV-07: the fee quote route, where MoneyLimitsModule is mounted', () => {
  function controller(env: Record<string, string>, withLimits: boolean) {
    const config = new ConfigService({
      [FEE_CONFIG_KEYS.quoteKey]: 'q'.repeat(40),
      ...env,
    });
    return new MoneyFeesController(
      new FeeQuoteService(new FeeSettings(config)),
      withLimits ? limits(env) : undefined,
    );
  }
  const query = (amountKobo: number) =>
    ({ kind: 'wawu_transfer', amountKobo }) as FeeQuoteQueryDto;

  it("shows today's standing for the kind; with no daily limit, or without the module, it is WALLET-15's answer exactly", async () => {
    const a = person();
    await ledger(a, [
      { kind: 'wawu_transfer', amountKobo: 250_000, at: new Date() },
    ]);
    const wallet = {
      wawuUserId: a,
      customerId: 'c',
      walletId: 'w',
      accountNumber: '1000000001',
    };
    const daily = { [key('wawu_transfer', 'daily')]: '1000000' };
    const over = await controller(daily, true).feeQuote(wallet, query(800_000));
    expect(over).toMatchObject({
      withinDailyLimit: false,
      remainingTodayKobo: 750_000,
      totalKobo: 800_000 + 1575 + 1000,
    });
    const within = await controller(daily, true).feeQuote(
      wallet,
      query(750_000),
    );
    expect(within).toMatchObject({
      withinDailyLimit: true,
      remainingTodayKobo: 750_000,
    });
    // No daily limit set, or no module: the very JSON WALLET-15 answered.
    const plain = controller({}, false);
    for (const c of [controller({}, true), plain]) {
      const v = await c.feeQuote(wallet, query(800_000));
      expect(Object.keys(v)).toEqual([
        'kind',
        'billCategory',
        'amountKobo',
        'fee',
        'parts',
        'totalKobo',
        'withinDailyLimit',
        'remainingTodayKobo',
        'quoteToken',
        'expiresAt',
      ]);
      expect(v).toMatchObject({
        withinDailyLimit: true,
        remainingTodayKobo: null,
      });
    }
  });
});

describe('NUV-07: one person, two movements at once, one limit', () => {
  it('checked in the transaction that writes the pending row, the second sees the first: one passes, one is refused', async () => {
    const a = person();
    const l = limits({ [key('wawu_transfer', 'daily')]: '1000000' });
    const attempt = (amountKobo: number) =>
      prisma.$transaction(
        async (tx) => {
          await l.assertMayMove(
            { wawuUserId: a, kind: 'wawu_transfer', amountKobo },
            { tx, now: NOW },
          );
          // The service's own work between the check and the row (the
          // quote check, the PIN record): long enough for the other to check.
          await new Promise((r) => setTimeout(r, 300));
          await tx.fintavaLedgerEntry.create({
            data: rowData(a, {
              kind: 'wawu_transfer',
              amountKobo,
              at: TODAY,
              status: 'pending',
            }),
          });
        },
        { timeout: 20_000 },
      );
    const results = await Promise.allSettled([
      attempt(600_000),
      attempt(600_000),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    const rejected = results.find(
      (r) => r.status === 'rejected',
    ) as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(MoneyError);
    expect(
      (
        (rejected.reason as MoneyError).getResponse() as {
          reason: MoneyErrorReason;
        }
      ).reason,
    ).toMatchObject({ code: 'limit_reached', limit: 'daily' });
    const rows = await prisma.fintavaLedgerEntry.count({
      where: { wawuUserId: a, status: 'pending' },
    });
    expect(rows).toBe(1);
  });
});

/**
 * The capability check, end to end over the flow: nothing reaches the
 * provider when the fees are not set or a limit is passed, and the
 * provider's own three limit errors come back as the same answer.
 */
describe('NUV-07: refused before any call to the provider', () => {
  function standIn(fail?: WalletProviderError) {
    const calls: ProviderWalletTransferInput[] = [];
    return {
      calls,
      walletToWallet(
        input: ProviderWalletTransferInput,
      ): Promise<ProviderTransferReceipt> {
        calls.push(input);
        if (fail) return Promise.reject(fail);
        return Promise.resolve({
          ourReference: input.reference,
          providerReference: null,
          secondaryReference: null,
          transactionId: null,
          amountKobo: input.amountKobo,
          totalKobo: input.amountKobo,
          feeKobo: 0n,
          sourceAvailableKobo: null,
        });
      },
    };
  }

  /** A send as every money-moving service makes it (CONVENTIONS section 11). */
  async function send(
    l: MoneyLimits,
    provider: ReturnType<typeof standIn>,
    input: MovementInput,
  ): Promise<ProviderTransferReceipt> {
    const reference = randomUUID();
    await prisma.$transaction(async (tx) => {
      await l.assertMayMove(input, { tx, now: NOW });
      await tx.fintavaLedgerEntry.create({
        data: rowData(input.wawuUserId, {
          kind: 'wawu_transfer',
          amountKobo: input.amountKobo,
          at: TODAY,
          status: 'pending',
        }),
      });
    });
    try {
      return await provider.walletToWallet({
        fromAccountNumber: '1000000001',
        toAccountNumber: '1000000002',
        amountKobo: BigInt(input.amountKobo),
        reference,
      });
    } catch (e) {
      if (e instanceof WalletProviderError) throw e.toHttpException();
      throw e;
    }
  }

  const SETTINGS = {
    ...FEES,
    [key('wawu_transfer', 'per_transaction')]: '500000',
    [key('wawu_transfer', 'daily')]: '800000',
    [key('wawu_transfer', 'monthly')]: '900000',
  };

  it('under nuvion with no fee set: fees_not_set, no call, nothing written', async () => {
    const a = person();
    const p = standIn();
    const r = await refusal(
      send(limits({}, 'nuvion'), p, {
        wawuUserId: a,
        kind: 'wawu_transfer',
        amountKobo: 100,
      }),
    );
    expect(r.code).toBe('fees_not_set');
    expect(p.calls).toEqual([]);
    expect(
      await prisma.fintavaLedgerEntry.count({ where: { wawuUserId: a } }),
    ).toBe(0);
  });

  it('above the per-transaction, the daily and the monthly limit: limit_reached naming each, no call', async () => {
    const l = limits(SETTINGS, 'nuvion');
    const per = person();
    const pPer = standIn();
    expect(
      (
        await refusal(
          send(l, pPer, {
            wawuUserId: per,
            kind: 'wawu_transfer',
            amountKobo: 500_001,
          }),
        )
      ).limit,
    ).toBe('per_transaction');
    expect(pPer.calls).toEqual([]);

    const day = person();
    await ledger(day, [
      { kind: 'wawu_transfer', amountKobo: 400_000, at: TODAY },
    ]);
    const pDay = standIn();
    expect(
      (
        await refusal(
          send(l, pDay, {
            wawuUserId: day,
            kind: 'wawu_transfer',
            amountKobo: 400_001,
          }),
        )
      ).limit,
    ).toBe('daily');
    expect(pDay.calls).toEqual([]);

    const month = person();
    await ledger(month, [
      {
        kind: 'wawu_transfer',
        amountKobo: 500_000,
        at: LAST_LAGOS_MOMENT_YESTERDAY,
      },
    ]);
    const pMonth = standIn();
    expect(
      (
        await refusal(
          send(l, pMonth, {
            wawuUserId: month,
            kind: 'wawu_transfer',
            amountKobo: 400_001,
          }),
        )
      ).limit,
    ).toBe('monthly');
    expect(pMonth.calls).toEqual([]);
  });

  it('within every limit, the provider is called once, for the amount', async () => {
    const a = person();
    const p = standIn();
    const receipt = await send(limits(SETTINGS, 'nuvion'), p, {
      wawuUserId: a,
      kind: 'wawu_transfer',
      amountKobo: 500_000,
    });
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0].amountKobo).toBe(500_000n);
    expect(receipt.amountKobo).toBe(500_000n);
  });

  const NUVION: [string, MoneyLimitName][] = [
    ['error_transfer_transaction_limit_exceeded', 'per_transaction'],
    ['error_transfer_daily_limit_exceeded', 'daily'],
    ['error_transfer_monthly_volume_exceeded', 'monthly'],
  ];
  for (const [type, limit] of NUVION) {
    it(`Nuvion refusing with ${type} gives the same answer as WAWU's own ${limit} limit`, async () => {
      const a = person();
      const p = standIn(
        providerLimitError('nuvion', type, {
          operation: 'book_transfer',
          httpStatus: 400,
          reference: 'r',
        })!,
      );
      let got: MoneyError | null = null;
      try {
        await send(limits(FEES, 'nuvion'), p, {
          wawuUserId: a,
          kind: 'wawu_transfer',
          amountKobo: 1000,
        });
      } catch (e) {
        got = e as MoneyError;
      }
      expect(p.calls).toHaveLength(1);
      expect(got).toBeInstanceOf(MoneyError);
      expect({ status: got!.getStatus(), body: got!.getResponse() }).toEqual({
        status: limitReached(limit).getStatus(),
        body: limitReached(limit).getResponse(),
      });
    });
  }
});
