import type { ConfigService } from '@nestjs/config';

/**
 * The quick amounts W9 offers under the keypad, and the length of its note
 * (task WALLET-02). The canvas draws ₦5,000, ₦10,000, ₦25,000 and ₦50,000 and
 * its brief says they are not facts, so they come from here, never from the
 * app.
 *
 * PROVISIONAL(TRANSFER-PRESETS, owner=YOU, why=no ruling and no Fintava fact
 * gives the quick amounts on W9; the default is the canvas's four, and
 * TRANSFER_AMOUNT_PRESETS_KOBO replaces them). A value that is set and wrong
 * stops the app at boot, like BILLS_AMOUNT_PRESETS_KOBO.
 */
export const TRANSFER_PRESETS_DEFAULT_KOBO: readonly number[] = [
  500_000, 1_000_000, 2_500_000, 5_000_000,
];

/** Most quick amounts one row of W9 can hold. */
export const MAX_TRANSFER_PRESETS = 4;

/** The note's longest length: `WawuTransferDto.note` (`@MaxLength(100)`). */
export const TRANSFER_NOTE_MAX_LENGTH = 100;

/**
 * Whole-naira amounts in kobo, separated by commas, at most four. The list is
 * sorted and has no repeats.
 */
export function readTransferPresets(
  config: Pick<ConfigService, 'get'>,
): number[] {
  const raw = config.get<string>('TRANSFER_AMOUNT_PRESETS_KOBO');
  if (raw === undefined || raw.trim() === '') {
    return [...TRANSFER_PRESETS_DEFAULT_KOBO];
  }
  const parts = raw.split(',').map((p) => p.trim());
  const bad =
    parts.length > MAX_TRANSFER_PRESETS ||
    parts.some(
      (p) =>
        !/^\d+$/.test(p) ||
        !Number.isSafeInteger(Number(p)) ||
        Number(p) < 100 ||
        Number(p) % 100 !== 0,
    );
  if (bad) {
    throw new Error(
      `TRANSFER_AMOUNT_PRESETS_KOBO must be up to ${MAX_TRANSFER_PRESETS} whole-naira amounts in kobo, separated by commas`,
    );
  }
  return [...new Set(parts.map(Number))].sort((a, b) => a - b);
}
