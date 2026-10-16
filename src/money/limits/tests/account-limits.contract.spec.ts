import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '../../../../generated/prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { WalletProviderName } from '../../../wallet-provider/wallet-provider.interface';
import type { MoneyErrorReason } from '../../dto/money-error.dto';
import { MoneyError } from '../../money-error';
import { AccountLimits } from '../account-limits.service';
import { lagosNextDayStart } from '../lagos-window';
import { MoneyLimitSettings } from '../money-limit-config';
import { MoneyLimits } from '../money-limits.service';

/**
 * The wallet provider's limit on the account, over a real database (task
 * WALLET-23): what a balance read keeps on the wallet row, what counts toward
 * a Lagos day (every kind of movement out of the wallet together), the
 * refusal that shows the limit, W35's row, and how the check sits with
 * WAWU's own per-kind limits. No provider is reached: the check and the row
 * read only what is on file, and the figures are the spec's own.
 */

const NOW = new Date('2026-10-15T10:00:00.000Z'); // 11:00 in Lagos
const TODAY = new Date('2026-10-15T09:00:00.000Z');
const LAGOS_MIDNIGHT_TODAY = new Date('2026-10-14T23:00:00.000Z');
const LAST_LAGOS_MOMENT_YESTERDAY = new Date('2026-10-14T22:59:59.999Z');
const LAGOS_MIDNIGHT_TOMORROW = new Date('2026-10-15T23:00:00.000Z');

/** The spec's own fee on every out row: a limit read on the total is caught. */
const OUT_FEE_KOBO = 2325;
const DAILY = 1_000_000n;

let prisma: PrismaService;
const users: string[] = [];
let seq = 0;

function nuban(): string {
  seq += 1;
  return `8${String(Date.now()).slice(-6)}${String(seq).padStart(3, '0')}`;
}

async function wallet(
  provider: WalletProviderName | null = 'fintava',
): Promise<string> {
  const id = randomUUID();
  users.push(id);
  await prisma.fintavaWallet.create({
    data: {
      wawuUserId: id,
      customerId: randomUUID(),
      walletId: randomUUID(),
      accountNumber: nuban(),
      provider,
    },
  });
  return id;
}

type Row = {
  category: 'transfer' | 'purchase' | 'hold' | 'bill' | 'top_up' | 'refund';
  amountKobo: number;
  at: Date;
  status?: 'pending' | 'completed' | 'failed' | 'reversed';
  direction?: 'in' | 'out';
};

async function ledger(wawuUserId: string, rows: Row[]): Promise<void> {
  for (const r of rows) {
    const data: Prisma.FintavaLedgerEntryUncheckedCreateInput = {
      walletKind: 'user',
      wawuUserId,
      accountNumber: nuban(),
      direction: r.direction ?? 'out',
      status: r.status ?? 'completed',
      category: r.category,
      amountKobo: BigInt(r.amountKobo),
      feeKobo: BigInt(OUT_FEE_KOBO),
      totalKobo: BigInt(r.amountKobo + OUT_FEE_KOBO),
      counterpartyKind: r.category === 'transfer' ? 'wawu_user' : 'wawu',
      source: 'send',
      occurredAt: r.at,
    };
    await prisma.fintavaLedgerEntry.create({ data });
  }
}

function services(
  env: Record<string, string> = {},
  provider: WalletProviderName = 'fintava',
) {
  const config = new ConfigService(env);
  const accounts = new AccountLimits(prisma, {
    name: provider,
    label: provider,
  } as never);
  const limits = new MoneyLimits(
    new MoneyLimitSettings(config),
    prisma,
    { name: provider },
    config,
    accounts,
  );
  return { accounts, limits };
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

const tier2 = { tier: 'TIER_2', dailyKobo: DAILY };

beforeAll(() => {
  prisma = new PrismaService();
});

afterAll(async () => {
  await prisma.fintavaLedgerEntry.deleteMany({
    where: { wawuUserId: { in: users } },
  });
  await prisma.fintavaWallet.deleteMany({
    where: { wawuUserId: { in: users } },
  });
  await prisma.$disconnect();
});

describe('WALLET-23: keeping what a balance read said', () => {
  it('writes the tier, the daily limit and when it was read onto the wallet row', async () => {
    const { accounts } = services();
    const a = await wallet();
    expect(await accounts.stored(a)).toEqual({
      tier: null,
      dailyKobo: null,
      readAt: null,
    });
    await accounts.record(a, tier2, NOW);
    expect(await accounts.stored(a)).toEqual({
      tier: 'TIER_2',
      dailyKobo: DAILY,
      readAt: NOW,
    });
    // A later read replaces it: the provider moved the wallet up.
    await accounts.record(a, { tier: 'TIER_3', dailyKobo: 9_000_000n }, NOW);
    expect((await accounts.stored(a))?.dailyKobo).toBe(9_000_000n);
    // And a read that names no limit clears it.
    await accounts.record(a, { tier: 'TIER_9', dailyKobo: null }, NOW);
    expect(await accounts.stored(a)).toMatchObject({
      tier: 'TIER_9',
      dailyKobo: null,
    });
  });

  it('writes nothing when the balance answer carried no limit (a provider that names none)', async () => {
    const { accounts } = services();
    const a = await wallet();
    await accounts.record(a, tier2, NOW);
    await accounts.record(a, undefined, NOW);
    expect((await accounts.stored(a))?.dailyKobo).toBe(DAILY);
  });

  it("acts only on a wallet of the provider the server runs: another provider's row is neither read nor written", async () => {
    const other = await wallet('nuvion');
    const { accounts } = services({}, 'fintava');
    await accounts.record(other, tier2, NOW);
    expect(await accounts.stored(other)).toBeNull();
    expect(await accounts.view(other, NOW)).toBeNull();
    const row = await prisma.fintavaWallet.findUnique({
      where: { wawuUserId: other },
    });
    expect(row?.dailyLimitKobo).toBeNull();
    expect(row?.limitsReadAt).toBeNull();
    // The same row is its own provider's.
    const asNuvion = services({}, 'nuvion').accounts;
    await asNuvion.record(other, tier2, NOW);
    expect((await asNuvion.stored(other))?.dailyKobo).toBe(DAILY);
  });

  it('a row from before the provider column (null) is Fintava, as everywhere else', async () => {
    const legacy = await wallet(null);
    const { accounts } = services();
    await accounts.record(legacy, tier2, NOW);
    expect((await accounts.stored(legacy))?.dailyKobo).toBe(DAILY);
  });

  it('a person with no wallet has nothing kept and nothing thrown', async () => {
    const { accounts } = services();
    const nobody = randomUUID();
    await expect(accounts.record(nobody, tier2, NOW)).resolves.toBeUndefined();
    expect(await accounts.stored(nobody)).toBeNull();
  });
});

describe('WALLET-23: what counts toward the day', () => {
  it('every kind of movement out of the wallet today in Lagos, pending or completed, by amount before fees', async () => {
    const { accounts } = services();
    const a = await wallet();
    const b = await wallet();
    await ledger(a, [
      { category: 'transfer', amountKobo: 100, at: TODAY },
      { category: 'purchase', amountKobo: 200, at: TODAY, status: 'pending' },
      { category: 'hold', amountKobo: 400, at: TODAY },
      { category: 'bill', amountKobo: 800, at: TODAY },
      // Not counted: failed or reversed gave the money back; money in;
      // a top up and a refund are not sends; the day before.
      { category: 'transfer', amountKobo: 1600, at: TODAY, status: 'failed' },
      { category: 'transfer', amountKobo: 3200, at: TODAY, status: 'reversed' },
      { category: 'transfer', amountKobo: 6400, at: TODAY, direction: 'in' },
      { category: 'top_up', amountKobo: 12800, at: TODAY },
      { category: 'refund', amountKobo: 25600, at: TODAY },
      {
        category: 'transfer',
        amountKobo: 51200,
        at: LAST_LAGOS_MOMENT_YESTERDAY,
      },
    ]);
    await ledger(b, [{ category: 'transfer', amountKobo: 999, at: TODAY }]);
    expect(await accounts.movedToday(prisma, a, NOW)).toBe(1500n);
    // The Lagos midnight itself starts the day.
    await ledger(a, [
      { category: 'transfer', amountKobo: 5, at: LAGOS_MIDNIGHT_TODAY },
    ]);
    expect(await accounts.movedToday(prisma, a, NOW)).toBe(1505n);
  });

  it('the day starts again at the next Lagos midnight, across a month end and a year end', () => {
    expect(lagosNextDayStart(NOW)).toEqual(LAGOS_MIDNIGHT_TOMORROW);
    expect(lagosNextDayStart(new Date('2026-10-31T10:00:00.000Z'))).toEqual(
      new Date('2026-10-31T23:00:00.000Z'),
    );
    expect(lagosNextDayStart(new Date('2026-12-31T10:00:00.000Z'))).toEqual(
      new Date('2026-12-31T23:00:00.000Z'),
    );
    // 23:30 in Lagos is 22:30 UTC; the next boundary is 24:00 Lagos.
    expect(lagosNextDayStart(new Date('2026-10-15T22:30:00.000Z'))).toEqual(
      new Date('2026-10-15T23:00:00.000Z'),
    );
    expect(lagosNextDayStart(new Date('2026-10-15T23:00:00.000Z'))).toEqual(
      new Date('2026-10-16T23:00:00.000Z'),
    );
  });
});

describe('WALLET-23: W35 limits row', () => {
  it('is hidden (null) until a limit is known, and when the provider names none', async () => {
    const { accounts } = services();
    const a = await wallet();
    expect(await accounts.view(a, NOW)).toBeNull();
    await accounts.record(a, { tier: 'TIER_9', dailyKobo: null }, NOW);
    expect(await accounts.view(a, NOW)).toBeNull();
    expect(await accounts.view(randomUUID(), NOW)).toBeNull();
  });

  it('names no tier, shows the limit, what was used and what is left, and when it starts again', async () => {
    const { accounts } = services();
    const a = await wallet();
    await accounts.record(a, tier2, NOW);
    await ledger(a, [
      { category: 'transfer', amountKobo: 250_000, at: TODAY },
      { category: 'purchase', amountKobo: 100_000, at: TODAY },
    ]);
    expect(await accounts.view(a, NOW)).toEqual({
      tier: null,
      dailyLimitKobo: 1_000_000,
      usedTodayKobo: 350_000,
      remainingTodayKobo: 650_000,
      resetsAt: LAGOS_MIDNIGHT_TOMORROW.toISOString(),
    });
  });

  it('what is left never goes below zero (a limit lowered under what was moved)', async () => {
    const { accounts } = services();
    const a = await wallet();
    await accounts.record(a, { tier: 'TIER_1', dailyKobo: 100n }, NOW);
    await ledger(a, [{ category: 'transfer', amountKobo: 5000, at: TODAY }]);
    expect(await accounts.view(a, NOW)).toMatchObject({
      dailyLimitKobo: 100,
      usedTodayKobo: 5000,
      remainingTodayKobo: 0,
    });
  });
});

describe('WALLET-23: a debit over the limit is refused with the limit shown', () => {
  it('refuses 403 limit_reached, limit daily, with the limit and what is left, in the reason and the sentence', async () => {
    const { accounts, limits } = services();
    const a = await wallet();
    await accounts.record(a, tier2, NOW);
    await ledger(a, [{ category: 'transfer', amountKobo: 900_000, at: TODAY }]);
    const r = await refusal(
      limits.assertMayMove(
        { wawuUserId: a, kind: 'purchase', amountKobo: 100_001 },
        { now: NOW },
      ),
    );
    expect(r).toMatchObject({
      status: 403,
      code: 'limit_reached',
      limit: 'daily',
      limitKobo: 1_000_000,
      remainingTodayKobo: 100_000,
    });
    expect(r.message).toBe(
      'This would pass your daily limit of ₦10,000.00. You can still move ₦1,000.00 today.',
    );
    expect(r.message).not.toContain('—');
  });

  it('exactly the limit goes through; one kobo more does not; with nothing left it says to try tomorrow', async () => {
    const { accounts, limits } = services();
    const a = await wallet();
    await accounts.record(a, tier2, NOW);
    await ledger(a, [{ category: 'bill', amountKobo: 999_000, at: TODAY }]);
    await expect(
      limits.assertMayMove(
        { wawuUserId: a, kind: 'wawu_transfer', amountKobo: 1000 },
        { now: NOW },
      ),
    ).resolves.toBeUndefined();
    await ledger(a, [{ category: 'transfer', amountKobo: 1000, at: TODAY }]);
    const r = await refusal(
      limits.assertMayMove(
        { wawuUserId: a, kind: 'bank_transfer', amountKobo: 1 },
        { now: NOW },
      ),
    );
    expect(r).toMatchObject({
      limit: 'daily',
      limitKobo: 1_000_000,
      remainingTodayKobo: 0,
    });
    expect(r.message).toBe(
      'This would pass your daily limit of ₦10,000.00. Try again tomorrow.',
    );
  });

  it('counts every kind together: a bank send, a purchase and a bill share the one limit', async () => {
    const { accounts, limits } = services();
    const a = await wallet();
    await accounts.record(a, tier2, NOW);
    await ledger(a, [
      { category: 'transfer', amountKobo: 400_000, at: TODAY },
      { category: 'purchase', amountKobo: 400_000, at: TODAY },
    ]);
    for (const kind of [
      'wawu_transfer',
      'bank_transfer',
      'purchase',
      'bill',
    ] as const) {
      const r = await refusal(
        limits.assertMayMove(
          { wawuUserId: a, kind, amountKobo: 200_001 },
          { now: NOW },
        ),
      );
      expect(r.code).toBe('limit_reached');
      expect(r.remainingTodayKobo).toBe(200_000);
    }
  });

  it('inside a transaction it holds the person lock, so two movements at once cannot both pass the last of the limit', async () => {
    const { accounts, limits } = services();
    const a = await wallet();
    await accounts.record(a, tier2, NOW);
    await ledger(a, [{ category: 'transfer', amountKobo: 700_000, at: TODAY }]);
    // The flow every money-moving service follows: check, then write the
    // pending ledger row, in one transaction.
    const move = (amountKobo: number) =>
      prisma.$transaction(async (tx) => {
        await limits.assertMayMove(
          { wawuUserId: a, kind: 'purchase', amountKobo },
          { tx, now: NOW },
        );
        await tx.fintavaLedgerEntry.create({
          data: {
            walletKind: 'user',
            wawuUserId: a,
            accountNumber: nuban(),
            direction: 'out',
            status: 'pending',
            category: 'purchase',
            amountKobo: BigInt(amountKobo),
            feeKobo: 0n,
            totalKobo: BigInt(amountKobo),
            counterpartyKind: 'wawu',
            source: 'send',
            occurredAt: TODAY,
          },
        });
      });
    const done = await Promise.allSettled([
      move(200_000),
      move(200_000),
      move(200_000),
    ]);
    expect(done.filter((d) => d.status === 'fulfilled')).toHaveLength(1);
    for (const d of done.filter((x) => x.status === 'rejected')) {
      expect((d.reason as MoneyError).code).toBe('limit_reached');
    }
  });

  it('no limit on file, a provider that names none, or a person with no wallet: nothing is added to WAWU limits', async () => {
    const { accounts, limits } = services();
    const never = await wallet();
    const named = await wallet();
    await accounts.record(named, { tier: 'TIER_9', dailyKobo: null }, NOW);
    for (const who of [never, named, randomUUID()]) {
      await expect(
        limits.assertMayMove(
          { wawuUserId: who, kind: 'purchase', amountKobo: 900_000_000 },
          { now: NOW },
        ),
      ).resolves.toBeUndefined();
    }
  });

  it("another provider's wallet row is never held to this provider's copy", async () => {
    const { accounts } = services({}, 'nuvion');
    const a = await wallet('nuvion');
    await accounts.record(a, tier2, NOW);
    const asFintava = services({}, 'fintava').limits;
    await expect(
      asFintava.assertMayMove(
        { wawuUserId: a, kind: 'purchase', amountKobo: 9_000_000 },
        { now: NOW },
      ),
    ).resolves.toBeUndefined();
  });

  it("sits beside WAWU's own limits: the per-kind limit answers first when it is the tighter, the account's when it is", async () => {
    const own = services({ WAWU_LIMIT_PURCHASE_DAILY_KOBO: '500000' });
    const a = await wallet();
    await own.accounts.record(a, tier2, NOW);
    // WAWU's own purchase limit (500,000) is passed first.
    const r1 = await refusal(
      own.limits.assertMayMove(
        { wawuUserId: a, kind: 'purchase', amountKobo: 500_001 },
        { now: NOW },
      ),
    );
    expect(r1).toMatchObject({ limit: 'daily' });
    expect(r1.limitKobo).toBeUndefined();
    expect(r1.message).toContain('today');
    // A bank send has no limit of WAWU's, so only the account's applies.
    const r2 = await refusal(
      own.limits.assertMayMove(
        { wawuUserId: a, kind: 'bank_transfer', amountKobo: 1_000_001 },
        { now: NOW },
      ),
    );
    expect(r2).toMatchObject({ limit: 'daily', limitKobo: 1_000_000 });
  });

  it('a movement over the per-transaction limit is still that limit, not the account', async () => {
    const own = services({ WAWU_LIMIT_PURCHASE_PER_TRANSACTION_KOBO: '1000' });
    const a = await wallet();
    await own.accounts.record(a, tier2, NOW);
    const r = await refusal(
      own.limits.assertMayMove(
        { wawuUserId: a, kind: 'purchase', amountKobo: 1001 },
        { now: NOW },
      ),
    );
    expect(r.limit).toBe('per_transaction');
  });
});

describe('WALLET-23: the quote shows where the day stands', () => {
  it('remainingTodayKobo is the tighter of the account and WAWU’s own daily limit', async () => {
    const a = await wallet();
    const noOwn = services();
    await noOwn.accounts.record(a, tier2, NOW);
    await ledger(a, [{ category: 'transfer', amountKobo: 300_000, at: TODAY }]);
    expect(
      await noOwn.limits.dailyStanding(
        { wawuUserId: a, kind: 'purchase', amountKobo: 700_000 },
        NOW,
      ),
    ).toEqual({ withinDailyLimit: true, remainingTodayKobo: 700_000 });
    expect(
      await noOwn.limits.dailyStanding(
        { wawuUserId: a, kind: 'purchase', amountKobo: 700_001 },
        NOW,
      ),
    ).toEqual({ withinDailyLimit: false, remainingTodayKobo: 700_000 });
    // WAWU's own purchase limit is tighter here (200,000 left of it).
    const withOwn = services({ WAWU_LIMIT_PURCHASE_DAILY_KOBO: '200000' });
    expect(
      await withOwn.limits.dailyStanding(
        { wawuUserId: a, kind: 'purchase', amountKobo: 100 },
        NOW,
      ),
    ).toEqual({ withinDailyLimit: true, remainingTodayKobo: 200_000 });
    // And no limit known at all stays "no limit".
    const none = await wallet();
    expect(
      await noOwn.limits.dailyStanding(
        { wawuUserId: none, kind: 'purchase', amountKobo: 100 },
        NOW,
      ),
    ).toEqual({ withinDailyLimit: true, remainingTodayKobo: null });
  });
});
