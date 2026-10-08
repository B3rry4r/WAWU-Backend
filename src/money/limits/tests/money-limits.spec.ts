import { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../../common/prisma/prisma.service';
import { WalletProviderError } from '../../../wallet-provider/wallet-provider-error';
import {
  PROVIDER_LIMIT_ERROR_TYPES,
  providerLimitError,
  providerLimitOf,
  WalletProviderLimitError,
} from '../../../wallet-provider/wallet-provider-limit';
import type { MoneyErrorReason } from '../../dto/money-error.dto';
import { MONEY_ERROR_STATUS } from '../../money-contract';
import { MoneyError } from '../../money-error';
import { NUVION_FEE_CONFIG_KEYS } from '../../fees/nuvion-fee-config';
import { lagosDayStart, lagosMonthStart } from '../lagos-window';
import { LIMIT_REACHED_MESSAGES, limitReached } from '../limit-reached';
import {
  LimitConfigError,
  limitConfigKey,
  limitSetting,
  MONEY_LIMIT_CONFIG_KEYS,
  MoneyLimitSettings,
  readMoneyLimits,
} from '../money-limit-config';
import { MONEY_LIMIT_NAMES } from '../money-limit-names';
import { MoneyLimits } from '../money-limits.service';

/**
 * WAWU's limits as settings, and the provider's own limit errors (task
 * NUV-07), with no database: the per-transaction limit and the fee check
 * need none, and a ledger read is a stand-in that fails the spec if a check
 * that must not read reads. The day and month windows over a real ledger,
 * the per-person lock and "before any call" are money-limits.contract.spec.ts.
 */

const USER = '0f0a5a3e-6a35-4c35-9a1b-6a8f2f3f9a01';
const FEES = {
  [NUVION_FEE_CONFIG_KEYS.bookTransfer]: '100',
  [NUVION_FEE_CONFIG_KEYS.bankPayout]: '200',
  [NUVION_FEE_CONFIG_KEYS.inflow]: '0',
};

/** A ledger that must not be read: a check that needs no history reads none. */
const NO_LEDGER = new Proxy(
  {},
  {
    get() {
      throw new Error('the ledger was read');
    },
  },
) as unknown as PrismaService;

function limits(
  env: Record<string, string>,
  provider: 'fintava' | 'nuvion' = 'fintava',
): MoneyLimits {
  const config = new ConfigService(env);
  return new MoneyLimits(
    new MoneyLimitSettings(config),
    NO_LEDGER,
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

/** What an HttpException answers: its status and its body. */
function answer(e: { getStatus(): number; getResponse(): unknown }) {
  return { status: e.getStatus(), body: e.getResponse() };
}

describe('NUV-07: limit settings', () => {
  it('one setting per kind of movement and per limit, named for both', () => {
    expect(MONEY_LIMIT_CONFIG_KEYS).toEqual([
      'WAWU_LIMIT_WAWU_TRANSFER_PER_TRANSACTION_KOBO',
      'WAWU_LIMIT_WAWU_TRANSFER_DAILY_KOBO',
      'WAWU_LIMIT_WAWU_TRANSFER_MONTHLY_KOBO',
      'WAWU_LIMIT_BANK_TRANSFER_PER_TRANSACTION_KOBO',
      'WAWU_LIMIT_BANK_TRANSFER_DAILY_KOBO',
      'WAWU_LIMIT_BANK_TRANSFER_MONTHLY_KOBO',
      'WAWU_LIMIT_PURCHASE_PER_TRANSACTION_KOBO',
      'WAWU_LIMIT_PURCHASE_DAILY_KOBO',
      'WAWU_LIMIT_PURCHASE_MONTHLY_KOBO',
      'WAWU_LIMIT_BILL_PER_TRANSACTION_KOBO',
      'WAWU_LIMIT_BILL_DAILY_KOBO',
      'WAWU_LIMIT_BILL_MONTHLY_KOBO',
    ]);
  });

  it('empty is no limit; digits are whole kobo, 1 or more; anything else stops the app naming the setting', () => {
    const key = limitConfigKey('purchase', 'daily');
    for (const raw of [undefined, null, '', '  ']) {
      expect(limitSetting(raw, key)).toBeNull();
    }
    expect(limitSetting(' 5000000 ', key)).toBe(5_000_000);
    for (const raw of [
      '0',
      '-1',
      '1.5',
      '1e6',
      '5,000',
      'abc',
      '٣',
      '9007199254740992',
    ]) {
      expect(() => limitSetting(raw, key)).toThrow(LimitConfigError);
      expect(() => limitSetting(raw, key)).toThrow(key);
    }
  });

  it('nothing set: no limit anywhere (the default, with no figure)', () => {
    const table = readMoneyLimits(() => undefined);
    for (const row of Object.values(table)) {
      expect(Object.values(row)).toEqual([null, null, null]);
    }
  });

  it('a smaller window set above a larger one stops the app, naming both', () => {
    const per = limitConfigKey('bank_transfer', 'per_transaction');
    const day = limitConfigKey('bank_transfer', 'daily');
    const month = limitConfigKey('bank_transfer', 'monthly');
    const read = (env: Record<string, string>) => () =>
      readMoneyLimits((k) => env[k]);
    expect(read({ [per]: '101', [day]: '100' })).toThrow(
      `${per} is above ${day}`,
    );
    expect(read({ [day]: '101', [month]: '100' })).toThrow(
      `${day} is above ${month}`,
    );
    expect(read({ [per]: '101', [month]: '100' })).toThrow(
      `${per} is above ${month}`,
    );
    expect(read({ [per]: '100', [day]: '100', [month]: '100' })).not.toThrow();
    // Another kind's settings do not bind this one.
    expect(
      read({ [per]: '500', [limitConfigKey('purchase', 'daily')]: '100' }),
    ).not.toThrow();
  });
});

describe('NUV-07: the per-transaction limit and the fee check, before anything is read or sent', () => {
  const per = limitConfigKey('wawu_transfer', 'per_transaction');

  it('at the limit passes; one kobo above is 403 limit_reached naming per_transaction', async () => {
    const l = limits({ [per]: '500000' });
    await expect(
      l.assertMayMove({
        wawuUserId: USER,
        kind: 'wawu_transfer',
        amountKobo: 500_000,
      }),
    ).resolves.toBeUndefined();
    expect(
      await refusal(
        l.assertMayMove({
          wawuUserId: USER,
          kind: 'wawu_transfer',
          amountKobo: 500_001,
        }),
      ),
    ).toEqual({
      status: 403,
      code: 'limit_reached',
      limit: 'per_transaction',
      message: LIMIT_REACHED_MESSAGES.per_transaction,
    });
    expect(MONEY_ERROR_STATUS.limit_reached).toBe(403);
  });

  it('a limit for one kind does not touch another', async () => {
    const l = limits({ [per]: '500000' });
    for (const kind of ['bank_transfer', 'purchase', 'bill'] as const) {
      await expect(
        l.assertMayMove({ wawuUserId: USER, kind, amountKobo: 9_000_000 }),
      ).resolves.toBeUndefined();
    }
  });

  it('with no limit set, nothing is refused and the ledger is never read', async () => {
    await expect(
      limits({}).assertMayMove({
        wawuUserId: USER,
        kind: 'bank_transfer',
        amountKobo: Number.MAX_SAFE_INTEGER,
      }),
    ).resolves.toBeUndefined();
  });

  it('under nuvion with a fee unset, fees_not_set comes first, even before a limit', async () => {
    const l = limits({ [per]: '1' }, 'nuvion');
    const r = await refusal(
      l.assertMayMove({
        wawuUserId: USER,
        kind: 'wawu_transfer',
        amountKobo: 500,
      }),
    );
    expect(r.code).toBe('fees_not_set');
    expect(r.status).toBe(503);
    // With the fees set, the limit answers.
    const set = limits({ ...FEES, [per]: '1' }, 'nuvion');
    expect(
      (
        await refusal(
          set.assertMayMove({
            wawuUserId: USER,
            kind: 'wawu_transfer',
            amountKobo: 500,
          }),
        )
      ).limit,
    ).toBe('per_transaction');
    // assertWithinLimits is the limits alone.
    expect(
      (
        await refusal(
          l.assertWithinLimits({
            wawuUserId: USER,
            kind: 'wawu_transfer',
            amountKobo: 500,
          }),
        )
      ).code,
    ).toBe('limit_reached');
  });

  it('a movement must be whole kobo, 1 or more', async () => {
    const l = limits({});
    for (const amountKobo of [0, -1, 1.5, Number.NaN, 2 ** 53]) {
      await expect(
        l.assertMayMove({ wawuUserId: USER, kind: 'purchase', amountKobo }),
      ).rejects.toThrow(RangeError);
    }
  });
});

describe("NUV-07: the provider's own limit errors give the same answer", () => {
  const NUVION = {
    error_transfer_transaction_limit_exceeded: 'per_transaction',
    error_transfer_daily_limit_exceeded: 'daily',
    error_transfer_monthly_volume_exceeded: 'monthly',
  } as const;

  it("Nuvion's three limit error types, and only they, are limits", () => {
    expect(PROVIDER_LIMIT_ERROR_TYPES.nuvion).toEqual(NUVION);
    expect(PROVIDER_LIMIT_ERROR_TYPES.fintava).toEqual({});
    for (const t of [
      'error_transfer_insufficient_funds',
      'error_auth_rate_limit_exceeded',
      'error_account_limit_reached',
      'toString',
      'constructor',
      '__proto__',
      '',
    ]) {
      expect(providerLimitOf('nuvion', t)).toBeNull();
    }
    expect(
      providerLimitOf('fintava', 'error_transfer_daily_limit_exceeded'),
    ).toBeNull();
  });

  for (const [type, limit] of Object.entries(NUVION)) {
    it(`${type}: the same 403 limit_reached (limit ${limit}) as WAWU's own ${limit} limit, nothing moved`, () => {
      const err = providerLimitError('nuvion', type, {
        operation: 'transfer',
        httpStatus: 400,
        messages: ['Transfer would exceed the limit'],
        reference: 'wawu-ref-1',
      })!;
      expect(err).toBeInstanceOf(WalletProviderLimitError);
      expect(err).toBeInstanceOf(WalletProviderError);
      expect(err.kind).toBe('refused');
      expect(err.recordMayExist).toBe(false);
      expect(err.limit).toBe(limit);
      expect(answer(err.toHttpException())).toEqual(
        answer(limitReached(limit)),
      );
      expect(answer(err.toHttpException())).toEqual({
        status: 403,
        body: {
          message: LIMIT_REACHED_MESSAGES[limit],
          reason: {
            code: 'limit_reached',
            message: LIMIT_REACHED_MESSAGES[limit],
            limit,
          },
        },
      });
    });
  }

  it("WAWU's own limit gives the very answer the provider's does", async () => {
    const env = {
      [limitConfigKey('bank_transfer', 'per_transaction')]: '1000',
    };
    let own: MoneyError | null = null;
    try {
      await limits(env).assertMayMove({
        wawuUserId: USER,
        kind: 'bank_transfer',
        amountKobo: 1001,
      });
    } catch (e) {
      own = e as MoneyError;
    }
    const providers = providerLimitError(
      'nuvion',
      'error_transfer_transaction_limit_exceeded',
      { operation: 'payout' },
    )!;
    expect(answer(own!)).toEqual(answer(providers.toHttpException()));
  });

  it('any other provider failure keeps its own answer', () => {
    const other = new WalletProviderError({
      kind: 'refused',
      provider: 'nuvion',
      operation: 'transfer',
    });
    expect(
      (other.toHttpException().getResponse() as { reason: MoneyErrorReason })
        .reason.code,
    ).toBe('provider_unreachable');
  });

  it('every limit has one sentence, with no em-dash', () => {
    for (const name of MONEY_LIMIT_NAMES) {
      expect(LIMIT_REACHED_MESSAGES[name]).toMatch(/\.$/);
      expect(LIMIT_REACHED_MESSAGES[name]).not.toContain(
        String.fromCharCode(0x2014),
      );
    }
  });
});

describe('NUV-07: the Lagos day and month', () => {
  it('a day starts at midnight in Lagos (23:00 UTC the evening before)', () => {
    expect(
      lagosDayStart(new Date('2026-10-08T22:59:59.999Z')).toISOString(),
    ).toBe('2026-10-07T23:00:00.000Z');
    expect(
      lagosDayStart(new Date('2026-10-08T23:00:00.000Z')).toISOString(),
    ).toBe('2026-10-08T23:00:00.000Z');
    expect(
      lagosDayStart(new Date('2026-10-08T00:30:00.000Z')).toISOString(),
    ).toBe('2026-10-07T23:00:00.000Z');
  });

  it('a month starts at midnight on the first, in Lagos', () => {
    expect(
      lagosMonthStart(new Date('2026-10-31T22:59:59.999Z')).toISOString(),
    ).toBe('2026-09-30T23:00:00.000Z');
    expect(
      lagosMonthStart(new Date('2026-10-31T23:00:00.000Z')).toISOString(),
    ).toBe('2026-10-31T23:00:00.000Z');
    expect(
      lagosMonthStart(new Date('2026-01-01T00:30:00.000Z')).toISOString(),
    ).toBe('2025-12-31T23:00:00.000Z');
    expect(
      lagosMonthStart(new Date('2028-02-29T12:00:00.000Z')).toISOString(),
    ).toBe('2028-01-31T23:00:00.000Z');
  });
});
