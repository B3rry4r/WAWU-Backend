import { randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WalletProviderError } from '../../wallet-provider/wallet-provider-error';
import type { ProviderFxAccount } from '../../wallet-provider/wallet-provider-fx';
import {
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import {
  AccountDeletionBlockedError,
  AccountDeletionMoneyService,
  DELETION_BLOCKERS,
} from '../account-deletion-money.service';

/**
 * R-17: the wallet must be empty before an account is deleted. The naira
 * wallet was always checked; money in a foreign-currency account (WALLET-21)
 * or in a Capital order (NUV-12) was not, so a person could delete the
 * account and the purge dropped the only link to that money. These specs pin
 * the five blockers that close it:
 *
 *   fx_balance             a foreign account holds money (the provider's balance)
 *   fx_balance_unreadable  a foreign account could not be read: not "empty"
 *   fx_operation_pending   a swap or a send has no final answer
 *   capital_holding        a Capital holding is not closed (held or paying out)
 *   capital_order_pending  a Capital order is reserved, confirming or in review
 *
 * The provider is a stand-in that answers the foreign-account read from a
 * table the test fills, and counts what it was asked. Nothing here touches a
 * real provider.
 */

describe('Deleting an account with money in foreign accounts or Capital (R-17)', () => {
  const people: string[] = [];
  let prisma: PrismaService;
  let money: AccountDeletionMoneyService;
  let close: () => Promise<void>;

  /** What the stand-in answers per provider account id; absent: the read fails. */
  const balances = new Map<string, { available: bigint; booked: bigint }>();
  const asked: string[] = [];
  let withFx = true;

  function account(id: string): ProviderFxAccount {
    const b = balances.get(id);
    if (!b) {
      throw new WalletProviderError({
        kind: 'unavailable',
        provider: 'nuvion',
        operation: 'read foreign account',
      });
    }
    return {
      accountId: id,
      currency: 'USD',
      ban: null,
      availableMinor: b.available,
      bookedMinor: b.booked,
    };
  }

  beforeAll(async () => {
    const provider = {
      name: 'nuvion',
      label: 'Nuvion',
      configured: true,
      timings: { retryAfterSeconds: 5 },
      getBalance: () => Promise.resolve({ availableKobo: 0n, bookedKobo: 0n }),
      get fx() {
        return withFx
          ? {
              readAccount: (_person: unknown, id: string) => {
                asked.push(id);
                try {
                  return Promise.resolve(account(id));
                } catch (e) {
                  return Promise.reject(
                    e instanceof Error ? e : new Error('read failed'),
                  );
                }
              },
            }
          : undefined;
      },
    } as unknown as WalletProvider;
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule],
      providers: [
        AccountDeletionMoneyService,
        { provide: WALLET_PROVIDER, useValue: provider },
      ],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    money = moduleRef.get(AccountDeletionMoneyService);
    close = () => moduleRef.close();
  });

  afterEach(() => {
    balances.clear();
    asked.length = 0;
    withFx = true;
  });

  afterAll(async () => {
    await prisma.capitalOrder.deleteMany({
      where: { wawuUserId: { in: people } },
    });
    await prisma.fxOperation.deleteMany({
      where: { wawuUserId: { in: people } },
    });
    await prisma.fxAccount.deleteMany({
      where: { wawuUserId: { in: people } },
    });
    await prisma.fintavaWallet.deleteMany({
      where: { wawuUserId: { in: people } },
    });
    await close();
  });

  /** A person with a Nuvion naira wallet (the stand-in says it is empty). */
  async function person(): Promise<string> {
    const id = randomUUID();
    people.push(id);
    const tag = id.replace(/-/g, '');
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId: id,
        customerId: `cust-${tag}`,
        walletId: `wal-${tag}`,
        accountNumber: tag.slice(0, 10),
        provider: 'nuvion',
      },
    });
    return id;
  }

  /** A foreign account the provider has made, and what it says it holds. */
  async function usd(
    wawuUserId: string,
    held: { available: bigint; booked?: bigint } | null,
    over: {
      provider?: string;
      providerAccountId?: string | null;
      currency?: string;
    } = {},
  ): Promise<string> {
    const providerAccountId =
      over.providerAccountId === undefined
        ? `acct-${randomUUID()}`
        : over.providerAccountId;
    await prisma.fxAccount.create({
      data: {
        wawuUserId,
        currency: over.currency ?? 'USD',
        providerCustomerId: 'cust-x',
        providerAccountId,
        status: 'open',
        ...(over.provider ? { provider: over.provider } : {}),
      },
    });
    if (held && providerAccountId) {
      balances.set(providerAccountId, {
        available: held.available,
        booked: held.booked ?? held.available,
      });
    }
    return providerAccountId ?? '';
  }

  async function operation(
    wawuUserId: string,
    status: 'pending' | 'completed' | 'failed',
    extra: { feeLeg?: string } = {},
  ) {
    await prisma.fxOperation.create({
      data: {
        wawuUserId,
        kind: 'swap',
        status,
        reference: `wawu-fx-test-${randomUUID()}`,
        fromCurrency: 'USD',
        toCurrency: 'NGN',
        amountFromMinor: 5_000n,
        day: '2026-10-24',
        ...extra,
      },
    });
  }

  async function order(
    wawuUserId: string,
    state: string,
    over: {
      lifecycle?: string | null;
      expiresAt?: Date | null;
    } = {},
  ) {
    await prisma.capitalOrder.create({
      data: {
        wawuUserId,
        reserveKey: randomUUID(),
        fingerprint: 'f'.repeat(64),
        state,
        productId: 'prod-1',
        productName: 'Fixed return',
        productType: 'FIXED_RETURN',
        currency: 'NGN',
        amountMinor: 1_000_000n,
        lifecycle: over.lifecycle ?? null,
        expiresAt: over.expiresAt ?? null,
      },
    });
  }

  /** The sentence for a person; `nairaWallet: false` is a person with a wallet outside Nigeria (no naira account). */
  const message = (blockers: string[], nairaWallet = true): string => {
    const refused = new AccountDeletionBlockedError({
      blockers: blockers as never,
      balanceKobo: 0,
      openHolds: 0,
      waitingEarnings: 0,
      wallet: nairaWallet ? { walletId: 'W1', provider: 'nuvion' } : null,
    });
    const body = refused.getResponse() as { message: string };
    expect(refused.getStatus()).toBe(409);
    expect(body.message).not.toMatch(/[–—]/);
    return body.message;
  };

  it('lists the five new blockers beside the old ones', () => {
    expect(DELETION_BLOCKERS).toEqual(
      expect.arrayContaining([
        'wallet_balance',
        'fx_balance',
        'fx_balance_unreadable',
        'fx_operation_pending',
        'capital_holding',
        'capital_order_pending',
      ]),
    );
  });

  describe('foreign accounts', () => {
    it('an account that holds money blocks: fx_balance, from the provider', async () => {
      const p = await person();
      const id = await usd(p, { available: 12_000n });
      const check = await money.check(p);
      expect(check.blockers).toEqual(['fx_balance']);
      expect(asked).toEqual([id]);
    });

    it('money that is only booked (not yet spendable) blocks too', async () => {
      const p = await person();
      await usd(p, { available: 0n, booked: 300n });
      expect((await money.check(p)).blockers).toEqual(['fx_balance']);
    });

    it('accounts that are all empty block nobody', async () => {
      const p = await person();
      await usd(p, { available: 0n, booked: 0n });
      await usd(p, { available: 0n, booked: 0n }, { currency: 'EUR' });
      expect((await money.check(p)).blockers).toEqual([]);
      expect(asked).toHaveLength(2);
    });

    it('a read that fails blocks with its own reason, never a guess that it is empty', async () => {
      const p = await person();
      await usd(p, null);
      const check = await money.check(p);
      expect(check.blockers).toEqual(['fx_balance_unreadable']);
    });

    it('one account with money and one that cannot be read give both reasons', async () => {
      const p = await person();
      await usd(p, { available: 100n });
      await usd(p, null, { currency: 'EUR' });
      expect((await money.check(p)).blockers).toEqual([
        'fx_balance',
        'fx_balance_unreadable',
      ]);
    });

    it('a provider that holds no foreign accounts cannot say an account is empty', async () => {
      const p = await person();
      await usd(p, { available: 0n });
      withFx = false;
      expect((await money.check(p)).blockers).toEqual([
        'fx_balance_unreadable',
      ]);
    });

    it("an account of another provider is not asked about and does not block: a server acts only on its own provider's rows (SWEEP-MONEY-6)", async () => {
      const p = await person();
      await usd(p, { available: 0n }, { provider: 'fintava' });
      const check = await money.check(p);
      expect(check.blockers).toEqual([]);
      expect(asked).toEqual([]);
      // Beside an account of this server's provider, only that one is read.
      const own = await usd(p, { available: 5n });
      expect((await money.check(p)).blockers).toEqual(['fx_balance']);
      expect(asked).toEqual([own]);
    });

    it('an account the provider has not made yet is not read and blocks nobody', async () => {
      const p = await person();
      await usd(p, null, { providerAccountId: null });
      expect((await money.check(p)).blockers).toEqual([]);
      expect(asked).toEqual([]);
    });

    it("another person's money blocks nobody else", async () => {
      const rich = await person();
      await usd(rich, { available: 9_000n });
      const other = await person();
      expect((await money.check(other)).blockers).toEqual([]);
    });

    it('a person with no foreign account is not asked anything', async () => {
      const p = await person();
      expect((await money.check(p)).blockers).toEqual([]);
      expect(asked).toEqual([]);
    });
  });

  describe('swaps and sends', () => {
    it('a swap or send with no final answer blocks: fx_operation_pending', async () => {
      const p = await person();
      await operation(p, 'pending');
      expect((await money.check(p)).blockers).toEqual(['fx_operation_pending']);
    });

    it('a finished or failed one does not', async () => {
      const p = await person();
      await operation(p, 'completed');
      await operation(p, 'failed');
      expect((await money.check(p)).blockers).toEqual([]);
    });

    it("another person's pending operation does not", async () => {
      const a = await person();
      await operation(a, 'pending');
      expect((await money.check(await person())).blockers).toEqual([]);
    });
  });

  describe('Capital', () => {
    it.each([
      [
        'a live reservation',
        'reserved',
        { expiresAt: new Date(Date.now() + 600_000) },
      ],
      ['a reservation the provider has not answered', 'reserving', {}],
      ['a confirmation with no final answer', 'confirming', {}],
      ['an order held for review', 'review', {}],
    ])('%s blocks: capital_order_pending', async (_name, state, over) => {
      const p = await person();
      await order(p, state, over);
      expect((await money.check(p)).blockers).toEqual([
        'capital_order_pending',
      ]);
    });

    it('a reservation past its time is expired, not a blocker', async () => {
      const p = await person();
      await order(p, 'reserved', { expiresAt: new Date(Date.now() - 1_000) });
      expect((await money.check(p)).blockers).toEqual([]);
    });

    it.each([
      ['a holding that is active', 'ACTIVE'],
      ['a holding that has matured and is not withdrawn', 'MATURED'],
      ['a holding being liquidated early', 'EARLY_LIQUIDATING'],
      ['a holding being closed', 'CLOSING'],
      ['a holding whose state has not been read yet', null],
    ])('%s blocks: capital_holding', async (_name, lifecycle) => {
      const p = await person();
      await order(p, 'confirmed', { lifecycle });
      expect((await money.check(p)).blockers).toEqual(['capital_holding']);
    });

    it.each(['WITHDRAWN', 'CLOSED', 'REFUNDED'])(
      'a holding that is %s is closed and blocks nobody',
      async (lifecycle) => {
        const p = await person();
        await order(p, 'confirmed', { lifecycle });
        expect((await money.check(p)).blockers).toEqual([]);
      },
    );

    it.each(['expired', 'rejected', 'cancelled', 'failed'])(
      'an order that is %s never took money and blocks nobody',
      async (state) => {
        const p = await person();
        await order(p, state);
        expect((await money.check(p)).blockers).toEqual([]);
      },
    );

    it("another person's order blocks nobody else", async () => {
      const holder = await person();
      await order(holder, 'confirmed', { lifecycle: 'ACTIVE' });
      expect((await money.check(await person())).blockers).toEqual([]);
    });

    it('a holding blocks a person who has no wallet at all', async () => {
      const id = randomUUID();
      people.push(id);
      await order(id, 'confirmed', { lifecycle: 'ACTIVE' });
      const check = await money.check(id);
      expect(check.blockers).toEqual(['capital_holding']);
      expect(check.wallet).toBeNull();
    });
  });

  describe('what the person is told', () => {
    it('each new blocker says what to do, in plain words, with no long dash', () => {
      const fx = message(['fx_balance']);
      expect(fx).toMatch(/other currency accounts/i);
      expect(fx).toMatch(/move|swap|send|withdraw/i);

      const unread = message(['fx_balance_unreadable']);
      expect(unread).toMatch(/could not/i);
      expect(unread).toMatch(/try again/i);

      const inFlight = message(['fx_operation_pending']);
      expect(inFlight).toMatch(/still going through/i);

      const holding = message(['capital_holding']);
      expect(holding).toMatch(/Capital/);
      expect(holding).toMatch(/withdraw/i);
      expect(holding).toMatch(/wait/i);

      const pending = message(['capital_order_pending']);
      expect(pending).toMatch(/Capital/);
      expect(pending).toMatch(/try again/i);
    });

    it('G-WALLET-41-6: a person with no naira account is never told to swap into naira, a person with one still is', () => {
      const abroad = message(['fx_balance'], false);
      expect(abroad).not.toMatch(/naira|swap/i);
      expect(abroad).toMatch(/send it out/i);
      expect(abroad).toMatch(/delete your account/i);
      const home = message(['fx_balance']);
      expect(home).toMatch(/swap it to naira/i);
      // The unreadable and waiting sentences do not mention naira for either person.
      expect(message(['fx_balance_unreadable'], false)).not.toMatch(/naira/i);
    });

    it('a set that holds an account which could not be read says try again beside the rest, never only "on its way"', () => {
      const tryAgain = message(['fx_balance_unreadable']);
      const wait = message(['open_hold']);
      expect(wait).toMatch(/on its way/i);
      const mixed = message(['fx_balance_unreadable', 'open_hold']);
      expect(mixed).toContain(wait);
      expect(mixed).toContain(tryAgain);
      expect(mixed).toMatch(/try again/i);
      // The order the blockers come in does not change the words.
      expect(message(['open_hold', 'fx_balance_unreadable'])).toBe(mixed);
      // An in-flight swap and an unreadable account: both said.
      const flight = message(['fx_operation_pending', 'fx_balance_unreadable']);
      expect(flight).toContain(message(['fx_operation_pending']));
      expect(flight).toContain(tryAgain);
      // Money that can be moved still leads, with the unreadable account said after it.
      const money2 = message(['fx_balance', 'fx_balance_unreadable']);
      expect(money2.startsWith(message(['fx_balance']))).toBe(true);
      expect(money2).toContain(tryAgain);
      expect(
        message(['wallet_balance', 'fx_balance_unreadable']).startsWith(
          message(['wallet_balance']),
        ),
      ).toBe(true);
    });

    it('the wallet balance still leads, then the foreign accounts, then Capital', () => {
      const naira = message(['wallet_balance']);
      expect(message(['capital_holding', 'fx_balance', 'wallet_balance'])).toBe(
        naira,
      );
      expect(message(['capital_holding', 'fx_balance'])).toBe(
        message(['fx_balance']),
      );
      expect(message(['capital_order_pending', 'capital_holding'])).toBe(
        message(['capital_holding']),
      );
    });

    it('the reason carries the blockers for the app', () => {
      const refused = new AccountDeletionBlockedError({
        blockers: ['capital_holding', 'fx_balance_unreadable'],
        balanceKobo: 0,
        openHolds: 0,
        waitingEarnings: 0,
        wallet: null,
      });
      const body = refused.getResponse() as {
        reason: { code: string; blockers: string[] };
      };
      expect(body.reason.code).toBe('account_deletion_blocked');
      expect(body.reason.blockers).toEqual([
        'capital_holding',
        'fx_balance_unreadable',
      ]);
    });
  });
});
