import { randomUUID } from 'node:crypto';
import type { ArgumentsHost } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '../../../../generated/prisma/client';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { WalletProviderName } from '../../../wallet-provider/wallet-provider.interface';
import { limitConfigKey, MoneyLimitSettings } from '../money-limit-config';
import { type MovementInput, MoneyLimits } from '../money-limits.service';
import { NotInTransactionError, type MovementTx } from '../movement-tx';

/**
 * THE LIMITS LOCK ALWAYS RUNS IN A REAL TRANSACTION (task FIX-26; FIX-21
 * verifier finding F3; mobile repo BACKEND_GAPS G-410).
 *
 * The per-person lock `MoneyLimits.assertMayMove` takes is a transaction lock.
 * Called with no `tx`, it took none and read no isolation level (two movements
 * of 600 both passed a daily 1000, 20 rounds of 20). Called with the service's
 * own client as `tx` it compiled, passed the level check, and the lock ended
 * with its own statement (the same, 20 of 20). So `tx` is required, typed so
 * a root client does not fit, and refused at run time when it is not a
 * transaction client.
 *
 * Over a real Postgres ledger (DATABASE_URL, a test database). Nothing here
 * reaches a provider. The figures are the spec's own.
 */

const NOW = new Date('2026-10-15T10:00:00.000Z'); // 11:00 in Lagos
const TODAY = new Date('2026-10-15T09:00:00.000Z');
const DAILY_KOBO = 1000;
const EACH_KOBO = 600;
const ROUNDS = 20;

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
  return `7${String(Date.now()).slice(-5)}${String(seq).padStart(4, '0')}`;
}

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

function input(wawuUserId: string, amountKobo = EACH_KOBO): MovementInput {
  return { wawuUserId, kind: 'wawu_transfer', amountKobo };
}

async function written(wawuUserId: string): Promise<number> {
  const sum = await prisma.fintavaLedgerEntry.aggregate({
    _sum: { amountKobo: true },
    where: { wawuUserId },
  });
  return Number(sum._sum.amountKobo ?? 0n);
}

/** What a check given this as `tx` throws, or undefined when it passes. */
function refusedWith(
  run: (tx: MovementTx) => Promise<void>,
  tx: unknown,
): Promise<unknown> {
  return run(tx as MovementTx).then(
    () => undefined,
    (e: unknown) => e,
  );
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

/**
 * Never called: tsc is the check. `@ts-expect-error` fails the build if the
 * line under it compiles, so a signature that lets the root client or no
 * transaction through again is caught.
 */
function compileTimeOnly(l: MoneyLimits, a: string): void {
  // @ts-expect-error no transaction at all
  void l.assertMayMove(input(a));
  // @ts-expect-error options without a transaction
  void l.assertMayMove(input(a), { now: NOW });
  // @ts-expect-error the service's own client is not a transaction
  void l.assertMayMove(input(a), { tx: prisma });
  // @ts-expect-error a PrismaService is a PrismaClient, not a transaction
  void l.assertMayMove(input(a), { tx: new PrismaService() });
  // @ts-expect-error the limits alone need the transaction too
  void l.assertWithinLimits(input(a));
  // @ts-expect-error and not the service's own client either
  void l.assertWithinLimits(input(a), { tx: prisma });
  // What every paying service writes compiles.
  void prisma.$transaction((tx) => l.assertMayMove(input(a), { tx }));
}

describe('FIX-26: the transaction is required', () => {
  it('the types refuse no transaction and the root client, and accept the tx of $transaction (checked by tsc)', () => {
    expect(typeof compileTimeOnly).toBe('function');
  });

  it("the premise: the client Prisma gives a transaction has none of a root client's connect methods, and the root client has them", async () => {
    expect(typeof (prisma as { $connect?: unknown }).$connect).toBe('function');
    expect(typeof (prisma as { $disconnect?: unknown }).$disconnect).toBe(
      'function',
    );
    const inside = await prisma.$transaction((tx) =>
      Promise.resolve([
        typeof (tx as { $connect?: unknown }).$connect,
        typeof (tx as { $disconnect?: unknown }).$disconnect,
      ]),
    );
    expect(inside).toEqual(['undefined', 'undefined']);
  });

  it('with no transaction, or not an object that is one, a check refuses with NotInTransactionError naming it missing', async () => {
    const a = person();
    for (const check of [
      (l: MoneyLimits, tx: MovementTx) =>
        l.assertMayMove(input(a), { tx, now: NOW }),
      (l: MoneyLimits, tx: MovementTx) =>
        l.assertWithinLimits(input(a), { tx, now: NOW }),
    ]) {
      for (const tx of [undefined, null]) {
        const refused = await refusedWith((t) => check(limits(DAILY), t), tx);
        expect(refused).toBeInstanceOf(NotInTransactionError);
        expect((refused as NotInTransactionError).reason).toBe('missing');
      }
    }
    // A JavaScript caller that forgets the options object altogether.
    const noOptions = await (
      limits(DAILY).assertMayMove as unknown as (
        i: MovementInput,
      ) => Promise<void>
    )
      .call(limits(DAILY), input(a))
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(noOptions).toBeInstanceOf(NotInTransactionError);
  });

  it("given the service's own client, or any other root client, a check refuses naming root_client (a cast gets past the types, not this)", async () => {
    const a = person();
    const other = new PrismaService();
    const extended = prisma.$extends({});
    try {
      for (const tx of [prisma, other, extended]) {
        for (const check of [
          (l: MoneyLimits, t: MovementTx) =>
            l.assertMayMove(input(a), { tx: t, now: NOW }),
          (l: MoneyLimits, t: MovementTx) =>
            l.assertWithinLimits(input(a), { tx: t, now: NOW }),
        ]) {
          const refused = await refusedWith((t) => check(limits(DAILY), t), tx);
          expect(refused).toBeInstanceOf(NotInTransactionError);
          expect((refused as NotInTransactionError).reason).toBe('root_client');
          expect((refused as Error).message).toContain('tx');
        }
      }
    } finally {
      await other.$disconnect();
    }
  });

  it("a stand-in for the service's own client is refused as well: the check compares it with the one it was built with", async () => {
    // No `$connect`, so only the comparison with its own client can refuse it.
    const standIn = {} as unknown as PrismaService;
    const config = new ConfigService(DAILY);
    const l = new MoneyLimits(
      new MoneyLimitSettings(config),
      standIn,
      { name: 'fintava' },
      config,
    );
    const refused = await refusedWith(
      (tx) => l.assertMayMove(input(person()), { tx, now: NOW }),
      standIn,
    );
    expect(refused).toBeInstanceOf(NotInTransactionError);
    expect((refused as NotInTransactionError).reason).toBe('root_client');
  });

  it('it is refused before anything is locked, read or written, and before fees_not_set: no statement reaches the database', async () => {
    const a = person();
    const statements = [
      jest.spyOn(prisma, '$executeRaw'),
      jest.spyOn(prisma, '$queryRaw'),
      jest.spyOn(prisma.fintavaLedgerEntry, 'aggregate'),
    ];
    try {
      // Under nuvion with every fee unset the answer would be fees_not_set.
      const refused = await refusedWith(
        (t) => limits(DAILY, 'nuvion').assertMayMove(input(a), { tx: t }),
        prisma,
      );
      expect(refused).toBeInstanceOf(NotInTransactionError);
      expect(statements.map((s) => s.mock.calls.length)).toEqual([0, 0, 0]);
    } finally {
      for (const s of statements) s.mockRestore();
    }
    expect(await written(a)).toBe(0);
  });

  it('a real transaction passes, whatever limits are set', async () => {
    const a = person();
    for (const env of [DAILY, {}]) {
      await expect(
        prisma.$transaction((tx) =>
          limits(env).assertMayMove(input(a), { tx, now: NOW }),
        ),
      ).resolves.toBeUndefined();
    }
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
    filter.catch(new NotInTransactionError('root_client'), host);
    quiet.mockRestore();
    expect(status).toBe(500);
    expect(JSON.stringify(body)).not.toMatch(/transaction|MoneyLimits|lock/i);
  });
});

/**
 * Why the requirement exists, shown through the service's own client: two
 * movements at once, each checked and then written as a paying service
 * would, with the check given the root client by a cast. Before FIX-26 both
 * passed every round (1200 written against a daily 1000); now both are
 * refused before anything is written.
 */
describe("FIX-26: two movements at once through the service's own client are both refused (they used to both pass)", () => {
  function movement(
    l: MoneyLimits,
    wawuUserId: string,
    tx: unknown,
  ): Promise<void> {
    return (async () => {
      await l.assertMayMove(input(wawuUserId), {
        tx: tx as MovementTx,
        now: NOW,
      });
      await new Promise((r) => setTimeout(r, 100));
      await prisma.fintavaLedgerEntry.create({
        data: pendingSend(wawuUserId, EACH_KOBO),
      });
    })();
  }

  it.each([
    ["the service's own client", () => prisma],
    ['undefined', () => undefined],
  ])(
    `${ROUNDS} rounds with %s: both refused every round, nothing written`,
    async (_name, tx) => {
      const rounds: string[] = [];
      for (let i = 0; i < ROUNDS; i += 1) {
        const a = person();
        const l = limits(DAILY);
        const results = await Promise.allSettled([
          movement(l, a, tx()),
          movement(l, a, tx()),
        ]);
        rounds.push(
          `${results
            .map((r) =>
              r.status === 'rejected' &&
              r.reason instanceof NotInTransactionError
                ? r.reason.reason
                : r.status,
            )
            .join(',')} ${await written(a)}`,
        );
      }
      const expected = tx() === undefined ? 'missing' : 'root_client';
      expect(rounds).toEqual(
        Array.from({ length: ROUNDS }, () => `${expected},${expected} 0`),
      );
    },
    120_000,
  );
});
