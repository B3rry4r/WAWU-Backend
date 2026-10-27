// STORE-HOLIDAYS (R-101 point 4): the admin setting `store.holidays` is skipped by a store earning's waiting days,
// as weekends are. Real database for the live setting; no provider is touched. Run with
//   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/test_payout_a?schema=public

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/test_payout_a?schema=public';

import { randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { PlanSettingsModule } from '../../../plan-settings/plan-settings.module';
import { PlanSettingsService } from '../../../plan-settings/plan-settings.service';
import { payableAt } from '../../store-buy-rules';
import { StoreEarningService } from '../../store-earning.service';
import {
  FIXED_HOLIDAYS_2026_2027,
  holidaySet,
  parseHolidayLines,
  STORE_HOLIDAYS_KEY,
} from '../store-holidays';

jest.setTimeout(60_000);

describe('STORE-HOLIDAYS: the list and the working-day count', () => {
  it('checks an admin list: real dates, once each, sorted', () => {
    expect(parseHolidayLines(['2027-03-10', '2026-12-25'])).toEqual([
      '2026-12-25',
      '2027-03-10',
    ]);
    expect(() => parseHolidayLines(['2026-02-30'])).toThrow();
    expect(() => parseHolidayLines(['25/12/2026'])).toThrow();
    expect(() => parseHolidayLines(['2026-12-25', '2026-12-25'])).toThrow();
    expect(() => parseHolidayLines(['2019-12-25'])).toThrow();
    expect(() => parseHolidayLines('2026-12-25')).toThrow();
  });

  it('skips a holiday as it skips a weekend, and a sale on a holiday counts from the next day', () => {
    // Wednesday 23 Dec 2026, 10:00 UTC. Thu 24, Fri 25, Mon 28 are the three working days.
    const sold = new Date('2026-12-23T10:00:00.000Z');
    expect(payableAt(sold).toISOString()).toBe('2026-12-28T10:00:00.000Z');
    // With Christmas Day a holiday, Tue 29 is the third.
    expect(payableAt(sold, holidaySet(['2026-12-25'])).toISOString()).toBe(
      '2026-12-29T10:00:00.000Z',
    );
    // A holiday on the Monday too (28 Dec): Wed 30.
    expect(
      payableAt(sold, holidaySet(['2026-12-25', '2026-12-28'])).toISOString(),
    ).toBe('2026-12-30T10:00:00.000Z');
    // The Lagos date decides: 23:30 UTC on 24 Dec is already Friday 25 Dec in Lagos; Mon, Tue, Wed are the three (Wed 30 Dec 00:30 Lagos).
    const late = new Date('2026-12-24T23:30:00.000Z');
    expect(payableAt(late, holidaySet(['2026-12-25'])).toISOString()).toBe(
      '2026-12-29T23:30:00.000Z',
    );
  });
});

describe('STORE-HOLIDAYS: the live setting (admin plan setting store.holidays)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let settings: PlanSettingsService;
  let earnings: StoreEarningService;
  const rows: string[] = [];

  async function record(sold: Date) {
    const id = randomUUID();
    rows.push(id);
    const purchase = { id, createdAt: sold } as never;
    await prisma.$transaction((tx) =>
      earnings.record(tx, {
        purchase,
        payeeWawuUserId: randomUUID(),
        buyKind: 'content',
        targetId: randomUUID(),
        title: 'A piece',
        listPriceKobo: 100_000,
        soldAt: sold,
      }),
    );
    return prisma.storeEarning.findFirstOrThrow({
      where: { storePurchaseId: id },
    });
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
        PlanSettingsModule,
      ],
      providers: [StoreEarningService],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    settings = moduleRef.get(PlanSettingsService);
    earnings = moduleRef.get(StoreEarningService);
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.storeEarning.deleteMany({
        where: { storePurchaseId: { in: rows } },
      });
      await prisma.planSetting.deleteMany({
        where: { key: STORE_HOLIDAYS_KEY },
      });
    }
    if (moduleRef) await moduleRef.close();
  });

  it("the default is Nigeria's fixed public holidays for 2026 and 2027", () => {
    expect(settings.lines(STORE_HOLIDAYS_KEY)).toEqual([
      ...FIXED_HOLIDAYS_2026_2027,
    ]);
  });

  it('an earning recorded over Christmas skips Christmas Day, and an admin-added holiday moves it again', async () => {
    const sold = new Date('2026-12-23T10:00:00.000Z');
    const first = await record(sold);
    expect(first.availableAt.toISOString()).toBe('2026-12-29T10:00:00.000Z');

    // An admin adds a movable holiday (the Monday given for the Boxing Day weekend).
    await prisma.planSetting.upsert({
      where: { key: STORE_HOLIDAYS_KEY },
      create: {
        key: STORE_HOLIDAYS_KEY,
        value: [...FIXED_HOLIDAYS_2026_2027, '2026-12-28'].sort(),
      },
      update: { value: [...FIXED_HOLIDAYS_2026_2027, '2026-12-28'].sort() },
    });
    expect(await settings.refresh()).toBe(true);
    const second = await record(sold);
    expect(second.availableAt.toISOString()).toBe('2026-12-30T10:00:00.000Z');
    // The earning already recorded is not moved by a later change.
    const again = await prisma.storeEarning.findUniqueOrThrow({
      where: { id: first.id },
    });
    expect(again.availableAt.toISOString()).toBe('2026-12-29T10:00:00.000Z');
  });
});
