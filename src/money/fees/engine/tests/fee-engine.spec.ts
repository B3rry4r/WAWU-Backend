import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { AdminRole } from '../../../../../generated/prisma/enums';
import { ADMIN_ROLES_KEY } from '../../../../admin/auth/decorators/admin-roles.decorator';
import type { MoneyErrorReason } from '../../../dto/money-error.dto';
import { MoneyError } from '../../../money-error';
import { FeeSettings, FEE_CONFIG_KEYS } from '../../fee-config';
import { FeeQuoteService } from '../../fee-quote.service';
import { AdminFeesController } from '../admin-fees.controller';
import { FeeRecordService } from '../fee-record.service';
import { FeeScheduleService } from '../fee-schedule.service';
import { feeOf, percentToPpm, ppmToPercent } from '../percent-fee';
import { ProviderRateService } from '../provider-rate.service';

/**
 * The fee engine (FEE-01, R-139) with no database and no network: stand-in
 * prisma and plan settings hold the rows the migration seeds (the figures
 * here are the owner's R-139 point 2 starting fees, written as test rows).
 */

const T0 = new Date('2026-11-11T00:00:00Z');
const row = (o: Record<string, unknown>) => ({
  id: `r${Math.random()}`,
  percentPpm: 0,
  minMinor: 0n,
  maxMinor: null,
  passThrough: false,
  startsAt: T0,
  changedBy: 'R-139 seed',
  note: null,
  createdAt: T0,
  ...o,
});
const SEED = [
  row({
    kind: 'ngn_bank_withdrawal',
    currency: 'NGN',
    percentPpm: 4000,
    minMinor: 10000n,
    maxMinor: 70000n,
  }),
  row({
    kind: 'usd_bank_payout',
    currency: 'USD',
    percentPpm: 10000,
    minMinor: 800n,
    maxMinor: 6000n,
  }),
  row({
    kind: 'intl_wire_in',
    currency: 'USD',
    percentPpm: 12500,
    minMinor: 3000n,
    maxMinor: 75000n,
  }),
  row({
    kind: 'usd_local_in',
    currency: 'USD',
    percentPpm: 15000,
    minMinor: 700n,
  }),
  row({ kind: 'fx_swap', currency: 'USD', percentPpm: 20000, minMinor: 100n }),
  row({ kind: 'wallet_to_wallet', currency: 'NGN' }),
  row({ kind: 'ngn_add_money', currency: 'NGN', passThrough: true }),
];
const RATES = [
  {
    id: 'p1',
    provider: 'nuvion',
    kind: 'ngn_bank_withdrawal',
    currency: 'NGN',
    percentPpm: 2000,
    minMinor: 5000n,
    maxMinor: 50000n,
    fixedMinor: 0n,
    startsAt: T0,
    changedBy: 'R-139 seed',
    note: null,
    createdAt: T0,
  },
  {
    id: 'p2',
    provider: 'nuvion',
    kind: 'wallet_to_wallet',
    currency: 'NGN',
    percentPpm: 0,
    minMinor: 0n,
    maxMinor: null,
    fixedMinor: 0n,
    startsAt: T0,
    changedBy: 'R-139 seed',
    note: null,
    createdAt: T0,
  },
];

function plan(values: Record<string, unknown> = {}) {
  const v: Record<string, unknown> = {
    'tax.vat_on': 0,
    'tax.vat_percent': '7.5',
    'fx.product.swap.on': 0,
    'fx.product.local_usd_in.on': 0,
    'money.min_withdrawal_minor': [],
    ...values,
  };
  return {
    value: (k: string) => v[k],
    lines: (k: string) => v[k] as string[],
  };
}

async function schedule(rows = SEED, planValues: Record<string, unknown> = {}) {
  const store = [...rows];
  const prisma = {
    feeSchedule: {
      findMany: () =>
        Promise.resolve(
          [...store].sort(
            (a, b) => a.startsAt.getTime() - b.startsAt.getTime(),
          ),
        ),
      create: ({ data }: { data: Record<string, unknown> }) => {
        const r = row({
          ...data,
          id: `n${store.length}`,
          createdAt: new Date(),
        });
        store.push(r);
        return Promise.resolve(r);
      },
    },
  };
  const s = new FeeScheduleService(prisma as never, plan(planValues) as never);
  await s.refresh();
  return s;
}

function rates() {
  const prisma = { providerRate: { findMany: () => Promise.resolve(RATES) } };
  const r = new ProviderRateService(
    prisma as never,
    { send: jest.fn() } as never,
    new ConfigService({}),
  );
  return r.refresh().then(() => r);
}

const fee = (
  s: FeeScheduleService,
  kind: never,
  minor: number,
  at = new Date('2026-11-12T00:00:00Z'),
) => s.feeFor(kind, BigInt(minor), at).feeMinor;

describe('the fee rule', () => {
  it('the five owner tests', async () => {
    const s = await schedule();
    expect(fee(s, 'ngn_bank_withdrawal' as never, 1_000_000)).toBe(10_000n); // NGN 10,000 -> 100
    expect(fee(s, 'ngn_bank_withdrawal' as never, 10_000_000)).toBe(40_000n); // NGN 100,000 -> 400
    expect(fee(s, 'ngn_bank_withdrawal' as never, 50_000_000)).toBe(70_000n); // NGN 500,000 -> 700
    expect(fee(s, 'usd_bank_payout' as never, 10_000)).toBe(800n); // USD 100 -> 8
    expect(fee(s, 'intl_wire_in' as never, 100_000)).toBe(3_000n); // USD 1,000 -> 30
  });

  it('edges: minimum, maximum, exact boundaries, halves round up, zero percent', () => {
    const rule = { ppm: 4000, minMinor: 10000n, maxMinor: 70000n };
    expect(feeOf(rule, 1n)).toBe(10000n);
    expect(feeOf(rule, 2_500_000n)).toBe(10000n); // exactly the minimum
    expect(feeOf(rule, 17_500_000n)).toBe(70000n); // exactly the maximum
    expect(feeOf(rule, 999_999_999_999n)).toBe(70000n);
    // 0.5% of 1 minor unit is half a unit: rounds up to 1
    expect(feeOf({ ppm: 5000, minMinor: 0n, maxMinor: null }, 100n)).toBe(1n);
    expect(feeOf({ ppm: 5000, minMinor: 0n, maxMinor: null }, 99n)).toBe(0n);
    expect(feeOf({ ppm: 0, minMinor: 0n, maxMinor: null }, 12345n)).toBe(0n);
  });

  it('percent text round trips with no floating point', () => {
    expect(percentToPpm('0.4')).toBe(4000);
    expect(percentToPpm('1.25')).toBe(12500);
    expect(percentToPpm('100')).toBe(1_000_000);
    expect(percentToPpm('100.0001')).toBeNull();
    expect(percentToPpm('0.00001')).toBeNull();
    expect(percentToPpm('abc')).toBeNull();
    expect(ppmToPercent(4000)).toBe('0.4');
    expect(ppmToPercent(12500)).toBe('1.25');
    expect(ppmToPercent(0)).toBe('0');
    expect(ppmToPercent(20000)).toBe('2');
  });

  it('adding money passes the provider charge on: WAWU adds nothing', async () => {
    const s = await schedule();
    expect(fee(s, 'ngn_add_money' as never, 5_000_000)).toBe(0n);
  });
});

describe('history', () => {
  it('a row with a future start applies from then; the old fee is kept', async () => {
    const future = row({
      kind: 'ngn_bank_withdrawal',
      currency: 'NGN',
      percentPpm: 5000,
      minMinor: 20000n,
      maxMinor: 90000n,
      startsAt: new Date('2026-12-01T00:00:00Z'),
      changedBy: 'admin@x',
      createdAt: new Date('2026-11-11T01:00:00Z'),
    });
    const s = await schedule([...SEED, future]);
    const before = new Date('2026-11-30T23:59:59Z');
    const after = new Date('2026-12-01T00:00:00Z');
    expect(fee(s, 'ngn_bank_withdrawal' as never, 1_000_000, before)).toBe(
      10_000n,
    );
    expect(fee(s, 'ngn_bank_withdrawal' as never, 1_000_000, after)).toBe(
      20_000n,
    );
    const kinds = await s.kinds();
    const k = kinds.find((x) => x.kind === 'ngn_bank_withdrawal')!;
    expect(k.history).toHaveLength(2);
    expect(k.history[0].changedBy).toBe('admin@x'); // newest first
    expect(k.history[1].changedBy).toBe('R-139 seed');
  });

  it('no row in force is fees_not_set (503)', async () => {
    const s = await schedule([]);
    try {
      s.feeFor('ngn_bank_withdrawal', 100n);
      throw new Error('expected a refusal');
    } catch (e) {
      expect(e).toBeInstanceOf(MoneyError);
      expect((e as MoneyError).getStatus()).toBe(503);
      expect(
        ((e as MoneyError).getResponse() as { reason: MoneyErrorReason }).reason
          .code,
      ).toBe('fees_not_set');
    }
    const early = await schedule(SEED);
    expect(() =>
      early.feeFor(
        'ngn_bank_withdrawal',
        100n,
        new Date('2026-01-01T00:00:00Z'),
      ),
    ).toThrow(MoneyError);
  });

  it('admin add validates and never touches old rows', async () => {
    const s = await schedule();
    const added = await s.add('a@b', {
      kind: 'usd_local_in',
      currency: 'USD',
      percent: '1.5',
      minMinor: 700,
      maxMinor: null,
      startsAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(added.percent).toBe('1.5');
    await expect(
      s.add('a@b', {
        kind: 'usd_local_in',
        currency: 'NGN',
        percent: '1',
        minMinor: 0,
        startsAt: new Date(Date.now() + 1000).toISOString(),
      }),
    ).rejects.toThrow();
    await expect(
      s.add('a@b', {
        kind: 'fx_swap',
        currency: 'USD',
        percent: '2',
        minMinor: 10,
        maxMinor: 5,
        startsAt: new Date(Date.now() + 1000).toISOString(),
      }),
    ).rejects.toThrow();
    await expect(
      s.add('a@b', {
        kind: 'fx_swap',
        currency: 'USD',
        percent: '2',
        minMinor: 1,
        startsAt: '2020-01-01T00:00:00Z',
      }),
    ).rejects.toThrow();
    await expect(
      s.add('a@b', {
        kind: 'ngn_add_money',
        currency: 'NGN',
        percent: '1',
        minMinor: 0,
        startsAt: new Date().toISOString(),
      }),
    ).rejects.toThrow();
  });
});

describe('VAT', () => {
  it('off by default, on from the setting, apart from the fee, half up', async () => {
    const off = await schedule();
    expect(
      off.feeFor('ngn_bank_withdrawal', 10_000_000n, new Date()).vatMinor,
    ).toBe(0n);
    const on = await schedule(SEED, { 'tax.vat_on': 1 });
    const r = on.feeFor('ngn_bank_withdrawal', 10_000_000n, new Date());
    expect(r.feeMinor).toBe(40_000n);
    expect(r.vatMinor).toBe(3_000n); // 7.5% of 40,000
    const odd = on.feeFor('ngn_bank_withdrawal', 1_000_000n, new Date());
    expect(odd.vatMinor).toBe(750n);
  });
});

describe('the quote', () => {
  async function quoteService(
    planValues: Record<string, unknown> = {},
    rows = SEED,
  ) {
    const s = await schedule(rows, planValues);
    const r = await rates();
    const settings = new FeeSettings(
      new ConfigService({ [FEE_CONFIG_KEYS.quoteKey]: 'k'.repeat(40) }),
    );
    return new FeeQuoteService(
      settings,
      { name: 'nuvion' } as never,
      new ConfigService({}),
      s,
      r,
    );
  }
  const USER = '0f0a5a3e-6a35-4c35-9a1b-6a8f2f3f9a01';

  it('NGN 100,000 to a bank: fee 400, wallet pays 100,400, the bank gets 100,000', async () => {
    const q = (await quoteService()).quote(USER, {
      kind: 'bank_transfer',
      amountKobo: 10_000_000,
    });
    expect(q.feeMinor).toBe(40_000);
    expect(q.vatMinor).toBe(0);
    expect(q.vatOn).toBe(false);
    expect(q.totalMinor).toBe(10_040_000);
    expect(q.totalKobo).toBe(10_040_000);
    expect(q.receiveMinor).toBe(10_000_000);
    expect(q.currency).toBe('NGN');
    expect(q.fee.totalFeeKobo).toBe(40_000);
    // Nuvion's 0.2% (NGN 200) is inside the fee, not on top of it.
    expect(q.fee.providerFeeKobo + q.fee.wawuFeeKobo).toBe(40_000);
  });

  it('VAT on: shown apart, added on top', async () => {
    const q = (await quoteService({ 'tax.vat_on': 1 })).quote(USER, {
      kind: 'bank_transfer',
      amountKobo: 10_000_000,
    });
    expect(q.feeMinor).toBe(40_000);
    expect(q.vatMinor).toBe(3_000);
    expect(q.vatOn).toBe(true);
    expect(q.totalMinor).toBe(10_043_000);
    expect(q.parts.some((p) => p.code === 'vat')).toBe(true);
  });

  it('wallet to wallet is free', async () => {
    const q = (await quoteService()).quote(USER, {
      kind: 'wawu_transfer',
      amountKobo: 500_000,
    });
    expect(q.feeMinor).toBe(0);
    expect(q.totalMinor).toBe(500_000);
  });

  it('a fee larger than the amount is refused (422), and so is an amount below the minimum', async () => {
    const svc = await quoteService({
      'money.min_withdrawal_minor': ['NGN 20000'],
    });
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return {
          status: (e as MoneyError).getStatus(),
          code: (
            (e as MoneyError).getResponse() as { reason: MoneyErrorReason }
          ).reason.code,
        };
      }
      return null;
    };
    expect(
      code(() =>
        svc.quote(USER, { kind: 'bank_transfer', amountKobo: 15_000 }),
      ),
    ).toEqual({ status: 422, code: 'below_minimum_withdrawal' });
    const noMin = await quoteService();
    expect(
      code(() =>
        noMin.quote(USER, { kind: 'bank_transfer', amountKobo: 5_000 }),
      ),
    ).toEqual({ status: 422, code: 'fee_exceeds_amount' });
    expect(
      code(() =>
        noMin.quote(USER, { kind: 'bank_transfer', amountKobo: 10_000 }),
      ),
    ).toBeNull();
  });

  it('no schedule row is fees_not_set (503), and check() still binds the token', async () => {
    const empty = await quoteService({}, []);
    expect(() =>
      empty.quote(USER, { kind: 'bank_transfer', amountKobo: 10_000_000 }),
    ).toThrow(MoneyError);
    const svc = await quoteService();
    const q = svc.quote(USER, {
      kind: 'bank_transfer',
      amountKobo: 10_000_000,
    });
    expect(
      svc.check(
        USER,
        { kind: 'bank_transfer', amountKobo: 10_000_000 },
        q.totalKobo,
        q.quoteToken,
      ).totalKobo,
    ).toBe(q.totalKobo);
    expect(() =>
      svc.check(
        USER,
        { kind: 'bank_transfer', amountKobo: 10_000_000 },
        q.totalKobo + 1,
        q.quoteToken,
      ),
    ).toThrow(MoneyError);
  });
});

describe('the fee record', () => {
  it('keeps the amount, fee, tax, expected and actual charge and what WAWU kept', async () => {
    const s = await schedule(SEED, { 'tax.vat_on': 1 });
    const r = await rates();
    const rows = new Map<string, Record<string, bigint | string | null>>();
    const mismatch = jest.spyOn(r, 'mismatch').mockResolvedValue();
    const prisma = {
      moneyFeeRecord: {
        upsert: ({ create }: { create: Record<string, bigint | string> }) => {
          rows.set(create.reference as string, {
            ...create,
            id: 'x',
            providerActualMinor: null,
          });
          return Promise.resolve();
        },
        findUnique: ({
          where,
        }: {
          where: { provider_reference_kind: { reference: string } };
        }) =>
          Promise.resolve(
            rows.get(where.provider_reference_kind.reference) ?? null,
          ),
        update: ({ data }: { data: Record<string, bigint> }) => {
          const cur = [...rows.values()][0];
          Object.assign(cur, data);
          return Promise.resolve();
        },
      },
    };
    const svc = new FeeRecordService(prisma as never, s, r);
    await svc.record({
      provider: 'nuvion',
      reference: 'ref1',
      kind: 'ngn_bank_withdrawal',
      amountMinor: 10_000_000n,
    });
    const rec = rows.get('ref1')!;
    expect(rec.amountMinor).toBe(10_000_000n);
    expect(rec.wawuFeeMinor).toBe(40_000n);
    expect(rec.vatMinor).toBe(3_000n);
    expect(rec.providerExpectedMinor).toBe(20_000n);
    expect(rec.keptMinor).toBe(20_000n);
    expect(rec.feeScheduleId).toBeTruthy();
    expect(rec.providerRateId).toBe('p1');

    await svc.settle('nuvion', 'ref1', 'ngn_bank_withdrawal', 20_000n);
    expect(rows.get('ref1')!.providerActualMinor).toBe(20_000n);
    expect(mismatch).not.toHaveBeenCalled();
    await svc.settle('nuvion', 'ref1', 'ngn_bank_withdrawal', 30_000n);
    expect(rows.get('ref1')!.keptMinor).toBe(10_000n);
    expect(mismatch).toHaveBeenCalledTimes(1);
  });
});

describe('provider rates stay out of the app', () => {
  it('no non-admin path in the contract mentions a provider rate', () => {
    const contract = JSON.parse(
      readFileSync(
        join(__dirname, '../../../../../contract/openapi.json'),
        'utf8',
      ),
    ) as {
      paths: Record<string, unknown>;
    };
    for (const [path, def] of Object.entries(contract.paths)) {
      if (path.includes('/admin/')) continue;
      const text = JSON.stringify(def);
      expect(text).not.toMatch(/ProviderRate|provider-rates|fixedMinor/);
    }
  });

  it('only superadmin and finance can read or write provider rates; support may read fees', () => {
    const reflector = new Reflector();
    const proto = AdminFeesController.prototype;
    const roles = (name: keyof AdminFeesController) =>
      reflector.get<AdminRole[]>(
        ADMIN_ROLES_KEY,
        Object.getOwnPropertyDescriptor(proto, name)?.value as never,
      );
    for (const h of ['providerRates', 'addProviderRate', 'addFee'] as const) {
      expect([...roles(h)].sort()).toEqual(
        [AdminRole.finance, AdminRole.superadmin].sort(),
      );
    }
    expect(roles('fees')).toContain(AdminRole.support);
    expect(roles('fees')).not.toContain(AdminRole.reviewer);
  });
});
