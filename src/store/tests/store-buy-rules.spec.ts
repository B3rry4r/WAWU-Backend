import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  addWorkingDays,
  creatorShareOfList,
  intentCoversSale,
  intentExpiry,
  INTENT_SKEW_MS,
  INTENT_TTL_MS,
  lagosDateKey,
  payableAt,
} from '../store-buy-rules';
import { buyProductId, isBuyProductId, STORE_LADDER } from '../store-ladder';

/**
 * STORE-BUY-HUB (R-101): the rules that need no database. Dates: 22 Oct 2026
 * is a Thursday, so 23 is Friday, 24 Saturday, 25 Sunday, 26 Monday.
 */

const at = (iso: string) => new Date(iso);

describe('working days (Lagos time, Monday to Friday)', () => {
  it('a sale on a Thursday is payable the Tuesday after: Friday, Monday, Tuesday', () => {
    expect(addWorkingDays(at('2026-10-22T14:00:00Z'), 3).toISOString()).toBe(
      '2026-10-27T14:00:00.000Z',
    );
  });

  it('a sale on a Friday is payable the Wednesday after', () => {
    expect(addWorkingDays(at('2026-10-23T14:00:00Z'), 3).toISOString()).toBe(
      '2026-10-28T14:00:00.000Z',
    );
  });

  it('a sale on a Saturday or a Sunday counts from Monday, so it is payable on Wednesday', () => {
    expect(addWorkingDays(at('2026-10-24T12:00:00Z'), 3).toISOString()).toBe(
      '2026-10-28T12:00:00.000Z',
    );
    expect(addWorkingDays(at('2026-10-25T12:00:00Z'), 3).toISOString()).toBe(
      '2026-10-28T12:00:00.000Z',
    );
  });

  it('a sale on a Monday is payable on the Thursday', () => {
    expect(addWorkingDays(at('2026-10-26T09:30:00Z'), 3).toISOString()).toBe(
      '2026-10-29T09:30:00.000Z',
    );
  });

  it('the day is the LAGOS day: 23:30 UTC on a Friday is already Saturday in Lagos', () => {
    expect(lagosDateKey(at('2026-10-23T23:30:00Z'))).toBe('2026-10-24');
    // Saturday 00:30 in Lagos: Monday, Tuesday, Wednesday, the same clock time.
    expect(addWorkingDays(at('2026-10-23T23:30:00Z'), 3).toISOString()).toBe(
      '2026-10-27T23:30:00.000Z',
    );
  });

  it('a day on the holiday list does not count (the list itself is a later task)', () => {
    expect(
      addWorkingDays(
        at('2026-10-22T14:00:00Z'),
        3,
        new Set(['2026-10-26']),
      ).toISOString(),
    ).toBe('2026-10-28T14:00:00.000Z');
  });

  it('zero days is the same moment, and payableAt is three working days', () => {
    expect(addWorkingDays(at('2026-10-22T14:00:00Z'), 0).toISOString()).toBe(
      '2026-10-22T14:00:00.000Z',
    );
    expect(payableAt(at('2026-10-22T14:00:00Z')).toISOString()).toBe(
      '2026-10-27T14:00:00.000Z',
    );
  });
});

describe('the creator share and the intent window', () => {
  it('the creator gets exactly 85% of the LIST price, whatever the store charged', () => {
    expect(creatorShareOfList(100_000)).toBe(85_000);
    expect(creatorShareOfList(10_000)).toBe(8_500);
    for (const step of STORE_LADDER) {
      const list = step.listNaira * 100;
      expect(creatorShareOfList(list) * 100).toBe(list * 85);
    }
  });

  it('an intent covers a sale up to its expiry plus five minutes of clock difference', () => {
    const made = at('2026-10-27T10:00:00Z');
    const expires = intentExpiry(made);
    expect(expires.getTime() - made.getTime()).toBe(INTENT_TTL_MS);
    expect(INTENT_TTL_MS).toBe(60 * 60 * 1000);
    expect(intentCoversSale(expires, made)).toBe(true);
    expect(intentCoversSale(expires, expires)).toBe(true);
    expect(
      intentCoversSale(expires, new Date(expires.getTime() + INTENT_SKEW_MS)),
    ).toBe(true);
    expect(
      intentCoversSale(
        expires,
        new Date(expires.getTime() + INTENT_SKEW_MS + 1),
      ),
    ).toBe(false);
  });
});

describe('the price ladder', () => {
  const defaults = JSON.parse(
    readFileSync(
      join(__dirname, '../../plan-settings/plan-settings.defaults.json'),
      'utf8',
    ),
  ) as { values: Record<string, string[]> };

  it('has one step for every price on the default price list, in order, each store price above the list price', () => {
    expect(STORE_LADDER.map((s) => String(s.listNaira))).toEqual(
      defaults.values['prices.list_naira'],
    );
    expect(STORE_LADDER).toHaveLength(25);
    for (const s of STORE_LADDER)
      expect(s.storeNaira).toBeGreaterThan(s.listNaira);
  });

  it('names its products wawu.buy.<naira>, the same on both stores', () => {
    expect(buyProductId(1000)).toBe('wawu.buy.1000');
    expect(isBuyProductId('wawu.buy.1000000')).toBe(true);
    expect(isBuyProductId('wawu.pass.30.a')).toBe(false);
    expect(isBuyProductId('wawu.buy.0')).toBe(false);
  });

  it('is what the rows migration writes: the same 25 steps, in kobo, for both stores', () => {
    const sql = readFileSync(
      join(
        __dirname,
        '../../../prisma/migrations/20261213090100_store_buy_ladder_rows/migration.sql',
      ),
      'utf8',
    );
    const rows = [...sql.matchAll(/^\s+\((\d+), (\d+), (\d+)\),?$/gm)].map(
      (m) => ({
        listNaira: Number(m[1]),
        storeNaira: Number(m[2]),
        position: Number(m[3]),
      }),
    );
    expect(
      rows.map(({ listNaira, storeNaira }) => ({ listNaira, storeNaira })),
    ).toEqual(STORE_LADDER.map((s) => ({ ...s })));
    expect(rows.map((r) => r.position)).toEqual(rows.map((_, i) => i + 1));
    expect(sql).toContain(
      `('android'::"StorePlatform"), ('ios'::"StorePlatform")`,
    );
  });
});
