import { SANDBOX_DISCO_ROWS } from '../../../test/bills/sandbox-discos';
import type { FintavaDisco } from '../../fintava/fintava.interface';
import { readBillsCatalogueConfig } from '../bills-catalogue-config';
import { electricityBillers, presetsWithin } from '../electricity-billers';

/** The client's reading of a disco row: limits in kobo, `is_available` as a boolean. */
function asClient(): FintavaDisco[] {
  return SANDBOX_DISCO_ROWS.map((r) => ({
    code: r.code,
    description: r.description,
    minimumKobo: Number(r.minimum_value) * 100,
    maximumKobo: Number(r.maximum_value) * 100,
    available: r.is_available === 'Yes',
  }));
}
const PRESETS = [200_000, 500_000, 1_000_000, 2_000_000];
const disco = (
  over: Partial<FintavaDisco> & { code: string },
): FintavaDisco => ({
  description: over.code,
  minimumKobo: 50_000,
  maximumKobo: 50_000_000,
  available: true,
  ...over,
});

describe('electricityBillers: S3 is what Fintava lists (BILLS-01)', () => {
  const rows = electricityBillers(asClient(), PRESETS);
  const find = (name: string, plan: string) =>
    rows.find((r) => r.name === name && r.plan === plan);

  it('lists one row per company and plan, and none that Fintava lists as not available', () => {
    expect(rows.map((r) => `${r.name} ${r.plan}`)).toEqual([
      'Aba Power prepaid',
      'Aba Power postpaid',
      'Abuja Electric prepaid',
      'Abuja Electric postpaid',
      'BEDC prepaid',
      'BEDC postpaid',
      'Eko Electricity prepaid',
      'Eko Electricity postpaid',
      'Enugu Electricity prepaid',
      'Enugu Electricity postpaid',
      'Ibadan Electric prepaid',
      'Ibadan Electric postpaid',
      'Ikeja Electric prepaid',
      'Jos Electricity prepaid',
      'Jos Electricity postpaid',
      'Kaduna Electricity prepaid',
      'Kano Electricity prepaid',
      'Kano Electricity postpaid',
      'Port Harcourt Electric prepaid',
      'Port Harcourt Electric postpaid',
    ]);
    // Kaduna's postpaid code is `is_available: "No"`: hidden, while its prepaid code stays.
    expect(find('Kaduna Electricity', 'postpaid')).toBeUndefined();
    expect(
      rows.some((r) => r.code === 'Kaduna_Electricity_Disco_Postpaid'),
    ).toBe(false);
  });

  it('keeps the code Fintava lists for each row, and the limits it lists for that code, in kobo', () => {
    expect(find('Eko Electricity', 'prepaid')).toMatchObject({
      code: 'Eko_Prepaid',
      minimumKobo: 100_000,
      maximumKobo: 50_000_000,
    });
    expect(find('Eko Electricity', 'postpaid')).toMatchObject({
      code: 'Eko_Postpaid',
      minimumKobo: 90_000,
      maximumKobo: 30_000_000_000,
    });
    expect(find('Abuja Electric', 'prepaid')).toMatchObject({
      code: 'AEDC',
      minimumKobo: 50_000,
    });
    expect(find('Port Harcourt Electric', 'postpaid')).toMatchObject({
      code: 'PH_Disco',
      minimumKobo: 90_000,
      maximumKobo: 10_000_000,
    });
  });

  it('never assumes a minimum of 500 naira: a disco that lists 0 is listed with 0', () => {
    expect(find('Ibadan Electric', 'prepaid')?.minimumKobo).toBe(0);
    expect(find('Ibadan Electric', 'postpaid')?.minimumKobo).toBe(0);
    const minimums = new Set(rows.map((r) => r.minimumKobo));
    expect(minimums).toEqual(new Set([0, 50_000, 90_000, 100_000]));
  });

  it('collapses Ikeja’s two prepaid codes to the first Fintava lists, and falls back to the second when the first is not available', () => {
    expect(rows.filter((r) => r.name === 'Ikeja Electric')).toEqual([
      expect.objectContaining({
        code: 'Ikeja_Electric_Bill_Payment',
        plan: 'prepaid',
      }),
    ]);
    const second = asClient().map((d) =>
      d.code === 'Ikeja_Electric_Bill_Payment' ? { ...d, available: false } : d,
    );
    expect(
      electricityBillers(second, PRESETS).filter(
        (r) => r.name === 'Ikeja Electric',
      ),
    ).toEqual([expect.objectContaining({ code: 'Ikeja_Token_Purchase' })]);
    const neither = second.map((d) =>
      d.code === 'Ikeja_Token_Purchase' ? { ...d, available: false } : d,
    );
    expect(
      electricityBillers(neither, PRESETS).some(
        (r) => r.name === 'Ikeja Electric',
      ),
    ).toBe(false);
  });

  it('offers only the quick amounts that fit the company’s own limits', () => {
    // Port Harcourt: ₦500 to ₦100,000 prepaid, so all four fit; the amounts are the configured ones, smallest first.
    expect(find('Port Harcourt Electric', 'prepaid')?.presetsKobo).toEqual(
      PRESETS,
    );
    // Eko prepaid starts at ₦1,000: ₦2,000 and up fit; a company that starts above a preset drops it.
    const high = electricityBillers(
      [
        disco({
          code: 'X_Prepaid',
          description: 'X Prepaid',
          minimumKobo: 300_000,
          maximumKobo: 1_500_000,
        }),
      ],
      PRESETS,
    );
    expect(high[0].presetsKobo).toEqual([500_000, 1_000_000]);
    // Ibadan lists a minimum of 0: nothing below one kobo is offered.
    expect(presetsWithin([0, 100, 200_000], 0, 500_000)).toEqual([
      100, 200_000,
    ]);
  });

  it('lists a code Fintava adds later from its own text, with its plan from the word postpaid', () => {
    const added = electricityBillers(
      [
        disco({
          code: 'Yola_Disco_Prepaid',
          description: 'Yola Electricity Distribution Prepaid',
        }),
        disco({
          code: 'Yola_Disco_Postpaid',
          description: 'Yola Electricity Distribution Postpaid',
        }),
      ],
      PRESETS,
    );
    expect(added.map((r) => [r.name, r.plan, r.code])).toEqual([
      ['Yola Electricity', 'prepaid', 'Yola_Disco_Prepaid'],
      ['Yola Electricity', 'postpaid', 'Yola_Disco_Postpaid'],
    ]);
  });

  it('is an empty list when nothing is available', () => {
    expect(electricityBillers([], PRESETS)).toEqual([]);
    expect(
      electricityBillers(
        asClient().map((d) => ({ ...d, available: false })),
        PRESETS,
      ),
    ).toEqual([]);
  });

  it('keeps no Fintava wording, no em-dash and no decimals in anything it gives the app', () => {
    const text = JSON.stringify(rows);
    expect(text).not.toMatch(/fintava|—/i);
    for (const r of rows) {
      for (const n of [r.minimumKobo, r.maximumKobo, ...r.presetsKobo])
        expect(Number.isInteger(n)).toBe(true);
    }
  });
});

describe('readBillsCatalogueConfig (PROVISIONAL settings)', () => {
  const read = (values: Record<string, string>) =>
    readBillsCatalogueConfig({ get: (k: string) => values[k] } as never);

  it('has the canvas’s four amounts, a minute’s cache and 30 checks a minute by default', () => {
    expect(read({})).toEqual({
      presetsKobo: PRESETS,
      cacheSeconds: 60,
      previewPerMinute: 30,
    });
  });

  it('takes the amounts in kobo, sorted, without repeats', () => {
    expect(
      read({ BILLS_AMOUNT_PRESETS_KOBO: '1000000, 500000,500000' }).presetsKobo,
    ).toEqual([500_000, 1_000_000]);
  });

  it('refuses a value that is set but wrong, so the app does not start on it', () => {
    for (const bad of [
      'abc',
      '1.5',
      '150',
      '100,200,300,400,500',
      '-5',
      '99999999999999999999',
    ]) {
      expect(() => read({ BILLS_AMOUNT_PRESETS_KOBO: bad })).toThrow(
        /BILLS_AMOUNT_PRESETS_KOBO/,
      );
    }
    expect(() => read({ BILLS_CATALOGUE_CACHE_SECONDS: '-1' })).toThrow(
      /BILLS_CATALOGUE_CACHE_SECONDS/,
    );
    expect(() => read({ BILLS_CATALOGUE_CACHE_SECONDS: '1.5' })).toThrow(
      /BILLS_CATALOGUE_CACHE_SECONDS/,
    );
    expect(() => read({ BILLS_PREVIEW_PER_MINUTE: '0' })).toThrow(
      /BILLS_PREVIEW_PER_MINUTE/,
    );
  });

  it('allows a cache of 0, which asks Fintava every time', () => {
    expect(read({ BILLS_CATALOGUE_CACHE_SECONDS: '0' }).cacheSeconds).toBe(0);
  });
});
