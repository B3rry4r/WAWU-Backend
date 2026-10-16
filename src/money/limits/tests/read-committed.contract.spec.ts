import { randomUUID } from 'node:crypto';
import type { ArgumentsHost } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '../../../../generated/prisma/client';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { WalletProviderName } from '../../../wallet-provider/wallet-provider.interface';
import type { MoneyErrorReason } from '../../dto/money-error.dto';
import { NUVION_FEE_CONFIG_KEYS } from '../../fees/nuvion-fee-config';
import { MoneyError } from '../../money-error';
import { limitConfigKey, MoneyLimitSettings } from '../money-limit-config';
import { MoneyLimits } from '../money-limits.service';
import {
  IsolationLevelError,
  REQUIRED_ISOLATION_LEVEL,
} from '../read-committed';

/**
 * THE LIMITS LOCK NAMES ITS ISOLATION LEVEL (task FIX-21, NUV-07 verifier
 * finding 4; mobile repo BACKEND_GAPS G-410).
 *
 * `MoneyLimits.assertMayMove` takes a per-person advisory lock in the
 * caller's transaction and then counts what the person moved today. That
 * orders two movements only under READ COMMITTED, Prisma's default. Under
 * REPEATABLE READ both of two movements of 600 against a daily 1000 passed
 * (1200 written); under SERIALIZABLE one failed with a write conflict, not
 * `limit_reached`. So the check now reads the transaction's own level and
 * refuses any other, naming it, before it locks, reads or writes anything.
 *
 * Over a real Postgres ledger (DATABASE_URL, a test database). Nothing here
 * reaches a provider. The figures are the spec's own.
 */

const NOW = new Date('2026-10-15T10:00:00.000Z'); // 11:00 in Lagos
const TODAY = new Date('2026-10-15T09:00:00.000Z');

const DAILY_KOBO = 1000;
const EACH_KOBO = 600;
const ROUNDS = 50;

const LEVELS = Prisma.TransactionIsolationLevel;

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
  return `8${String(Date.now()).slice(-5)}${String(seq).padStart(4, '0')}`;
}

/** A pending send to a WAWU user out of this person's wallet, as a paying service writes it. */
function pendingSend(
  wawuUserId: string,
  amountKobo: number,
): Prisma.FintavaLedgerEntryUncheckedCreateInput {
  return {
    walletKind: 'user',
    wawuUserId,
    accountNumber: nuban(),
    direction: 'out',
    status: 'pending',
    category: 'transfer',
    amountKobo: BigInt(amountKobo),
    feeKobo: 0n,
    totalKobo: BigInt(amountKobo),
    counterpartyKind: 'wawu_user',
    source: 'send',
    occurredAt: TODAY,
  };
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

const DAILY = {
  [limitConfigKey('wawu_transfer', 'daily')]: String(DAILY_KOBO),
};

/**
 * One movement as every paying service makes it (CONVENTIONS section 11):
 * the check in the transaction that writes the pending row, then the row.
 * The pause stands for the service's own work in between (the quote check,
 * the Idempotency-Key record), long enough for the other movement to check.
 */
function movement(
  l: MoneyLimits,
  wawuUserId: string,
  isolationLevel?: Prisma.TransactionIsolationLevel,
): Promise<void> {
  return prisma.$transaction(
    async (tx) => {
      await l.assertMayMove(
        { wawuUserId, kind: 'wawu_transfer', amountKobo: EACH_KOBO },
        { tx, now: NOW },
      );
      await new Promise((r) => setTimeout(r, 100));
      await tx.fintavaLedgerEntry.create({
        data: pendingSend(wawuUserId, EACH_KOBO),
      });
    },
    { timeout: 20_000, ...(isolationLevel ? { isolationLevel } : {}) },
  );
}

async function written(wawuUserId: string): Promise<number> {
  const sum = await prisma.fintavaLedgerEntry.aggregate({
    _sum: { amountKobo: true },
    where: { wawuUserId },
  });
  return Number(sum._sum.amountKobo ?? 0n);
}

function reasonOf(e: unknown): MoneyErrorReason | undefined {
  return e instanceof MoneyError
    ? (e.getResponse() as { reason: MoneyErrorReason }).reason
    : undefined;
}

/** Two movements of 600 at once by one person, against a daily 1000. */
async function twoAtOnce(
  isolationLevel?: Prisma.TransactionIsolationLevel,
): Promise<{ results: PromiseSettledResult<void>[]; kobo: number }> {
  const a = person();
  const l = limits(DAILY);
  const results = await Promise.allSettled([
    movement(l, a, isolationLevel),
    movement(l, a, isolationLevel),
  ]);
  return { results, kobo: await written(a) };
}

beforeAll(() => {
  prisma = new PrismaService();
});

afterAll(async () => {
  await prisma.fintavaLedgerEntry.deleteMany({
    where: { wawuUserId: { in: users } },
  });
  await prisma.$disconnect();
});

describe('FIX-21: under READ COMMITTED two movements never pass one limit together', () => {
  it(`Prisma's default level is READ COMMITTED here, and the check passes it`, async () => {
    const level = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{ level: string }>
      >`SELECT current_setting('transaction_isolation') AS level`;
      return rows[0].level;
    });
    expect(level).toBe(REQUIRED_ISOLATION_LEVEL);
    const a = person();
    await expect(
      prisma.$transaction((tx) =>
        limits(DAILY).assertMayMove(
          { wawuUserId: a, kind: 'wawu_transfer', amountKobo: EACH_KOBO },
          { tx, now: NOW },
        ),
      ),
    ).resolves.toBeUndefined();
  });

  it(`${ROUNDS} rounds at the default level: each time one of two movements of ${EACH_KOBO} passes a daily ${DAILY_KOBO}, the other is limit_reached naming daily, and ${EACH_KOBO} is written`, async () => {
    const rounds: string[] = [];
    for (let i = 0; i < ROUNDS; i += 1) {
      const { results, kobo } = await twoAtOnce();
      const passed = results.filter((r) => r.status === 'fulfilled').length;
      const refusals = results
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map((r) => reasonOf(r.reason));
      rounds.push(
        `${passed} passed, ${refusals.map((x) => (x ? `${x.code}:${x.limit}` : 'other')).join(',')}, ${kobo} written`,
      );
    }
    expect(rounds).toEqual(
      Array.from(
        { length: ROUNDS },
        () => `1 passed, limit_reached:daily, ${EACH_KOBO} written`,
      ),
    );
  }, 180_000);

  it('the same when the caller names READ COMMITTED itself (20 rounds)', async () => {
    for (let i = 0; i < 20; i += 1) {
      const { results, kobo } = await twoAtOnce(LEVELS.ReadCommitted);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(kobo).toBe(EACH_KOBO);
    }
  }, 120_000);
});

describe('FIX-21: at any other level the check refuses, naming the level, before it locks, reads or writes', () => {
  const OTHER: Array<[Prisma.TransactionIsolationLevel, string]> = [
    [LEVELS.RepeatableRead, 'repeatable read'],
    [LEVELS.Serializable, 'serializable'],
    [LEVELS.ReadUncommitted, 'read uncommitted'],
  ];

  it.each(OTHER)(
    'in a %s transaction: IsolationLevelError naming "%s", with or without a limit set',
    async (isolationLevel, named) => {
      for (const env of [DAILY, {}]) {
        const a = person();
        const refused = await prisma
          .$transaction(
            (tx) =>
              limits(env).assertMayMove(
                { wawuUserId: a, kind: 'wawu_transfer', amountKobo: EACH_KOBO },
                { tx, now: NOW },
              ),
            { isolationLevel },
          )
          .then(
            () => undefined,
            (e: unknown) => e,
          );
        expect(refused).toBeInstanceOf(IsolationLevelError);
        expect((refused as IsolationLevelError).level).toBe(named);
        expect((refused as Error).message).toContain(`"${named}"`);
        expect((refused as Error).message).toContain('READ COMMITTED');
      }
    },
  );

  it.each([
    [LEVELS.RepeatableRead, 'repeatable read'],
    [LEVELS.Serializable, 'serializable'],
  ])(
    'two movements at once in %s transactions: both refused, nothing written (where both used to pass)',
    async (isolationLevel, named) => {
      const { results, kobo } = await twoAtOnce(isolationLevel);
      expect(
        results.map((r) =>
          r.status === 'rejected' && r.reason instanceof IsolationLevelError
            ? r.reason.level
            : r.status,
        ),
      ).toEqual([named, named]);
      expect(kobo).toBe(0);
    },
  );

  it('reads the level of the transaction itself: one raised by SET TRANSACTION inside a default transaction is refused too', async () => {
    const a = person();
    const refused = await prisma
      .$transaction(async (tx) => {
        await tx.$executeRaw`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`;
        await limits(DAILY).assertMayMove(
          { wawuUserId: a, kind: 'wawu_transfer', amountKobo: EACH_KOBO },
          { tx, now: NOW },
        );
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(refused).toBeInstanceOf(IsolationLevelError);
    expect((refused as IsolationLevelError).level).toBe('repeatable read');
  });

  it('fees_not_set still comes first, before any read (NUV-07): under nuvion with no fee set, at any level', async () => {
    const a = person();
    const refused = await prisma
      .$transaction(
        (tx) =>
          limits(DAILY, 'nuvion').assertMayMove(
            { wawuUserId: a, kind: 'wawu_transfer', amountKobo: EACH_KOBO },
            { tx, now: NOW },
          ),
        { isolationLevel: LEVELS.Serializable },
      )
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(reasonOf(refused)?.code).toBe('fees_not_set');
    const withFees = limits(
      {
        ...DAILY,
        [NUVION_FEE_CONFIG_KEYS.bookTransfer]: '0',
        [NUVION_FEE_CONFIG_KEYS.bankPayout]: '0',
        [NUVION_FEE_CONFIG_KEYS.inflow]: '0',
      },
      'nuvion',
    );
    const thenLevel = await prisma
      .$transaction(
        (tx) =>
          withFees.assertMayMove(
            { wawuUserId: a, kind: 'wawu_transfer', amountKobo: EACH_KOBO },
            { tx, now: NOW },
          ),
        { isolationLevel: LEVELS.Serializable },
      )
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(thenLevel).toBeInstanceOf(IsolationLevelError);
  });

  it('is a programming error, never an answer a person reads: the global filter makes it a 500 without its text', () => {
    let status = 0;
    let body: unknown;
    const res: {
      status: (code: number) => unknown;
      json: (b: unknown) => unknown;
    } = {
      status: (code: number) => {
        status = code;
        return res;
      },
      json: (b: unknown) => {
        body = b;
        return res;
      },
    };
    const host = {
      switchToHttp: () => ({
        getResponse: () => res,
        getRequest: () => ({ url: '/api/hub/money/payments', method: 'POST' }),
      }),
    } as unknown as ArgumentsHost;
    const filter = new AllExceptionsFilter();
    const quiet = jest
      .spyOn(
        (filter as unknown as { logger: { error: () => void } }).logger,
        'error',
      )
      .mockImplementation(() => undefined);
    filter.catch(new IsolationLevelError('repeatable read'), host);
    quiet.mockRestore();
    expect(status).toBe(500);
    expect(JSON.stringify(body)).not.toMatch(/repeatable|READ COMMITTED/i);
  });
});

/**
 * Why the check exists, shown without it: the same lock and the same count
 * the service makes, in a REPEATABLE READ or SERIALIZABLE transaction. If
 * either of these ever stops holding (a Postgres change), the reason for
 * the check is worth reading again; the check itself stays.
 */
describe('FIX-21: the reason, the lock alone at the other levels (NUV-07 verifier finding 4)', () => {
  function unchecked(
    l: MoneyLimits,
    wawuUserId: string,
    isolationLevel: Prisma.TransactionIsolationLevel,
  ): Promise<void> {
    return prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`money-limits:${wawuUserId}`}, 0))`;
        const used = await l.movedSince(
          tx,
          { wawuUserId, kind: 'wawu_transfer' },
          new Date('2026-10-14T23:00:00.000Z'),
        );
        if (used + BigInt(EACH_KOBO) > BigInt(DAILY_KOBO)) {
          throw new Error('limit');
        }
        await new Promise((r) => setTimeout(r, 300));
        await tx.fintavaLedgerEntry.create({
          data: pendingSend(wawuUserId, EACH_KOBO),
        });
      },
      { timeout: 20_000, isolationLevel },
    );
  }

  it(`REPEATABLE READ: both movements of ${EACH_KOBO} pass a daily ${DAILY_KOBO}`, async () => {
    const a = person();
    const l = limits(DAILY);
    const results = await Promise.allSettled([
      unchecked(l, a, LEVELS.RepeatableRead),
      unchecked(l, a, LEVELS.RepeatableRead),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(await written(a)).toBe(2 * EACH_KOBO);
  });

  it('SERIALIZABLE: one fails, and with a write conflict, not with the limit', async () => {
    const a = person();
    const l = limits(DAILY);
    const results = await Promise.allSettled([
      unchecked(l, a, LEVELS.Serializable),
      unchecked(l, a, LEVELS.Serializable),
    ]);
    const failed = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(failed).toHaveLength(1);
    expect((failed[0].reason as Error).message).not.toBe('limit');
    expect(await written(a)).toBe(EACH_KOBO);
  });
});
