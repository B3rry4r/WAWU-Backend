// HOME-17 (owner answers 32 and 24, R-65): the four figures that moved into
// the admin settings registry, against a real Postgres and the real settings
// service. Defaults, validation, audit, a reset, and the name check limit read
// live. The TGIF time and the clean-up have their own spec in src/scheduler/tests;
// the popular-community figure is read live in
// src/search-response/tests/search-popular-members.contract.spec.ts.

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { AdminRole } from '../../../generated/prisma/enums';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { MoneyError } from '../../money/money-error';
import {
  NAME_CHECK_PER_HOUR_SETTING,
  NameCheckBudget,
} from '../../money/saved-accounts/name-check-budget';
import { POPULAR_COMMUNITY_MIN_MEMBERS_DEFAULT } from '../../search-response/search-history.config';
import {
  TGIF_NOTICE_RETENTION_SETTING,
  TGIF_NOTIFICATION_TIME_SETTING,
} from '../../scheduler/tgif-daily-notice.config';
import { LONG_DASH } from '../plan-setting-registry';
import { PlanSettingsModule } from '../plan-settings.module';
import {
  PlanSettingsService,
  type PlanSettingView,
} from '../plan-settings.service';

jest.setTimeout(120_000);

const ADMIN = {
  id: 'home17-settings-admin',
  email: 'home17@admin.test.wawu.dev',
  role: AdminRole.superadmin,
};

/** The four figures, with today's value as the default (nothing changes until an admin edits it). */
const FIGURES = {
  [TGIF_NOTIFICATION_TIME_SETTING]: { launch: '07:00', unit: 'time' },
  [NAME_CHECK_PER_HOUR_SETTING]: { launch: 30, unit: 'count' },
  popular_community_min_members: { launch: 10, unit: 'count' },
  [TGIF_NOTICE_RETENTION_SETTING]: { launch: 30, unit: 'days' },
} as const;
const KEYS = Object.keys(FIGURES);

describe('HOME-17: the TGIF time, the two thresholds and the retention are admin settings', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let settings: PlanSettingsService;

  const view = (key: string): PlanSettingView =>
    settings.describe().settings.find((s) => s.key === key)!;
  const edit = (key: string, value: unknown) =>
    settings.set(ADMIN, { settings: { [key]: value } });
  const audit = (key: string) =>
    prisma.adminOpsAudit.findMany({
      where: { resource: 'plan_setting', resourceId: key },
      orderBy: { actedAt: 'asc' },
    });
  const clean = async () => {
    await prisma.planSetting.deleteMany({ where: { key: { in: KEYS } } });
    await prisma.adminOpsAudit.deleteMany({
      where: { actedByAdminId: ADMIN.id },
    });
    await settings.refresh();
  };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
        PlanSettingsModule,
      ],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    settings = moduleRef.get(PlanSettingsService);
    await clean();
  });

  beforeEach(clean);

  afterAll(async () => {
    if (prisma) await clean();
    await moduleRef?.close();
  });

  it('each figure is a registry row with today as its default, and nothing is stored until an admin edits it', async () => {
    expect(
      await prisma.planSetting.count({ where: { key: { in: KEYS } } }),
    ).toBe(0);
    for (const [key, f] of Object.entries(FIGURES)) {
      expect(view(key)).toMatchObject({
        value: f.launch,
        default: f.launch,
        unit: f.unit,
        source: 'default',
        updatedAt: null,
      });
      expect(settings.value(key)).toBe(f.launch);
    }
    // The owner named the time (answer 32), so it carries no provisional mark.
    expect(view(TGIF_NOTIFICATION_TIME_SETTING).provisional).toBeNull();
    expect(view(TGIF_NOTICE_RETENTION_SETTING).provisional).toBeNull();
    expect(JSON.stringify(settings.describe())).not.toMatch(LONG_DASH);
    // The constant a spec uses for the launch popular figure is the registry's.
    expect(POPULAR_COMMUNITY_MIN_MEMBERS_DEFAULT).toBe(
      FIGURES.popular_community_min_members.launch,
    );
  });

  describe('a bad value is refused with the key and a reason, and nothing is stored', () => {
    const refused = async (key: string, value: unknown, reason: RegExp) => {
      await expect(edit(key, value)).rejects.toMatchObject({
        status: 400,
        message: expect.stringMatching(reason) as string,
      });
      expect(await prisma.planSetting.count({ where: { key } })).toBe(0);
      expect(await audit(key)).toHaveLength(0);
    };

    it('the TGIF time is a time of day written HH:MM', async () => {
      for (const bad of [
        '7:00',
        '24:00',
        '07:60',
        '0700',
        '07:00:00',
        'morning',
        700,
        '',
      ]) {
        await refused(TGIF_NOTIFICATION_TIME_SETTING, bad, /HH:MM/);
      }
    });

    it('the retention is a whole number of days, at least 1', async () => {
      for (const bad of [0, -1, 1.5, '30', 1096]) {
        await refused(
          TGIF_NOTICE_RETENTION_SETTING,
          bad,
          /whole number|or more|or less/,
        );
      }
    });

    it('the name checks an hour is a whole number from 1 to 1,000', async () => {
      for (const bad of [0, -5, 2.5, '30', 1001]) {
        await refused(
          NAME_CHECK_PER_HOUR_SETTING,
          bad,
          /whole number|or more|or less/,
        );
      }
    });

    it('the popular community figure is a whole number of 1 or more', async () => {
      for (const bad of [0, -5, 2.5, '10']) {
        await refused(
          'popular_community_min_members',
          bad,
          /whole number|or more/,
        );
      }
    });
  });

  it('an edit is stored, audited with the old and new value, applies at once, and a null puts the default back', async () => {
    await edit(TGIF_NOTIFICATION_TIME_SETTING, '09:30');
    expect(settings.text(TGIF_NOTIFICATION_TIME_SETTING)).toBe('09:30');
    expect(view(TGIF_NOTIFICATION_TIME_SETTING)).toMatchObject({
      value: '09:30',
      default: '07:00',
      source: 'set',
    });
    const rows = await audit(TGIF_NOTIFICATION_TIME_SETTING);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'plan_setting_set',
      actedByAdminId: ADMIN.id,
      detail: {
        key: TGIF_NOTIFICATION_TIME_SETTING,
        from: '07:00',
        to: '09:30',
        reset: false,
      },
    });

    await edit(TGIF_NOTICE_RETENTION_SETTING, 1);
    expect(settings.number(TGIF_NOTICE_RETENTION_SETTING)).toBe(1);

    await edit(TGIF_NOTIFICATION_TIME_SETTING, null);
    expect(settings.text(TGIF_NOTIFICATION_TIME_SETTING)).toBe('07:00');
    expect(view(TGIF_NOTIFICATION_TIME_SETTING).source).toBe('default');
    expect(await audit(TGIF_NOTIFICATION_TIME_SETTING)).toHaveLength(2);

    // The same value again writes nothing and audits nothing.
    await edit(TGIF_NOTICE_RETENTION_SETTING, 1);
    expect(await audit(TGIF_NOTICE_RETENTION_SETTING)).toHaveLength(1);
  });

  it('another server picks an edit up on its next reload, with no restart', async () => {
    // A row written by another process (here, straight to the table), then the reload the timer does.
    await prisma.planSetting.create({
      data: { key: TGIF_NOTICE_RETENTION_SETTING, value: 12 as never },
    });
    expect(settings.number(TGIF_NOTICE_RETENTION_SETTING)).toBe(30);
    await settings.refresh();
    expect(settings.number(TGIF_NOTICE_RETENTION_SETTING)).toBe(12);
  });

  it('a saved row that fails its own check is ignored and the default is used', async () => {
    await prisma.planSetting.create({
      data: { key: TGIF_NOTICE_RETENTION_SETTING, value: 0 as never },
    });
    await settings.refresh();
    expect(settings.number(TGIF_NOTICE_RETENTION_SETTING)).toBe(30);
  });

  describe('the name checks an hour, read by the real budget at every check', () => {
    const quiet = { set: () => undefined };
    const check = (budget: NameCheckBudget, who: string) =>
      budget.run(who, quiet, () => Promise.resolve('ok'));

    it('starts at 30, and an admin edit applies to the next check', async () => {
      const budget = new NameCheckBudget(settings);
      expect(budget.perHour).toBe(30);

      await edit(NAME_CHECK_PER_HOUR_SETTING, 2);
      expect(budget.perHour).toBe(2);
      await check(budget, 'ada');
      await check(budget, 'ada');
      const e = await check(budget, 'ada').catch((x: unknown) => x);
      expect(e).toBeInstanceOf(MoneyError);
      expect((e as MoneyError).code).toBe('name_check_rate_limited');

      // Raised, the same person can check again at once.
      await edit(NAME_CHECK_PER_HOUR_SETTING, 4);
      await expect(check(budget, 'ada')).resolves.toBe('ok');
      await expect(check(budget, 'ada')).resolves.toBe('ok');
      await expect(check(budget, 'ada')).rejects.toBeInstanceOf(MoneyError);

      // Put back to the default, 30 checks are allowed for a person who has made none.
      await edit(NAME_CHECK_PER_HOUR_SETTING, null);
      for (let i = 0; i < 30; i += 1) await check(budget, 'simi');
      await expect(check(budget, 'simi')).rejects.toBeInstanceOf(MoneyError);
    });

    it('does not read the retired NAME_CHECK_PER_HOUR environment key', () => {
      process.env.NAME_CHECK_PER_HOUR = '1';
      try {
        expect(new NameCheckBudget(settings).perHour).toBe(30);
      } finally {
        delete process.env.NAME_CHECK_PER_HOUR;
      }
    });
  });
});
