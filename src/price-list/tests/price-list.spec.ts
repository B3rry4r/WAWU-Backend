import { BadRequestException } from '@nestjs/common';
import { MoneyError } from '../../money/money-error';
import { buildRegistry } from '../../plan-settings/plan-setting-registry';
import { SettingInvalid } from '../../plan-settings/plan-setting-types';
import { loadPlanSettingsDefaults } from '../../plan-settings/plan-settings-defaults';
import { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import {
  PRICE_LIST_KEY,
  TIP_LIST_KEY,
  nairaNumbers,
  nearestOnList,
  neighbours,
  parseNairaLines,
  PriceListProblem,
} from '../price-list';
import { PriceListController } from '../price-list.controller';
import { PriceListService } from '../price-list.service';

/**
 * PRICE-LIST (R-101 points 1 and 3): the two admin settings, the read, and the
 * rule's refusal. No database: the settings service gets a stand-in for the
 * one table it reads and writes.
 */

const seed = loadPlanSettingsDefaults();
const defs = buildRegistry(seed.plans, seed.extras);
const def = (key: string) => defs.find((d) => d.key === key)!;

const R101_PRICES = [
  100, 200, 500, 1000, 1500, 2000, 2500, 3000, 4000, 5000, 7500, 10000, 15000,
  20000, 25000, 30000, 40000, 50000, 75000, 100000, 150000, 200000, 250000,
  500000, 1000000,
];
const R101_TIPS = [200, 500, 1000, 2000, 5000, 10000];

type Row = { key: string; value: unknown; updatedAt: Date };

/** A settings service over an in-memory table: reads, and the transaction `set` runs. */
async function settings(rows: Row[] = []) {
  const table = new Map(rows.map((r) => [r.key, r]));
  const tx = {
    $executeRaw: jest.fn(() => Promise.resolve(1)),
    planSetting: {
      findMany: jest.fn(() => Promise.resolve([...table.values()])),
      upsert: jest.fn(
        ({ where, create }: { where: { key: string }; create: Row }) => {
          table.set(where.key, { ...create, updatedAt: new Date() });
          return Promise.resolve();
        },
      ),
      delete: jest.fn(({ where }: { where: { key: string } }) => {
        table.delete(where.key);
        return Promise.resolve();
      }),
    },
    adminOpsAudit: { create: jest.fn(() => Promise.resolve()) },
  };
  const prisma = {
    planSetting: {
      findMany: jest.fn(() => Promise.resolve([...table.values()])),
    },
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const service = new PlanSettingsService(prisma as never, seed);
  await service.onModuleInit();
  service.onModuleDestroy();
  return service;
}
const admin = { id: 'a1', email: 'a@test.wawu.dev', role: 'owner' } as never;

describe('the two settings (R-101 point 1)', () => {
  it('start as the owner wrote them', () => {
    expect(nairaNumbers(def(PRICE_LIST_KEY).default as string[])).toEqual(
      R101_PRICES,
    );
    expect(nairaNumbers(def(TIP_LIST_KEY).default as string[])).toEqual(
      R101_TIPS,
    );
    expect(def(PRICE_LIST_KEY).unit).toBe('lines');
  });

  it('every launch tip is on the launch price list', () => {
    for (const t of R101_TIPS) expect(R101_PRICES).toContain(t);
  });

  it.each([
    ['not a list', 'cheap'],
    ['an empty list', []],
    ['a price of 0', [0, 100]],
    ['a negative price', [-100, 100]],
    ['a price above 1,000,000', [100, 1_000_001]],
    ['a decimal', [100, 150.5]],
    ['text that is not digits', ['100', '1,000']],
    ['a price twice', [100, 100, 200]],
    ['prices not lowest first', [200, 100]],
    ['more than 200 prices', Array.from({ length: 201 }, (_, i) => i + 1)],
  ])('refuses %s', (_name, value) => {
    expect(() => def(PRICE_LIST_KEY).parse(value)).toThrow(SettingInvalid);
    expect(() => def(TIP_LIST_KEY).parse(value)).toThrow(SettingInvalid);
  });

  it('accepts numbers or digit text, ascending, from 1 to 1,000,000, and stores digit lines', () => {
    expect(def(PRICE_LIST_KEY).parse([1, '250', 1_000_000])).toEqual([
      '1',
      '250',
      '1000000',
    ]);
    expect(() => parseNairaLines([0])).toThrow(PriceListProblem);
  });

  it('refuses a tip that is not on the price list, and a price list that drops a tip', async () => {
    const service = await settings();
    await expect(
      service.set(admin, { settings: { [TIP_LIST_KEY]: [200, 750] } }),
    ).rejects.toThrow(/750 is not/);
    await expect(
      service.set(admin, { settings: { [PRICE_LIST_KEY]: [100, 200, 500] } }),
    ).rejects.toThrow(BadRequestException);
    // Nothing was stored.
    expect(service.value(TIP_LIST_KEY)).toEqual(def(TIP_LIST_KEY).default);
  });

  it('accepts both lists changed together, in any order, and reads them live', async () => {
    const service = await settings();
    await service.set(admin, {
      settings: {
        [TIP_LIST_KEY]: [300, 600],
        [PRICE_LIST_KEY]: [100, 300, 600, 900],
      },
    });
    const list = new PriceListService(service);
    expect(list.list()).toEqual([100, 300, 600, 900]);
    expect(list.tipList()).toEqual([300, 600]);
    // A bad value is a 400 in the house shape for settings, with the reason.
    await expect(
      service.set(admin, { settings: { [PRICE_LIST_KEY]: [900, 100] } }),
    ).rejects.toThrow(/lowest to the highest/);
  });
});

describe('the nearest list price', () => {
  it('moves to the closer one, the lower on a tie, the top above it, the bottom below it', () => {
    expect(nearestOnList(R101_PRICES, 1200)).toBe(1000);
    expect(nearestOnList(R101_PRICES, 1300)).toBe(1500);
    expect(nearestOnList(R101_PRICES, 1250)).toBe(1000); // a tie
    expect(nearestOnList(R101_PRICES, 1_000_001)).toBe(1_000_000);
    expect(nearestOnList(R101_PRICES, 9_999_999)).toBe(1_000_000);
    expect(nearestOnList(R101_PRICES, 50)).toBe(100);
    expect(nearestOnList(R101_PRICES, 500)).toBe(500);
  });
  it('names the list prices either side', () => {
    expect(neighbours(R101_PRICES, 1200)).toEqual({
      lower: 1000,
      higher: 1500,
    });
    expect(neighbours(R101_PRICES, 50)).toEqual({ lower: null, higher: 100 });
    expect(neighbours(R101_PRICES, 2_000_000)).toEqual({
      lower: 1_000_000,
      higher: null,
    });
  });
});

describe('the rule and the read', () => {
  it('accepts a list price and, where R-8 allows it, free', async () => {
    const list = new PriceListService(await settings());
    expect(() => list.assertOnList(2500)).not.toThrow();
    expect(() => list.assertOnList(0, { allowFree: true })).not.toThrow();
    expect(() => list.assertOnList(0)).toThrow(MoneyError);
  });

  it('refuses any other price with 400 price_not_on_list and the nearest list prices', async () => {
    const list = new PriceListService(await settings());
    let caught: MoneyError | undefined;
    try {
      list.assertOnList(1200);
    } catch (e) {
      caught = e as MoneyError;
    }
    expect(caught).toBeInstanceOf(MoneyError);
    expect(caught!.getStatus()).toBe(400);
    expect(caught!.getResponse()).toEqual({
      message:
        'That price is not on the price list. The nearest are ₦1,000 and ₦1,500.',
      reason: {
        code: 'price_not_on_list',
        message:
          'That price is not on the price list. The nearest are ₦1,000 and ₦1,500.',
        nearestLowerNaira: 1000,
        nearestHigherNaira: 1500,
      },
    });
    expect(caught!.message).not.toMatch(/[–—]/);
  });

  it('GET /prices carries both lists in naira and kobo', async () => {
    const view = new PriceListController(
      new PriceListService(await settings()),
    ).read();
    expect(view.prices).toHaveLength(25);
    expect(view.prices[0]).toEqual({ priceNaira: 100, priceKobo: 10_000 });
    expect(view.prices.at(-1)).toEqual({
      priceNaira: 1_000_000,
      priceKobo: 100_000_000,
    });
    expect(view.tips.map((t) => t.priceNaira)).toEqual(R101_TIPS);
  });
});
