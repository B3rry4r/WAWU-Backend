import { ConfigService } from '@nestjs/config';
import type { FintavaClient } from '../fintava-client';
import { FintavaConfigError } from '../fintava-config';
import {
  accountLimitsOf,
  FINTAVA_POLICY_TIER_DAILY_LIMITS_KOBO,
  FINTAVA_TIER_LIMITS_KEY,
  policyTierLimits,
  readTierLimits,
} from '../fintava-account-limits';
import { FintavaWalletProvider } from '../fintava-wallet-provider';

/**
 * The account's limit from Fintava (task WALLET-23): the tier Fintava reports
 * on the balance read, and the daily limit that goes with it from a setting.
 * Nothing here sends a request; the client is a stub that answers the balance
 * read exactly as the sandbox does (`data.tier`, balances as numbers that the
 * client has already turned into kobo).
 */

const balance = (tier: string | null) => ({
  availableKobo: 150_000,
  bookedKobo: 150_000,
  tier,
});

function provider(
  tier: string | null,
  env: Record<string, string> = {},
): FintavaWalletProvider {
  const stub = {
    getWalletBalance: () => Promise.resolve(balance(tier)),
  } as unknown as FintavaClient;
  return new FintavaWalletProvider(stub, new ConfigService(env));
}

describe('WALLET-23: reading the tier limits setting', () => {
  it("unset or blank is Fintava's wallet policy of 2 Oct 2026, in kobo", () => {
    for (const raw of [undefined, null, '', '   ']) {
      const t = readTierLimits(raw);
      expect([...t.entries()]).toEqual(
        Object.entries(FINTAVA_POLICY_TIER_DAILY_LIMITS_KOBO),
      );
    }
    // N50,000 / N500,000 / N5,000,000 a day (docs/fintava/limits.md).
    expect(policyTierLimits().get('TIER_1')).toBe(5_000_000n);
    expect(policyTierLimits().get('TIER_2')).toBe(50_000_000n);
    expect(policyTierLimits().get('TIER_3')).toBe(500_000_000n);
  });

  it('a value that is set replaces the whole table, and tier names are upper cased', () => {
    const t = readTierLimits(' tier_2 : 1234 , TIER_3:99 ');
    expect([...t.entries()]).toEqual([
      ['TIER_2', 1234n],
      ['TIER_3', 99n],
    ]);
    expect(t.get('TIER_1')).toBeUndefined();
  });

  it.each([
    'TIER_2',
    'TIER_2:',
    'TIER_2:0',
    'TIER_2:-5',
    'TIER_2:12.5',
    'TIER_2:1e6',
    'TIER_2:٣',
    ':100',
    'TIER 2:100',
    'TIER_2:100,',
    'TIER_2:100,TIER_2:200',
    'TIER_2:99999999999999999999',
  ])('%j stops the app at boot, naming the setting', (raw) => {
    expect(() => readTierLimits(raw)).toThrow(FintavaConfigError);
    expect(() => readTierLimits(raw)).toThrow(FINTAVA_TIER_LIMITS_KEY);
  });

  it('a tier that is not in the table, or no tier, has no limit known', () => {
    const table = policyTierLimits();
    expect(accountLimitsOf('TIER_2', table)).toEqual({
      tier: 'TIER_2',
      dailyKobo: 50_000_000n,
    });
    expect(accountLimitsOf('tier_3', table).dailyKobo).toBe(500_000_000n);
    expect(accountLimitsOf('TIER_9', table)).toEqual({
      tier: 'TIER_9',
      dailyKobo: null,
    });
    expect(accountLimitsOf(null, table)).toEqual({
      tier: null,
      dailyKobo: null,
    });
    // Not an inherited property of an object.
    expect(accountLimitsOf('constructor', table).dailyKobo).toBeNull();
    expect(accountLimitsOf('__proto__', table).dailyKobo).toBeNull();
  });
});

describe('WALLET-23: the Fintava adapter carries the account limit on the balance', () => {
  it('a Tier 2 wallet: the balance as before, and the tier with its daily limit', async () => {
    const b = await provider('TIER_2').getBalance({ walletId: 'w-1' });
    expect(b).toEqual({
      availableKobo: 150_000n,
      bookedKobo: 150_000n,
      accountLimits: { tier: 'TIER_2', dailyKobo: 50_000_000n },
    });
  });

  it('the setting changes the figure with no code change', async () => {
    const b = await provider('TIER_2', {
      [FINTAVA_TIER_LIMITS_KEY]: 'TIER_2:7000000',
    }).getBalance({ walletId: 'w-1' });
    expect(b.accountLimits).toEqual({ tier: 'TIER_2', dailyKobo: 7_000_000n });
  });

  it('a tier the table does not know names no limit; a balance with no tier carries no account limits at all', async () => {
    expect(
      (await provider('TIER_9').getBalance({ walletId: 'w-1' })).accountLimits,
    ).toEqual({ tier: 'TIER_9', dailyKobo: null });
    const none = await provider(null).getBalance({ walletId: 'w-1' });
    expect(none).toEqual({ availableKobo: 150_000n, bookedKobo: 150_000n });
    expect('accountLimits' in none).toBe(false);
  });

  it('a bad setting stops the app when the adapter is built', () => {
    expect(() =>
      provider('TIER_2', { [FINTAVA_TIER_LIMITS_KEY]: 'x' }),
    ).toThrow(FintavaConfigError);
  });

  it('under nuvion the setting is not read, so a bad value does not stop that server', () => {
    expect(() =>
      provider('TIER_2', {
        WALLET_PROVIDER: 'nuvion',
        [FINTAVA_TIER_LIMITS_KEY]: 'x',
      }),
    ).not.toThrow();
  });

  it('built without config (a spec that wires the adapter by hand), it uses the policy table', async () => {
    const stub = {
      getWalletBalance: () => Promise.resolve(balance('TIER_1')),
    } as unknown as FintavaClient;
    const b = await new FintavaWalletProvider(stub).getBalance({
      walletId: 'w-1',
    });
    expect(b.accountLimits?.dailyKobo).toBe(5_000_000n);
  });
});
