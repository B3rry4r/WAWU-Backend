import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { WawuTransferDto } from '../../dto/money-request.dto';
import { MoneyTransfersController } from '../money-transfers.controller';
import {
  MAX_TRANSFER_PRESETS,
  readTransferPresets,
  TRANSFER_NOTE_MAX_LENGTH,
  TRANSFER_PRESETS_DEFAULT_KOBO,
} from '../transfer-presets';

const config = (value?: string) => ({
  get: (key: string) =>
    key === 'TRANSFER_AMOUNT_PRESETS_KOBO' ? value : undefined,
});

describe('the quick amounts and the note length W9 reads (WALLET-02)', () => {
  it('with nothing set the amounts are the default four, whole naira in kobo, smallest first', () => {
    const presets = readTransferPresets(config());
    expect(presets).toEqual([...TRANSFER_PRESETS_DEFAULT_KOBO]);
    expect(presets).toHaveLength(MAX_TRANSFER_PRESETS);
    expect(presets.every((k) => k % 100 === 0)).toBe(true);
    expect(presets).toEqual([...presets].sort((a, b) => a - b));
    expect(readTransferPresets(config('  '))).toEqual(presets);
  });

  it('a setting replaces them, sorted and without repeats', () => {
    expect(readTransferPresets(config('300000, 100000,300000'))).toEqual([
      100_000, 300_000,
    ]);
    expect(readTransferPresets(config('100'))).toEqual([100]);
  });

  it.each([
    ['five amounts', '100,200,300,400,500'],
    ['a decimal', '1000.50'],
    ['kobo that are not whole naira', '150'],
    ['zero', '0'],
    ['a word', 'ten'],
    ['an empty part', '100,,200'],
    ['a negative', '-100'],
    ['a number too big to be exact', '99999999999999999999'],
  ])('a setting with %s is refused, so the app does not start', (_n, value) => {
    expect(() => readTransferPresets(config(value))).toThrow(
      /TRANSFER_AMOUNT_PRESETS_KOBO/,
    );
  });

  it('the controller reads the setting when it is made, so a bad one stops the app at boot', () => {
    const transfers = {} as never;
    expect(
      () => new MoneyTransfersController(transfers, config('150') as never),
    ).toThrow(/TRANSFER_AMOUNT_PRESETS_KOBO/);
    const controller = new MoneyTransfersController(
      transfers,
      config('500000,1000000') as never,
    );
    expect(controller.presets()).toEqual({
      quickAmounts: [{ amountKobo: 500_000 }, { amountKobo: 1_000_000 }],
      noteMaxLength: TRANSFER_NOTE_MAX_LENGTH,
    });
    // what the answer is cannot be changed by whoever reads it
    controller.presets().quickAmounts.push({ amountKobo: 1 });
    expect(controller.presets().quickAmounts).toHaveLength(2);
  });

  it('the note length it reports is the one the send itself enforces', async () => {
    const base = {
      amountKobo: 100_000,
      expectedTotalKobo: 103_325,
      recipientWawuUserId: '3f9c8a52-2c1d-4a4e-9a55-0d7d1b7c1e11',
      quoteToken: 'token',
    };
    const at = plainToInstance(WawuTransferDto, {
      ...base,
      note: 'a'.repeat(TRANSFER_NOTE_MAX_LENGTH),
    });
    const over = plainToInstance(WawuTransferDto, {
      ...base,
      note: 'a'.repeat(TRANSFER_NOTE_MAX_LENGTH + 1),
    });
    expect(await validate(at)).toEqual([]);
    expect((await validate(over)).map((e) => e.property)).toEqual(['note']);
  });
});
