import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { LivePlansConfig } from '../../plan-settings/live-plans-config';
import { buildRegistry } from '../../plan-settings/plan-setting-registry';
import { SettingInvalid } from '../../plan-settings/plan-setting-types';
import { loadPlanSettingsDefaults } from '../../plan-settings/plan-settings-defaults';
import { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import { ContentSaleTermsQueryDto } from '../dto/content-sale-terms-query.dto';
import { ContentSaleTermsService } from '../content-sale-terms.service';

/**
 * FIX-110: the terms of selling a piece (M24, M25) and the event's name on a
 * pass (W44). No database: the settings service is given a stand-in for the
 * one table it reads.
 */

const seed = loadPlanSettingsDefaults();
const defs = buildRegistry(seed.plans, seed.extras);
const def = (key: string) => defs.find((d) => d.key === key)!;

type Row = { key: string; value: unknown; updatedAt: Date };
async function settingsWith(rows: Row[] = []) {
  const prisma = {
    planSetting: { findMany: jest.fn(() => Promise.resolve(rows)) },
  };
  const service = new PlanSettingsService(prisma as never, seed);
  await service.onModuleInit();
  service.onModuleDestroy();
  return service;
}
const saved = (key: string, value: unknown): Row => ({
  key,
  value,
  updatedAt: new Date('2026-10-24T10:00:00.000Z'),
});

describe('GET /content/sale-terms (FIX-110)', () => {
  it('says the one split, no listing fee, the four quick prices and the review hours', async () => {
    const terms = new ContentSaleTermsService(await settingsWith()).terms(
      undefined,
    );
    expect(terms).toEqual({
      creatorSharePct: 85,
      listingFeeKobo: 0,
      presets: [
        { priceKobo: 100_000 },
        { priceKobo: 250_000 },
        { priceKobo: 300_000 },
        { priceKobo: 500_000 },
      ],
      reviewHours: 4,
      priceKobo: null,
      earnPerSaleKobo: null,
    });
  });

  it('works out what the creator keeps at a price, rounded down to the kobo', async () => {
    const service = new ContentSaleTermsService(await settingsWith());
    expect(service.terms(300_000)).toMatchObject({
      priceKobo: 300_000,
      earnPerSaleKobo: 255_000,
    });
    expect(service.terms(0).earnPerSaleKobo).toBe(0);
    // 85% of 100,100 kobo is 85,085 exactly; of 100,300 it is 85,255.
    expect(service.terms(100_300).earnPerSaleKobo).toBe(85_255);
  });

  it('refuses a price that is not a whole number of naira', async () => {
    const service = new ContentSaleTermsService(await settingsWith());
    expect(() => service.terms(100_050)).toThrow(BadRequestException);
  });

  it('reads an admin edit with no restart', async () => {
    const service = new ContentSaleTermsService(
      await settingsWith([
        saved('content.price_preset_2_kobo', 200_000),
        saved('content.review_hours', 24),
      ]),
    );
    const terms = service.terms(undefined);
    expect(terms.presets).toEqual([
      { priceKobo: 100_000 },
      { priceKobo: 200_000 },
      { priceKobo: 300_000 },
      { priceKobo: 500_000 },
    ]);
    expect(terms.reviewHours).toBe(24);
  });

  it('keeps the settings checked: a zero price or hour is refused', () => {
    for (const key of [
      'content.price_preset_1_kobo',
      'content.price_preset_4_kobo',
      'content.review_hours',
    ]) {
      expect(() => def(key).parse(0)).toThrow(SettingInvalid);
      expect(() => def(key).parse(1.5)).toThrow(SettingInvalid);
    }
    expect(def('content.review_hours').parse(8)).toBe(8);
  });

  it('takes the price as plain digits only', async () => {
    const check = async (priceKobo: string) =>
      validate(plainToInstance(ContentSaleTermsQueryDto, { priceKobo }));
    expect(await check('300000')).toHaveLength(0);
    expect(await check('0x1388')).not.toHaveLength(0);
    expect(await check('-5')).not.toHaveLength(0);
    expect(await check('1000000001')).not.toHaveLength(0);
    expect(
      await validate(plainToInstance(ContentSaleTermsQueryDto, {})),
    ).toHaveLength(0);
  });
});

describe('the event name on a pass (FIX-110, G-814)', () => {
  it('is the board\'s "Christmas event" until an admin changes it', async () => {
    const live = new LivePlansConfig(await settingsWith());
    expect(live.eventName).toBe('Christmas event');
  });

  it('follows an admin edit, and is one line', async () => {
    const live = new LivePlansConfig(
      await settingsWith([saved('plan.event_name', ['Maker Day'])]),
    );
    expect(live.eventName).toBe('Maker Day');
    expect(() => def('plan.event_name').parse(['a', 'b'])).toThrow(
      SettingInvalid,
    );
    expect(() => def('plan.event_name').parse([])).toThrow(SettingInvalid);
    expect(def('plan.event_name').parse(['Maker Day'])).toEqual(['Maker Day']);
  });
});
