// HOME-17 (owner answer 32): the daily TGIF notice time is an admin setting,
// and notices older than the days kept are cleared. Real Postgres, the real
// settings service, the real notice job and the real clean-up. Time is passed
// to both (`run(now)`), so no test waits for a clock.

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { AdminRole } from '../../../generated/prisma/enums';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationModule } from '../../notification/notification.module';
import { PlanSettingsModule } from '../../plan-settings/plan-settings.module';
import { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import { TgifContentService } from '../../tgif/content/tgif-content.service';
import { SchedulerModule } from '../scheduler.module';
import {
  TGIF_DAILY_KIND,
  TGIF_NOTICE_RETENTION_SETTING,
  TGIF_NOTIFICATION_TIME_SETTING,
} from '../tgif-daily-notice.config';
import { TgifDailyNoticeService } from '../tgif-daily-notice.service';
import { TgifNoticeRetentionService } from '../tgif-notice-retention.service';

jest.setTimeout(120_000);

const RUN = Date.now().toString(36).padStart(8, '0').slice(-8);
const uid = (n: number) =>
  `e1700000-0000-4000-8000-${RUN}${String(n).padStart(4, '0')}`;
const ADMIN = {
  id: 'home17-scheduler-admin',
  email: 'home17-scheduler@admin.test.wawu.dev',
  role: AdminRole.superadmin,
};
const DAY_MS = 86_400_000;

// Days far from any other spec's. Lagos is UTC+1 all year.
const D1 = '2027-05-12';
const D2 = '2027-05-13';
const D3 = '2027-05-14';
const lagos = (day: string, hhmm: string) =>
  new Date(`${day}T${hhmm}:00+01:00`);

describe('HOME-17: the TGIF time and the 30-day clean-up', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let settings: PlanSettingsService;
  let job: TgifDailyNoticeService;
  let retention: TgifNoticeRetentionService;
  const PEOPLE = [uid(1), uid(2), uid(3)];
  const made: string[] = [];

  const edit = (key: string, value: unknown) =>
    settings.set(ADMIN, { settings: { [key]: value } });
  const noticesOn = (user: string, day: string) =>
    prisma.notification.count({
      where: {
        userWawuId: user,
        kind: TGIF_DAILY_KIND,
        target: { is: { targetKind: 'tgif_day', targetId: day } },
      },
    });
  const owed = () => prisma.userProfile.count();

  const wipeNotices = async () => {
    await prisma.notification.deleteMany({
      where: { kind: TGIF_DAILY_KIND },
    });
    await prisma.notification.deleteMany({
      where: { userWawuId: { in: PEOPLE } },
    });
    await prisma.tgifDailyNotice.deleteMany({});
  };
  const resetSettings = async () => {
    await prisma.planSetting.deleteMany({
      where: {
        key: {
          in: [TGIF_NOTIFICATION_TIME_SETTING, TGIF_NOTICE_RETENTION_SETTING],
        },
      },
    });
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
        NotificationModule,
        PlanSettingsModule,
      ],
      providers: [
        TgifContentService,
        TgifDailyNoticeService,
        TgifNoticeRetentionService,
      ],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    settings = moduleRef.get(PlanSettingsService);
    job = moduleRef.get(TgifDailyNoticeService);
    retention = moduleRef.get(TgifNoticeRetentionService);
    const have = new Set(
      (
        await prisma.userProfile.findMany({
          where: { wawuUserId: { in: PEOPLE } },
          select: { wawuUserId: true },
        })
      ).map((p) => p.wawuUserId),
    );
    const fresh = PEOPLE.filter((id) => !have.has(id));
    await prisma.userProfile.createMany({
      data: fresh.map((wawuUserId) => ({
        wawuUserId,
        accountType: 'user' as const,
      })),
    });
    made.push(...fresh);
  });

  beforeEach(async () => {
    await wipeNotices();
    await resetSettings();
  });

  afterAll(async () => {
    if (prisma) {
      await wipeNotices();
      await resetSettings();
      await prisma.userProfile.deleteMany({
        where: { wawuUserId: { in: made } },
      });
    }
    await moduleRef?.close();
  });

  it('the job is registered in the scheduler module beside the notice job', () => {
    const providers = Reflect.getMetadata(
      'providers',
      SchedulerModule,
    ) as unknown[];
    expect(providers).toEqual(
      expect.arrayContaining([
        TgifDailyNoticeService,
        TgifNoticeRetentionService,
      ]),
    );
    const imports = Reflect.getMetadata(
      'imports',
      SchedulerModule,
    ) as unknown[];
    expect(imports).toContain(PlanSettingsModule);
  });

  describe('changing the time of the notice', () => {
    it('with nothing edited, 07:00 Lagos is the time', async () => {
      expect(job.noticeMinutes()).toBe(7 * 60);
      expect(await job.run(lagos(D1, '06:59'))).toMatchObject({
        state: 'early',
      });
      expect(await job.run(lagos(D1, '07:00'))).toMatchObject({
        state: 'done',
      });
      expect(await noticesOn(PEOPLE[0], D1)).toBe(1);
    });

    it("a change after the day's notices went out sends nobody a second one that day, and moves the next day to the new time", async () => {
      const total = await owed();
      expect(await job.run(lagos(D1, '07:00'))).toMatchObject({
        state: 'done',
        written: total,
      });

      // The admin moves the time to 09:00 at 07:30, with the same running service.
      await edit(TGIF_NOTIFICATION_TIME_SETTING, '09:00');
      expect(job.noticeMinutes()).toBe(9 * 60);

      // The change day: before and after the new time, nothing more is made.
      expect(await job.run(lagos(D1, '07:35'))).toMatchObject({
        state: 'early',
        written: 0,
      });
      expect(await job.run(lagos(D1, '09:05'))).toMatchObject({
        state: 'done',
        written: 0,
      });
      for (const p of PEOPLE) expect(await noticesOn(p, D1)).toBe(1);

      // The next day: nothing at the old time, the notice at the new one.
      expect(await job.run(lagos(D2, '07:00'))).toMatchObject({
        state: 'early',
        written: 0,
      });
      expect(await job.run(lagos(D2, '08:59'))).toMatchObject({
        state: 'early',
        written: 0,
      });
      for (const p of PEOPLE) expect(await noticesOn(p, D2)).toBe(0);
      expect(await job.run(lagos(D2, '09:00'))).toMatchObject({
        state: 'done',
        written: total,
      });
      for (const p of PEOPLE) {
        expect(await noticesOn(p, D1)).toBe(1);
        expect(await noticesOn(p, D2)).toBe(1);
      }
    });

    it('moving the time EARLIER after the notices went out sends nobody a second one either', async () => {
      const total = await owed();
      expect(await job.run(lagos(D1, '07:00'))).toMatchObject({
        written: total,
      });
      await edit(TGIF_NOTIFICATION_TIME_SETTING, '06:00');
      expect(await job.run(lagos(D1, '07:35'))).toMatchObject({
        state: 'done',
        written: 0,
      });
      expect(await job.run(lagos(D1, '10:00'))).toMatchObject({ written: 0 });
      for (const p of PEOPLE) expect(await noticesOn(p, D1)).toBe(1);
      // Tomorrow it is 06:00.
      expect(await job.run(lagos(D2, '05:59'))).toMatchObject({
        state: 'early',
      });
      expect(await job.run(lagos(D2, '06:00'))).toMatchObject({
        state: 'done',
        written: total,
      });
    });

    it("a change made before the day's notices went out moves that day's too, and still makes one each", async () => {
      const total = await owed();
      expect(await job.run(lagos(D3, '06:30'))).toMatchObject({
        state: 'early',
      });
      await edit(TGIF_NOTIFICATION_TIME_SETTING, '06:15');
      expect(await job.run(lagos(D3, '06:30'))).toMatchObject({
        state: 'done',
        written: total,
      });
      expect(await job.run(lagos(D3, '07:00'))).toMatchObject({ written: 0 });
      for (const p of PEOPLE) expect(await noticesOn(p, D3)).toBe(1);
    });

    it('putting the default back returns the time to 07:00', async () => {
      await edit(TGIF_NOTIFICATION_TIME_SETTING, '09:00');
      expect(job.noticeMinutes()).toBe(9 * 60);
      await edit(TGIF_NOTIFICATION_TIME_SETTING, null);
      expect(job.noticeMinutes()).toBe(7 * 60);
    });

    it('does not read the retired TGIF_NOTIFICATION_TIME environment key', async () => {
      process.env.TGIF_NOTIFICATION_TIME = '03:00';
      try {
        expect(job.noticeMinutes()).toBe(7 * 60);
        expect(await job.run(lagos(D1, '04:00'))).toMatchObject({
          state: 'early',
        });
      } finally {
        delete process.env.TGIF_NOTIFICATION_TIME;
      }
    });
  });

  describe('clearing old daily notices', () => {
    const NOW = new Date('2027-06-20T12:00:00Z');
    const ago = (days: number) => new Date(NOW.getTime() - days * DAY_MS);
    let seq = 0;

    const make = async (
      kind: string,
      createdAt: Date,
      user: string = PEOPLE[0],
    ) => {
      seq += 1;
      const row = await prisma.notification.create({
        data: {
          userWawuId: user,
          kind,
          title: `home17 ${seq}`,
          body: 'x',
          tone: 'neutral',
          createdAt,
          target: {
            create: {
              targetKind: kind === TGIF_DAILY_KIND ? 'tgif_day' : 'content',
              targetId: `home17-${seq}`,
            },
          },
        },
      });
      return row.id;
    };
    const exists = async (id: string) =>
      (await prisma.notification.count({ where: { id } })) === 1;
    const targetExists = async (id: string) =>
      (await prisma.notificationTarget.count({
        where: { notificationId: id },
      })) === 1;

    it('keeps 30 days by default: older tgif_daily notices go, younger ones stay, and no other kind is touched', async () => {
      expect(settings.number(TGIF_NOTICE_RETENTION_SETTING)).toBe(30);
      const old = [
        await make(TGIF_DAILY_KIND, ago(30.01)),
        await make(TGIF_DAILY_KIND, ago(31)),
        await make(TGIF_DAILY_KIND, ago(400), PEOPLE[1]),
      ];
      const young = [
        await make(TGIF_DAILY_KIND, ago(29.9)),
        await make(TGIF_DAILY_KIND, ago(1)),
        await make(TGIF_DAILY_KIND, ago(0), PEOPLE[2]),
      ];
      // Every other kind, however old, is left alone.
      const others = [
        await make('campaign', ago(400)),
        await make('money_in', ago(45)),
        await make('community_join_approved', ago(31)),
        await make('tgif_daily_not_really', ago(100)),
      ];

      const report = await retention.run(NOW);
      expect(report).toMatchObject({
        deleted: old.length,
        days: 30,
        stoppedEarly: false,
        skipped: false,
      });
      for (const id of old) {
        expect(await exists(id)).toBe(false);
        expect(await targetExists(id)).toBe(false);
      }
      for (const id of [...young, ...others]) {
        expect(await exists(id)).toBe(true);
        expect(await targetExists(id)).toBe(true);
      }

      // A second run finds nothing.
      expect(await retention.run(NOW)).toMatchObject({
        deleted: 0,
        batches: 1,
      });
    });

    it('an admin edit of the days kept applies at the next run with no restart; the least is 1', async () => {
      const a = await make(TGIF_DAILY_KIND, ago(10));
      const b = await make(TGIF_DAILY_KIND, ago(5));
      const c = await make(TGIF_DAILY_KIND, ago(0.5));

      await edit(TGIF_NOTICE_RETENTION_SETTING, 7);
      expect(await retention.run(NOW)).toMatchObject({ deleted: 1, days: 7 });
      expect(await exists(a)).toBe(false);
      expect(await exists(b)).toBe(true);

      await edit(TGIF_NOTICE_RETENTION_SETTING, 1);
      expect(await retention.run(NOW)).toMatchObject({ deleted: 1, days: 1 });
      expect(await exists(b)).toBe(false);
      // A notice made this morning is never cleared the same day.
      expect(await exists(c)).toBe(true);

      await expect(
        edit(TGIF_NOTICE_RETENTION_SETTING, 0),
      ).rejects.toMatchObject({
        status: 400,
      });
      expect(settings.number(TGIF_NOTICE_RETENTION_SETTING)).toBe(1);
    });

    it('works in bounded batches, each one a single statement, never a transaction', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 23; i += 1)
        ids.push(await make(TGIF_DAILY_KIND, ago(40 + i)));
      const keep = await make(TGIF_DAILY_KIND, ago(2));
      const tx = jest.spyOn(prisma, '$transaction');
      const raw = jest.spyOn(prisma, '$queryRaw');
      try {
        const report = await retention.run(NOW, { batch: 5, budgetMs: 60_000 });
        expect(report).toMatchObject({
          deleted: 23,
          batches: 5,
          stoppedEarly: false,
        });
        expect(tx).not.toHaveBeenCalled();
        expect(raw).toHaveBeenCalledTimes(5);
      } finally {
        tx.mockRestore();
        raw.mockRestore();
      }
      expect(
        await prisma.notification.count({ where: { id: { in: ids } } }),
      ).toBe(0);
      expect(await exists(keep)).toBe(true);
    });

    it('stops at its time budget and leaves the rest to the next run', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 6; i += 1)
        ids.push(await make(TGIF_DAILY_KIND, ago(50)));
      const stopped = await retention.run(NOW, { batch: 2, budgetMs: -1 });
      expect(stopped).toMatchObject({
        deleted: 0,
        batches: 0,
        stoppedEarly: true,
      });
      expect(
        await prisma.notification.count({ where: { id: { in: ids } } }),
      ).toBe(6);
      expect(await retention.run(NOW)).toMatchObject({ deleted: 6 });
    });

    it('a second call while one runs in the same process does nothing', async () => {
      for (let i = 0; i < 12; i += 1) await make(TGIF_DAILY_KIND, ago(60));
      const [a, b] = await Promise.all([
        retention.run(NOW, { batch: 3, budgetMs: 60_000 }),
        retention.run(NOW, { batch: 3, budgetMs: 60_000 }),
      ]);
      expect([a.skipped, b.skipped].sort()).toEqual([false, true]);
      expect(a.deleted + b.deleted).toBe(12);
    });

    it('two servers running it at the same moment delete each notice once between them', async () => {
      const second = new TgifNoticeRetentionService(prisma, settings);
      const old: string[] = [];
      for (let i = 0; i < 120; i += 1)
        old.push(await make(TGIF_DAILY_KIND, ago(45 + (i % 9))));
      const young = await make(TGIF_DAILY_KIND, ago(3));
      const other = await make('campaign', ago(300));
      const limits = { batch: 7, budgetMs: 60_000 };

      const [a, b] = await Promise.all([
        retention.run(NOW, limits),
        second.run(NOW, limits),
      ]);
      expect(a.skipped || b.skipped).toBe(false);
      expect(a.deleted + b.deleted).toBe(120);
      expect(
        await prisma.notification.count({ where: { id: { in: old } } }),
      ).toBe(0);
      expect(await exists(young)).toBe(true);
      expect(await exists(other)).toBe(true);
      // Their targets went with them, and the others kept theirs.
      expect(
        await prisma.notificationTarget.count({
          where: { notificationId: { in: old } },
        }),
      ).toBe(0);
      expect(await targetExists(young)).toBe(true);
    });

    it('does not touch the once-a-day marker, so a cleared notice can never be made again', async () => {
      const total = await owed();
      expect(await job.run(lagos(D1, '07:00'))).toMatchObject({
        written: total,
      });
      // A year on, with the notices cleared, the same day is still one each.
      const later = new Date(lagos(D1, '07:00').getTime() + 365 * DAY_MS);
      const report = await retention.run(later);
      expect(report.deleted).toBe(total);
      expect(
        await prisma.tgifDailyNotice.count({
          where: { day: new Date(`${D1}T00:00:00Z`) },
        }),
      ).toBe(total);
      expect(await job.run(lagos(D1, '08:00'))).toMatchObject({ written: 0 });
      expect(await noticesOn(PEOPLE[0], D1)).toBe(0);
    });
  });
});
