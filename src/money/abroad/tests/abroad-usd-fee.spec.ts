import { ConfigService } from '@nestjs/config';
import { DollarFeeService } from '../../fees/engine/dollar-fees';
import { FeeRecordService } from '../../fees/engine/fee-record.service';
import { FeeScheduleService } from '../../fees/engine/fee-schedule.service';
import { ProviderRateService } from '../../fees/engine/provider-rate.service';
import type { MoneyError } from '../../money-error';
import { AbroadSendService } from '../abroad-send.service';
import { AbroadService } from '../abroad.service';
import { AbroadSettings } from '../abroad-settings';

/**
 * The dollar payout to a bank priced from the fee schedule (FEE-01 fix round 1, R-139): the quote's one fee, the VAT, the
 * total, the book transfer to WAWU (fee and VAT less the provider's charge) and the refusals. Stand-ins only.
 */

const T0 = new Date('2026-11-11T00:00:00Z');
const SCHEDULE = [
  {
    id: 's1',
    kind: 'usd_bank_payout',
    currency: 'USD',
    percentPpm: 10000,
    minMinor: 800n,
    maxMinor: 6000n,
    passThrough: false,
    startsAt: T0,
    changedBy: 'R-139 seed',
    note: null,
    createdAt: T0,
  },
];

async function build(
  opts: {
    vat?: boolean;
    min?: string[];
    provider?: 'nuvion' | 'fintava';
    method?: 'bank' | 'mobile_money';
    from?: string;
    estimate?: string;
  } = {},
) {
  process.env.FX_FEE_COLLECTOR_USD_BAN = 'COLL1';
  if (opts.estimate) process.env.ABROAD_PROVIDER_FEE_GBP_BANK = opts.estimate;
  else delete process.env.ABROAD_PROVIDER_FEE_GBP_BANK;
  const v: Record<string, unknown> = {
    'abroad.enabled': 1,
    'abroad.wawu_fee_kobo': 0,
    'abroad.wawu_fee_foreign': [],
    'abroad.max_per_send': [],
    'abroad.max_per_day': [],
    'abroad.corridors_off': [],
    'tax.vat_on': opts.vat ? 1 : 0,
    'tax.vat_percent': '7.5',
    'money.min_withdrawal_minor': opts.min ?? [],
  };
  const plan = {
    value: (k: string) => v[k],
    number: (k: string) => Number(v[k]),
    lines: (k: string) => v[k] as string[],
  };
  const created: Record<string, unknown>[] = [];
  const prisma = {
    feeSchedule: { findMany: () => Promise.resolve(SCHEDULE) },
    providerRate: { findMany: () => Promise.resolve([]) },
    moneyFeeRecord: {
      findMany: () =>
        Promise.resolve([
          { reference: 'ref1', wawuFeeMinor: 800n, vatMinor: 60n },
        ]),
    },
    abroadFreeze: { findUnique: () => Promise.resolve(null) },
    abroadRecipient: {
      findFirst: () =>
        Promise.resolve({
          id: 'r1',
          country: 'GB',
          currency: 'GBP',
          method: opts.method ?? 'bank',
        }),
    },
    abroadQuote: {
      create: ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return Promise.resolve({
          id: 'q1',
          fromCurrency: data.fromCurrency,
          toCurrency: data.toCurrency,
          expiresAt: new Date(Date.now() + 120_000),
        });
      },
    },
  };
  const schedule = new FeeScheduleService(prisma as never, plan as never);
  await schedule.refresh();
  const rates = new ProviderRateService(
    prisma as never,
    { send: jest.fn() } as never,
    new ConfigService({}),
  );
  await rates.refresh();
  const dollar = new DollarFeeService(
    prisma as never,
    schedule,
    rates,
    new FeeRecordService(prisma as never, schedule, rates),
    plan as never,
  );
  const from = opts.from ?? 'USD';
  const abroad = {
    feeLeg: jest.fn(),
    sources: () =>
      Promise.resolve([
        { currency: from, accountRef: 'acc', availableMinor: 10_000_000 },
      ]),
    quote: (i: { amountMinor: number }) =>
      Promise.resolve({
        amountFromMinor: i.amountMinor,
        amountToMinor: Math.floor(i.amountMinor * 0.8),
        rate: '0.8',
        quoteRef: 'pq1',
        expiresAt: new Date(Date.now() + 120_000),
        validForSeconds: 120,
      }),
  };
  const walletProvider = { name: opts.provider ?? 'nuvion', abroad };
  const service = new AbroadService(
    prisma as never,
    walletProvider as never,
    new AbroadSettings(plan as never),
    dollar,
  );
  return { service, created, prisma, walletProvider };
}

const wallet = {
  wawuUserId: 'u1',
  customerId: 'c1',
  walletId: 'w1',
} as never;
const dto = (amountMinor: number, fromCurrency = 'USD') =>
  ({ recipientId: 'r1', fromCurrency, amountMinor }) as never;

describe('a dollar payout to a bank', () => {
  it('USD 100: one fee of USD 8 on top, total USD 108, the recipient side unchanged; the provider charge is not shown', async () => {
    const { service, created } = await build({ estimate: '150' });
    const q = await service.quote(wallet, dto(10_000));
    expect(q).toMatchObject({
      currency: 'USD',
      feeMinor: 800,
      vatMinor: 0,
      vatOn: false,
      totalMinor: 10_800,
      receiveMinor: 8_000,
      providerFeeMinor: 0,
      wawuFeeMinor: 800,
    });
    // Inside the Hub: the leg is the fee less the provider's charge, and the provider's expected charge is kept.
    expect(created[0]).toMatchObject({
      wawuFeeMinor: 650n,
      providerFeeEstimateMinor: 150n,
    });
  });

  it('VAT on: the fee and 7.5% of it on top; the leg carries the VAT', async () => {
    const { service, created } = await build({ vat: true, estimate: '150' });
    const q = await service.quote(wallet, dto(10_000));
    expect(q).toMatchObject({
      feeMinor: 800,
      vatMinor: 60,
      vatOn: true,
      totalMinor: 10_860,
    });
    expect(created[0].wawuFeeMinor).toBe(710n);
  });

  it('with no provider estimate the whole fee is the leg (the provider charge is not guessed)', async () => {
    const { service, created } = await build();
    const q = await service.quote(wallet, dto(10_000));
    expect(q.totalMinor).toBe(10_800);
    expect(created[0].wawuFeeMinor).toBe(800n);
  });

  it('is refused below the smallest withdrawal, and when the fee is bigger than the amount', async () => {
    const low = await build({ min: ['USD 5000'] });
    await expect(low.service.quote(wallet, dto(4_999))).rejects.toMatchObject({
      code: 'below_minimum_withdrawal',
    });
    await expect(low.service.quote(wallet, dto(5_000))).resolves.toBeDefined();
    const small = await build();
    const err = (await small.service
      .quote(wallet, dto(500))
      .catch((e: MoneyError) => e)) as MoneyError;
    expect(err.code).toBe('fee_exceeds_amount');
    expect(low.created).toHaveLength(1);
    expect(small.created).toHaveLength(0);
  });

  it("a payout to mobile money keeps today's priced fee (the schedule kind is the bank payout)", async () => {
    const { service, created } = await build({ method: 'mobile_money' });
    expect(service.pricedFromSchedule('USD', 'mobile_money')).toBe(false);
    expect(service.pricedFromSchedule('EUR', 'bank')).toBe(false);
    expect(service.pricedFromSchedule('USD', 'bank')).toBe(true);
    void created;
  });

  it('under another provider nothing is priced from the schedule', async () => {
    const { service } = await build({ provider: 'fintava' });
    expect(service.pricedFromSchedule('USD', 'bank')).toBe(false);
  });

  it('F8: a payout still on a configured partner fee (mobile money) folds it into the one fee: providerFeeMinor 0, feeMinor holds it, the screen adds up', async () => {
    process.env.ABROAD_PROVIDER_FEE_GBP_MOBILE_MONEY = '150';
    try {
      const { service } = await build({ method: 'mobile_money' });
      const q = await service.quote(wallet, dto(10_000));
      expect(q.providerFeeMinor).toBe(0);
      expect(q.feeMinor).toBe(150);
      expect(q.vatMinor).toBe(0);
      expect(q.wawuFeeMinor).toBe(150);
      expect(q.totalMinor).toBe(10_000 + q.feeMinor + q.vatMinor);
      expect(q.receiveMinor).toBe(q.amountToMinor);
    } finally {
      delete process.env.ABROAD_PROVIDER_FEE_GBP_MOBILE_MONEY;
    }
  });

  it('F8: under Fintava the partner fee is shown as it was: its own line, nothing folded', async () => {
    process.env.ABROAD_PROVIDER_FEE_GBP_MOBILE_MONEY = '150';
    try {
      const { service } = await build({
        method: 'mobile_money',
        provider: 'fintava',
      });
      const q = await service.quote(wallet, dto(10_000));
      expect(q.providerFeeMinor).toBe(150);
    } finally {
      delete process.env.ABROAD_PROVIDER_FEE_GBP_MOBILE_MONEY;
    }
  });

  it('FEE-01: the send the app reads after sending shows the fee and total of the quote the person confirmed (a priced USD bank payout, VAT on)', async () => {
    const { service, created, prisma, walletProvider } = await build({
      vat: true,
    });
    const q = await service.quote(wallet, dto(10_000));
    expect(q.feeMinor).toBe(800);
    expect(q.vatMinor).toBe(60);
    expect(q.totalMinor).toBe(10_000 + 800 + 60);
    const sends = new AbroadSendService(
      prisma as never,
      walletProvider as never,
      service,
      {} as never,
    );
    void created;
    const row = {
      id: 's1',
      reference: 'ref1',
      status: 'pending',
      fromCurrency: 'USD',
      toCurrency: 'GBP',
      amountFromMinor: 10_000n,
      amountToMinor: 8_000n,
      rate: '0.8',
      providerFeeMinor: null,
      providerFeeEstimateMinor: null,
      wawuFeeKobo: 0n,
      wawuFeeMinor: 800n,
      narration: null,
      failureReason: null,
      createdAt: new Date(),
      completedAt: null,
      recipient: {
        id: 'r1',
        method: 'bank',
        country: 'GB',
        currency: 'GBP',
        holderName: 'A B',
        scheme: null,
        bankName: null,
        last4: null,
        createdAt: new Date(),
      },
    };
    const [v] = await (
      sends as unknown as {
        appViews(r: unknown[]): Promise<Record<string, unknown>[]>;
      }
    ).appViews([row]);
    expect(v).toMatchObject({
      providerFeeMinor: 0,
      currency: 'USD',
      feeMinor: q.feeMinor,
      vatMinor: q.vatMinor,
      totalMinor: q.totalMinor,
    });
  });
});
