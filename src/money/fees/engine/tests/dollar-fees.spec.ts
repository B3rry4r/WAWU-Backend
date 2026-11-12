import { ConfigService } from '@nestjs/config';
import { MoneyError } from '../../../money-error';
import { DollarFeeService } from '../dollar-fees';
import { FeeRecordService } from '../fee-record.service';
import { FeeScheduleService } from '../fee-schedule.service';
import { ProviderRateService } from '../provider-rate.service';

/**
 * The dollar and incoming side of the fee engine (FEE-01 fix round 1) with no database and no network: stand-in
 * prisma (an in-memory fee record table) and a stand-in provider that moves book transfers by reference.
 */

const T0 = new Date('2026-11-11T00:00:00Z');
const NOW = new Date('2026-11-12T00:00:00Z');
const row = (o: Record<string, unknown>) => ({
  id: `s-${o.kind as string}`,
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
  row({ kind: 'ngn_add_money', currency: 'NGN', passThrough: true }),
];
const rate = (o: Record<string, unknown>) => ({
  id: `p-${o.kind as string}`,
  provider: 'nuvion',
  percentPpm: 0,
  minMinor: 0n,
  maxMinor: null,
  fixedMinor: 0n,
  startsAt: T0,
  changedBy: 'R-139 seed',
  note: null,
  createdAt: T0,
  ...o,
});
const NGN_ADD = rate({
  kind: 'ngn_add_money',
  currency: 'NGN',
  percentPpm: 2000,
  minMinor: 5000n,
});

async function build(
  opts: {
    plan?: Record<string, unknown>;
    rates?: ReturnType<typeof rate>[];
    env?: Record<string, string>;
  } = {},
) {
  const v: Record<string, unknown> = {
    'tax.vat_on': 0,
    'tax.vat_percent': '7.5',
    'fx.product.local_usd_in.on': 0,
    'money.min_withdrawal_minor': [],
    ...opts.plan,
  };
  const plan = {
    value: (k: string) => v[k],
    lines: (k: string) => v[k] as string[],
    number: (k: string) => Number(v[k]),
  };
  const table = new Map<string, Record<string, unknown>>();
  const key = (w: {
    provider_reference_kind: {
      provider: string;
      reference: string;
      kind: string;
    };
  }) =>
    `${w.provider_reference_kind.provider}|${w.provider_reference_kind.reference}|${w.provider_reference_kind.kind}`;
  const prisma = {
    feeSchedule: { findMany: () => Promise.resolve(SEED) },
    providerRate: { findMany: () => Promise.resolve(opts.rates ?? []) },
    moneyFeeRecord: {
      upsert: ({
        where,
        create,
      }: {
        where: never;
        create: Record<string, unknown>;
      }) => {
        const k = key(where);
        if (!table.has(k)) table.set(k, { id: k, ...create });
        return Promise.resolve(table.get(k));
      },
      findUnique: ({ where }: { where: never }) =>
        Promise.resolve(table.get(key(where)) ?? null),
      findMany: ({
        where,
      }: {
        where: { kind: unknown; reference: { in: string[] } };
      }) =>
        Promise.resolve(
          [...table.values()].filter(
            (r) =>
              where.reference.in.includes(r.reference as string) &&
              (typeof where.kind === 'string'
                ? r.kind === where.kind
                : (where.kind as { in: string[] }).in.includes(
                    r.kind as string,
                  )),
          ),
        ),
      update: ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const r = table.get(where.id)!;
        Object.assign(r, data);
        return Promise.resolve(r);
      },
    },
  };
  const schedule = new FeeScheduleService(prisma as never, plan as never);
  await schedule.refresh();
  const mail = { send: jest.fn() };
  const rates = new ProviderRateService(
    prisma as never,
    mail as never,
    new ConfigService({}),
  );
  await rates.refresh();
  const records = new FeeRecordService(prisma as never, schedule, rates);
  const dollar = new DollarFeeService(
    prisma as never,
    schedule,
    rates,
    records,
    plan as never,
    new ConfigService(opts.env ?? {}),
  );
  return { dollar, table, v };
}

/** A provider whose book transfers are kept by reference, so a repeat finds what was made. */
function provider() {
  const legs = new Map<string, bigint>();
  const made: { reference: string; amountMinor: bigint }[] = [];
  const abroad = {
    findFeeLeg: (_ref: unknown, reference: string) =>
      Promise.resolve(
        legs.has(reference)
          ? {
              state: 'found' as const,
              leg: {
                state: 'completed' as const,
                amountMinor: legs.get(reference)!,
                feeMinor: 0n,
              },
            }
          : { state: 'absent' as const },
      ),
    feeLeg: (i: { reference: string; amountMinor: bigint }) => {
      legs.set(i.reference, i.amountMinor);
      made.push(i);
      return Promise.resolve({
        state: 'completed' as const,
        amountMinor: i.amountMinor,
        feeMinor: 0n,
      });
    },
  };
  return { abroad: abroad as never, made };
}

const account = {
  wawuUserId: 'u1',
  currency: 'USD',
  providerAccountId: 'acc1',
  providerCustomerId: 'cus1',
};
const inflow = (o: Record<string, unknown> = {}) => ({
  account,
  walletId: 'w1',
  transferId: 'in-1',
  paymentType: 'bank-transfer',
  amountMinor: 100_000n,
  providerFeeMinor: 0n,
  status: 'completed' as const,
  occurredAt: NOW,
  ...o,
});
const COLLECTOR = { FX_FEE_COLLECTOR_USD_BAN: 'COLL1' };

describe('usd_bank_payout', () => {
  it('USD 100 costs USD 8; the provider charge sits inside it; the leg is the rest', async () => {
    const { dollar } = await build();
    const p = dollar.payoutFee(10_000n, 150, NOW);
    expect(p.feeMinor).toBe(800n);
    expect(p.vatMinor).toBe(0n);
    expect(p.expectedMinor).toBe(150n);
    expect(p.legMinor).toBe(650n);
  });

  it('VAT on: 7.5% of the fee on top, in the leg; VAT off: none', async () => {
    const on = await build({ plan: { 'tax.vat_on': 1 } });
    const p = on.dollar.payoutFee(10_000n, 150, NOW);
    expect(p.vatMinor).toBe(60n);
    expect(p.legMinor).toBe(800n + 60n - 150n);
    expect(on.dollar.vatOn()).toBe(true);
    const off = await build();
    expect(off.dollar.vatOn()).toBe(false);
  });

  it('percentage, minimum and maximum: USD 1,000 is USD 10 min 8; USD 10,000 is capped at USD 60', async () => {
    const { dollar } = await build();
    expect(dollar.payoutFee(100_000n, null, NOW).feeMinor).toBe(1000n);
    expect(dollar.payoutFee(1_000_000n, null, NOW).feeMinor).toBe(6000n);
    expect(dollar.payoutFee(2_000n, null, NOW).feeMinor).toBe(800n);
  });

  it('a provider charge above the fee leaves the leg at 0, never below', async () => {
    const { dollar } = await build();
    expect(dollar.payoutFee(10_000n, 5000, NOW).legMinor).toBe(0n);
  });

  it('a rate row wins over the estimate; with none, the estimate; with neither, 0', async () => {
    const row2 = rate({
      kind: 'usd_bank_payout',
      currency: 'USD',
      fixedMinor: 200n,
    });
    const withRow = await build({ rates: [row2] });
    const p = withRow.dollar.payoutFee(10_000n, 999, NOW);
    expect(p.expectedMinor).toBe(200n);
    expect(p.expectedRowId).toBe('p-usd_bank_payout');
    const none = await build();
    expect(none.dollar.payoutFee(10_000n, null, NOW).expectedMinor).toBe(0n);
  });

  it('refuses below the smallest withdrawal and a fee bigger than the amount', async () => {
    const { dollar } = await build({
      plan: { 'money.min_withdrawal_minor': ['USD 1000'] },
    });
    expect(() => dollar.assertPayoutSafe(999n, NOW)).toThrow(MoneyError);
    try {
      dollar.assertPayoutSafe(999n, NOW);
    } catch (e) {
      expect((e as MoneyError).code).toBe('below_minimum_withdrawal');
    }
    expect(() => dollar.assertPayoutSafe(1000n, NOW)).not.toThrow();
    const other = await build();
    try {
      other.dollar.assertPayoutSafe(500n, NOW);
      throw new Error('should refuse');
    } catch (e) {
      expect((e as MoneyError).code).toBe('fee_exceeds_amount');
    }
    expect(() => other.dollar.assertPayoutSafe(800n, NOW)).not.toThrow();
  });

  it('the record keeps amount, fee, VAT, expected and actual, and what WAWU kept; a repeat adds nothing', async () => {
    const { dollar, table } = await build({ plan: { 'tax.vat_on': 1 } });
    const input = {
      reference: 'abroad-1',
      amountMinor: 10_000n,
      estimateMinor: 150,
      at: NOW,
    };
    await dollar.recordPayout(input);
    await dollar.recordPayout(input);
    expect(table.size).toBe(1);
    const r = [...table.values()][0];
    expect(r.amountMinor).toBe(10_000n);
    expect(r.wawuFeeMinor).toBe(800n);
    expect(r.vatMinor).toBe(60n);
    expect(r.providerExpectedMinor).toBe(150n);
    expect(r.keptMinor).toBe(650n);
    await dollar.settlePayout('abroad-1', 170n);
    expect(r.providerActualMinor).toBe(170n);
    expect(r.keptMinor).toBe(630n);
    const shown = await dollar.payoutFeesFor(['abroad-1']);
    expect(shown.get('abroad-1')).toEqual({ feeMinor: 800n, vatMinor: 60n });
  });
});

describe('ngn_add_money', () => {
  it('passes on only the provider receiving charge, and records WAWU keeping nothing', async () => {
    const { dollar, table } = await build({ rates: [NGN_ADD] });
    expect(dollar.addMoneyCharge(10_000_000n)).toBe(20_000n); // 0.2% of NGN 100,000
    expect(dollar.addMoneyCharge(100_000n)).toBe(5_000n); // the minimum
    await dollar.recordAddMoney({
      reference: 'tr1',
      amountMinor: 10_000_000n,
      actualMinor: 20_000n,
      at: NOW,
    });
    const r = [...table.values()][0];
    expect(r.wawuFeeMinor).toBe(0n);
    expect(r.vatMinor).toBe(0n);
    expect(r.providerExpectedMinor).toBe(20_000n);
    expect(r.providerActualMinor).toBe(20_000n);
    expect(r.keptMinor).toBe(0n);
  });

  it('with VAT on there is still no VAT: WAWU has no fee to put it on', async () => {
    const { dollar, table } = await build({
      rates: [NGN_ADD],
      plan: { 'tax.vat_on': 1 },
    });
    await dollar.recordAddMoney({
      reference: 'tr2',
      amountMinor: 10_000_000n,
      actualMinor: 20_000n,
      at: NOW,
    });
    expect([...table.values()][0].vatMinor).toBe(0n);
  });
});

describe('dollars received (R-140: one fee, usd_local_in)', () => {
  it('a payment type that is not a bank transfer (a card, another Nuvion account) is charged nothing and recorded nowhere', async () => {
    const { dollar, table } = await build({ env: COLLECTOR });
    const p = provider();
    for (const paymentType of ['card-acq', 'book-transfer', 'wire-in', null]) {
      const r = await dollar.onForeignInflow({
        ...inflow({ paymentType }),
        abroad: p.abroad,
      });
      expect(r.outcome).toBe('none');
    }
    expect(p.made).toHaveLength(0);
    expect(table.size).toBe(0);
  });

  it('FEE-07 fix: a refunded or reversed outflow (direction out) is charged nothing and writes no fee record; a real bank inflow of USD 100 pays USD 7', async () => {
    const { dollar, table } = await build({ env: COLLECTOR });
    const p = provider();
    const refunded = await dollar.onForeignInflow({
      ...inflow({
        transferId: 'out-1',
        amountMinor: 10_000n,
        direction: 'out',
      }),
      abroad: p.abroad,
    });
    expect(refunded.outcome).toBe('none');
    expect(p.made).toHaveLength(0);
    expect(table.size).toBe(0);
    const real = await dollar.onForeignInflow({
      ...inflow({ transferId: 'in-7', amountMinor: 10_000n, direction: 'in' }),
      abroad: p.abroad,
    });
    expect(real.outcome).toBe('collected');
    expect(p.made).toHaveLength(1);
    expect(p.made[0]).toMatchObject({
      reference: 'in-7-fee',
      amountMinor: 700n,
    });
    expect(table.size).toBe(1);
  });

  it('a bank transfer of USD 1,000 pays USD 15, taken once by a book transfer under <inflow>-fee, the person sees what landed', async () => {
    const { dollar, table } = await build({ env: COLLECTOR });
    const p = provider();
    const r = await dollar.onForeignInflow({ ...inflow(), abroad: p.abroad });
    expect(r.outcome).toBe('collected');
    expect(p.made).toHaveLength(1);
    expect(p.made[0]).toMatchObject({
      reference: 'in-1-fee',
      amountMinor: 1500n,
    });
    const rec = [...table.values()][0];
    expect(rec.kind).toBe('usd_local_in');
    expect(rec.amountMinor).toBe(100_000n);
    expect(rec.wawuFeeMinor).toBe(1500n);
    const view = (await dollar.inflowFeesFor(['in-1'])).get('in-1')!;
    expect(view.amountMinor - view.feeMinor - view.vatMinor).toBe(98_500n);
  });

  it('a bank transfer of USD 100 pays the minimum, USD 7, and the person receives USD 93', async () => {
    const { dollar, table } = await build({ env: COLLECTOR });
    const p = provider();
    const r = await dollar.onForeignInflow({
      ...inflow({ amountMinor: 10_000n }),
      abroad: p.abroad,
    });
    expect(r.outcome).toBe('collected');
    expect(p.made[0].amountMinor).toBe(700n);
    expect([...table.values()][0].wawuFeeMinor).toBe(700n);
    const view = (await dollar.inflowFeesFor(['in-1'])).get('in-1')!;
    expect(view.amountMinor - view.takenMinor).toBe(9_300n);
  });

  it('the old switch no longer gates the fee: with fx.product.local_usd_in.on at 0 the fee is still charged', async () => {
    const { dollar } = await build({
      env: COLLECTOR,
      plan: { 'fx.product.local_usd_in.on': 0 },
    });
    const p = provider();
    const r = await dollar.onForeignInflow({ ...inflow(), abroad: p.abroad });
    expect(r.outcome).toBe('collected');
    expect(p.made).toHaveLength(1);
  });

  it('FX_LOCAL_USD_PAYMENT_TYPES may add a name that counts as a bank transfer; FX_WIRE_PAYMENT_TYPES is no longer read', async () => {
    const { dollar } = await build({
      env: {
        ...COLLECTOR,
        FX_LOCAL_USD_PAYMENT_TYPES: 'ach-in',
        FX_WIRE_PAYMENT_TYPES: 'wire-in',
      },
    });
    const p = provider();
    expect(
      (
        await dollar.onForeignInflow({
          ...inflow({ paymentType: 'ach-in', transferId: 'a1' }),
          abroad: p.abroad,
        })
      ).outcome,
    ).toBe('collected');
    expect(
      (
        await dollar.onForeignInflow({
          ...inflow({ paymentType: 'wire-in', transferId: 'w1' }),
          abroad: p.abroad,
        })
      ).outcome,
    ).toBe('none');
  });

  it('a replayed delivery takes the fee once, even if the schedule changed since', async () => {
    const { dollar } = await build({ env: COLLECTOR });
    const p = provider();
    await dollar.onForeignInflow({ ...inflow(), abroad: p.abroad });
    const again = await dollar.onForeignInflow({
      ...inflow(),
      abroad: p.abroad,
    });
    expect(again.outcome).toBe('collected');
    expect(p.made).toHaveLength(1);
  });

  it('VAT on: the fee and the VAT come off together', async () => {
    const { dollar } = await build({
      env: COLLECTOR,
      plan: { 'tax.vat_on': 1 },
    });
    const p = provider();
    await dollar.onForeignInflow({ ...inflow(), abroad: p.abroad });
    expect(p.made[0].amountMinor).toBe(1500n + 113n);
  });

  it("F2: the person loses exactly F + VAT in all: WAWU's leg is F + VAT minus Nuvion's own charge on the inflow, and the line shows that total as the one fee", async () => {
    const { dollar } = await build({
      env: COLLECTOR,
      plan: { 'tax.vat_on': 1 },
    });
    const p = provider();
    const r = await dollar.onForeignInflow({
      ...inflow({ providerFeeMinor: 1000n }),
      abroad: p.abroad,
    });
    expect(r.outcome).toBe('collected');
    // F 1500 + VAT 113 = 1613 off what arrived; Nuvion took 1000 of it, so the leg moves 613.
    expect(p.made[0].amountMinor).toBe(613n);
    const v = (await dollar.inflowFeesFor(['in-1'])).get('in-1')!;
    expect(v.takenMinor).toBe(1613n);
    expect(v.amountMinor - v.takenMinor).toBe(100_000n - 1613n);
  });

  it("F2: Nuvion's charge above F + VAT: the leg moves nothing (never below 0) and the one fee is Nuvion's figure", async () => {
    const { dollar } = await build({ env: COLLECTOR });
    const p = provider();
    const r = await dollar.onForeignInflow({
      ...inflow({ providerFeeMinor: 2000n }),
      abroad: p.abroad,
    });
    expect(r.outcome).toBe('recorded');
    expect(p.made).toHaveLength(0);
    const v = (await dollar.inflowFeesFor(['in-1'])).get('in-1')!;
    expect(v.takenMinor).toBe(2000n);
  });

  it('a fee bigger than the amount is cut to the amount: money arriving is never refused', async () => {
    const { dollar } = await build({ env: COLLECTOR });
    const p = provider();
    const r = await dollar.onForeignInflow({
      ...inflow({ amountMinor: 500n }),
      abroad: p.abroad,
    });
    expect(r.outcome).toBe('collected');
    expect(p.made[0].amountMinor).toBe(500n);
  });

  it('a pending, failed or non-dollar inflow is never charged', async () => {
    const { dollar } = await build({ env: COLLECTOR });
    const p = provider();
    expect(
      (
        await dollar.onForeignInflow({
          ...inflow({ status: 'pending' }),
          abroad: p.abroad,
        })
      ).outcome,
    ).toBe('none');
    expect(
      (
        await dollar.onForeignInflow({
          ...inflow({ account: { ...account, currency: 'EUR' } }),
          abroad: p.abroad,
        })
      ).outcome,
    ).toBe('none');
    expect(p.made).toHaveLength(0);
  });

  it('no collecting account configured: the fee is not taken and the inflow is flagged for review', async () => {
    const { dollar } = await build();
    const p = provider();
    const r = await dollar.onForeignInflow({ ...inflow(), abroad: p.abroad });
    expect(r.outcome).toBe('failed');
    expect(p.made).toHaveLength(0);
  });
});
