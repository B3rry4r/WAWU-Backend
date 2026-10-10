import type { ConfigService } from '@nestjs/config';

/**
 * What the bill catalogue reads from the environment. Both are PROVISIONAL: nothing in Fintava's docs or the rulings
 * fixes them, so they are settings with a default, and a value that is set but wrong stops the app at boot.
 */
export interface BillsCatalogueConfig {
  /** The quick amounts S4 offers, in whole kobo, smallest first. PROVISIONAL(BILLS-PRESETS, owner=YOU, why=no ruling gives the quick amounts on S4; the canvas draws ₦2,000, ₦5,000, ₦10,000 and ₦20,000 and the task says they are not facts). */
  presetsKobo: number[];
  /** How long the disco list is kept before Fintava is asked again; 0 asks every time. PROVISIONAL(BILLS-CACHE-SECONDS, owner=YOU, why=Fintava gives no rule for how often its disco list changes). */
  cacheSeconds: number;
  /** Meter checks one person may make a minute, counted after the token is verified. PROVISIONAL(BILLS-PREVIEW-PER-MINUTE, owner=YOU, why=Fintava publishes no rate limit for the meter check and it is free, so the limit only protects it from a stuck screen). */
  previewPerMinute: number;
}

export const BILLS_CATALOGUE_DEFAULTS = {
  presetsKobo: [200_000, 500_000, 1_000_000, 2_000_000],
  cacheSeconds: 60,
  previewPerMinute: 30,
} as const;

/** Most presets S4 can draw in one row. */
export const MAX_PRESETS = 4;

function whole(
  raw: string | undefined,
  name: string,
  min: number,
  max: number,
): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  if (!/^\d+$/.test(raw.trim()))
    throw new Error(`${name} must be a whole number`);
  const n = Number(raw.trim());
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw new Error(`${name} must be from ${min} to ${max}`);
  return n;
}

export function readBillsCatalogueConfig(
  config: Pick<ConfigService, 'get'>,
): BillsCatalogueConfig {
  const rawPresets = config.get<string>('BILLS_AMOUNT_PRESETS_KOBO');
  let presetsKobo: number[] = [...BILLS_CATALOGUE_DEFAULTS.presetsKobo];
  if (rawPresets !== undefined && rawPresets.trim() !== '') {
    const parts = rawPresets.split(',').map((p) => p.trim());
    if (
      parts.length > MAX_PRESETS ||
      parts.some(
        (p) =>
          !/^\d+$/.test(p) ||
          Number(p) < 100 ||
          Number(p) % 100 !== 0 ||
          !Number.isSafeInteger(Number(p)),
      )
    ) {
      throw new Error(
        `BILLS_AMOUNT_PRESETS_KOBO must be up to ${MAX_PRESETS} whole-naira amounts in kobo, separated by commas`,
      );
    }
    presetsKobo = [...new Set(parts.map(Number))].sort((a, b) => a - b);
  }
  return {
    presetsKobo,
    cacheSeconds:
      whole(
        config.get<string>('BILLS_CATALOGUE_CACHE_SECONDS'),
        'BILLS_CATALOGUE_CACHE_SECONDS',
        0,
        3600,
      ) ?? BILLS_CATALOGUE_DEFAULTS.cacheSeconds,
    previewPerMinute:
      whole(
        config.get<string>('BILLS_PREVIEW_PER_MINUTE'),
        'BILLS_PREVIEW_PER_MINUTE',
        1,
        600,
      ) ?? BILLS_CATALOGUE_DEFAULTS.previewPerMinute,
  };
}
