// HOME-16: the daily TGIF notice, against a real Postgres, the real
// notification service, the real push sender (Expo's HTTP endpoint is the only
// stand-in, expo-stand-in.ts) and the real GET and PATCH /settings/tgif with
// tokens from the mock WAWU ID. Time is passed to the job (`run(now)`), so no
// test waits for a clock.

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationModule } from '../../notification/notification.module';
import { NotificationService } from '../../notification/notification.service';
import { tgifSeriesTitle } from '../../notification/notification-event';
import { PushModule } from '../../push/push.module';
import { PushSenderService } from '../../push/push-sender.service';
import { PushTokenService } from '../../push/push-token.service';
import { ExpoStandIn } from '../../push/tests/expo-stand-in';
import { TgifContentService } from '../../tgif/content/tgif-content.service';
import { TgifPreferenceModule } from '../../tgif-preference/tgif-preference.module';
import { TGIF_NOTICE_CHUNK } from '../tgif-daily-notice.config';
import { TgifDailyNoticeService } from '../tgif-daily-notice.service';

/** An em-dash or an en-dash, written as escapes so this file has none. */
const DASHES = new RegExp('[\\u2014\\u2013]');

const MOCK_WAWU_ID_URL =
  process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';
const RUN = Date.now().toString(36).padStart(8, '0').slice(-8);
const uid = (n: number) =>
  `e6000000-0000-4000-8000-${RUN}${String(n).padStart(4, '0')}`;

/** The two accounts the mock WAWU ID signs in: the ones whose token can PATCH /settings/tgif. */
const SIGNED_IN_A = '00000000-0000-4000-8000-000000000001';
const SIGNED_IN_B = '00000000-0000-4000-8000-000000000002';

// Days far from any other spec's, so cleaning them touches nothing else.
const D1 = '2027-03-10';
const D2 = '2027-03-11';
/** 07:00 and 07:30 in Lagos on D1 (UTC+1, no daylight saving). */
const AT_0700 = new Date('2027-03-10T06:00:00Z');
const AT_0730 = new Date('2027-03-10T06:30:00Z');
const AT_0810 = new Date('2027-03-10T07:10:00Z');
/** 07:00 in Lagos on D2. */
const NEXT_0700 = new Date('2027-03-11T06:00:00Z');

async function loginAs(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_WAWU_ID_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) throw new Error(`mock WAWU ID login failed: ${res.status}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('The daily TGIF notice (HOME-16)', () => {
  let moduleRef: TestingModule;
  let app: INestApplication;
  let prisma: PrismaService;
  let notifications: NotificationService;
  let content: TgifContentService;
  let job: TgifDailyNoticeService;
  let sender: PushSenderService;
  let tokens: PushTokenService;
  const stand = new ExpoStandIn();
  const savedEnv = { ...process.env };
  let tokenA: string;

  const SYNTHETIC = [uid(1), uid(2), uid(3)];
  const [S1, S2, S3] = SYNTHETIC;
  /** Profiles this spec made, so it removes only those. */
  const made: string[] = [];

  const profile = async (ids: string[]) => {
    const have = new Set(
      (
        await prisma.userProfile.findMany({
          where: { wawuUserId: { in: ids } },
          select: { wawuUserId: true },
        })
      ).map((p) => p.wawuUserId),
    );
    const fresh = ids.filter((id) => !have.has(id));
    for (let i = 0; i < fresh.length; i += 500) {
      await prisma.userProfile.createMany({
        data: fresh
          .slice(i, i + 500)
          .map((wawuUserId) => ({ wawuUserId, accountType: 'user' as const })),
      });
    }
    made.push(...fresh);
  };

  const noticesOf = (userWawuId: string, day = D1) =>
    prisma.notification.findMany({
      where: {
        userWawuId,
        kind: 'tgif_daily',
        target: { is: { targetKind: 'tgif_day', targetId: day } },
      },
      include: { target: true },
    });
  const patch = (show: boolean) =>
    request(app.getHttpServer())
      .patch('/api/hub/settings/tgif')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ show });

  const phoneFor = async (user: string) => {
    const expoPushToken = `ExponentPushToken[home16-${RUN}-${user.slice(-4)}]`;
    await tokens.register(user, { expoPushToken, platform: 'android' });
    await sleep(8); // a notification must be written after the token to be pushed to it
    return expoPushToken;
  };

  /** Everything a run of this spec made about TGIF, for every person: the table is this stack's own. */
  const wipe = async () => {
    await prisma.notification.deleteMany({ where: { kind: 'tgif_daily' } });
    await prisma.tgifDailyNotice.deleteMany({});
    await prisma.pushDelivery.deleteMany({
      where: { userWawuId: { in: [SIGNED_IN_A, SIGNED_IN_B, ...SYNTHETIC] } },
    });
    await prisma.pushToken.deleteMany({
      where: { userWawuId: { in: [SIGNED_IN_A, SIGNED_IN_B, ...SYNTHETIC] } },
    });
    await prisma.pushStoppedAccount.deleteMany({
      where: { userWawuId: { in: SYNTHETIC } },
    });
    await prisma.tgifPreference.deleteMany({
      where: { userWawuId: { in: [SIGNED_IN_A, SIGNED_IN_B, ...SYNTHETIC] } },
    });
  };

  beforeAll(async () => {
    await stand.start();
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PassportModule.register({ defaultStrategy: 'wawu-jwt' }),
        PrismaModule,
        WawuAuthModule,
        NotificationModule,
        TgifPreferenceModule,
        PushModule,
      ],
      providers: [TgifContentService, TgifDailyNoticeService],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/hub');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.listen(0, '127.0.0.1');
    prisma = moduleRef.get(PrismaService);
    notifications = moduleRef.get(NotificationService);
    content = moduleRef.get(TgifContentService);
    job = moduleRef.get(TgifDailyNoticeService);
    sender = moduleRef.get(PushSenderService);
    tokens = moduleRef.get(PushTokenService);
    tokenA = await loginAs('user@test.wawu.dev');
    await profile([SIGNED_IN_A, SIGNED_IN_B, ...SYNTHETIC]);
  }, 60000);

  beforeEach(async () => {
    await wipe();
    stand.reset();
    process.env.PUSH_ENABLED = 'true';
    process.env.EXPO_PUSH_BASE_URL = stand.baseUrl;
    delete process.env.EXPO_ACCESS_TOKEN;
  });

  afterAll(async () => {
    await wipe();
    await prisma.userProfile.deleteMany({
      where: { wawuUserId: { in: made } },
    });
    process.env = savedEnv;
    await stand.stop();
    await app.close();
  });

  /** How many people the job is owed to: everyone with a profile, TGIF not off, no deletion asked for. */
  const owed = async () =>
    prisma.userProfile.count({
      where: {
        NOT: {
          wawuUserId: {
            in: (
              await prisma.tgifPreference.findMany({
                where: { show: false },
                select: { userWawuId: true },
              })
            ).map((p) => p.userWawuId),
          },
        },
      },
    });

  describe('a person with TGIF on gets exactly one notice a day', () => {
    it('writes one notice, titled with that day, to each person who has TGIF on, and no second however often it looks', async () => {
      const day = content.day(D1, null);
      const first = await job.run(AT_0700);
      expect(first).toMatchObject({ day: D1, state: 'done' });
      expect(first.written).toBe(await owed());

      for (const id of [...SYNTHETIC, SIGNED_IN_A, SIGNED_IN_B]) {
        const rows = await noticesOf(id);
        expect(rows).toHaveLength(1);
        const [row] = rows;
        expect(row.title).toBe(`TGIF: ${tgifSeriesTitle(day.series)}`);
        expect(row.body).toBe(`Today's TGIF is ready. ${day.verseReference}.`);
        expect(row.title + row.body).not.toMatch(DASHES);
        expect(row.read).toBe(false);
        expect(row.tone).toBe('accent');
        expect(row.target).toMatchObject({
          targetKind: 'tgif_day',
          targetId: D1,
          actorWawuId: null,
        });
      }

      // The same morning, again and again: nothing more for anyone.
      const again = await job.run(AT_0730);
      const later = await job.run(AT_0810);
      expect(again).toMatchObject({ state: 'done', written: 0 });
      expect(later).toMatchObject({ state: 'done', written: 0 });
      for (const id of SYNTHETIC) expect(await noticesOf(id)).toHaveLength(1);
      expect(
        await prisma.tgifDailyNotice.count({ where: { userWawuId: S1 } }),
      ).toBe(1);
    });

    it('writes a new one the next day', async () => {
      await job.run(AT_0700);
      const next = await job.run(NEXT_0700);
      expect(next).toMatchObject({ day: D2, state: 'done' });
      expect(await noticesOf(S1, D1)).toHaveLength(1);
      expect(await noticesOf(S1, D2)).toHaveLength(1);
    });

    it('writes nothing before the set time or after the catch-up window', async () => {
      expect(await job.run(new Date('2027-03-10T05:59:00Z'))).toMatchObject({
        state: 'early',
        written: 0,
      });
      expect(await job.run(new Date('2027-03-10T10:00:00Z'))).toMatchObject({
        state: 'late',
        written: 0,
      });
      expect(
        await prisma.notification.count({ where: { kind: 'tgif_daily' } }),
      ).toBe(0);
      expect(await prisma.tgifDailyNotice.count()).toBe(0);
    });

    it('follows a set time other than the default', async () => {
      const config = moduleRef.get(ConfigService);
      const spy = jest
        .spyOn(config, 'get')
        .mockImplementation((key: string) =>
          key === 'TGIF_NOTIFICATION_TIME' ? '09:30' : undefined,
        );
      try {
        expect(await job.run(AT_0730)).toMatchObject({ state: 'early' });
        expect(await job.run(new Date('2027-03-10T08:30:00Z'))).toMatchObject({
          state: 'done',
        });
        expect(await noticesOf(S1)).toHaveLength(1);
      } finally {
        spy.mockRestore();
      }
    });

    it('does not write for a person whose deletion is asked for, and does not write for someone with no profile', async () => {
      await prisma.pushStoppedAccount.create({ data: { userWawuId: S2 } });
      await job.run(AT_0700);
      expect(await noticesOf(S2)).toHaveLength(0);
      expect(await noticesOf(S1)).toHaveLength(1);
      expect(
        await prisma.notification.count({
          where: { kind: 'tgif_daily', userWawuId: uid(9999) },
        }),
      ).toBe(0);
    });
  });

  describe('turning it off in Settings stops the next one', () => {
    it('a person who turned TGIF off with PATCH /settings/tgif gets none, and one who turns it on again gets one', async () => {
      await patch(false).expect(200);
      await prisma.tgifPreference.upsert({
        where: { userWawuId: S3 },
        create: { userWawuId: S3, show: false },
        update: { show: false },
      });

      await job.run(AT_0700);
      expect(await noticesOf(SIGNED_IN_A)).toHaveLength(0);
      expect(await noticesOf(S3)).toHaveLength(0);
      expect(await noticesOf(S1)).toHaveLength(1);
      expect(await noticesOf(SIGNED_IN_B)).toHaveLength(1);

      // Still off the next morning.
      await job.run(NEXT_0700);
      expect(await noticesOf(SIGNED_IN_A, D2)).toHaveLength(0);

      // On again: the next look makes that day's one notice, and no more.
      await patch(true).expect(200);
      await job.run(new Date('2027-03-11T06:05:00Z'));
      await job.run(new Date('2027-03-11T06:10:00Z'));
      expect(await noticesOf(SIGNED_IN_A, D2)).toHaveLength(1);
    });

    it('turning it off after the notice was made leaves that one and makes no second', async () => {
      await job.run(AT_0700);
      expect(await noticesOf(SIGNED_IN_A)).toHaveLength(1);
      await patch(false).expect(200);
      await job.run(AT_0810);
      expect(await noticesOf(SIGNED_IN_A)).toHaveLength(1);
      // The next morning there is none.
      await job.run(NEXT_0700);
      expect(await noticesOf(SIGNED_IN_A, D2)).toHaveLength(0);
    });

    it('the notification service itself writes none for a person who has it off', async () => {
      await prisma.tgifPreference.upsert({
        where: { userWawuId: S1 },
        create: { userWawuId: S1, show: false },
        update: { show: false },
      });
      const event = {
        kind: 'tgif_daily' as const,
        day: D1,
        series: 'THE EXCHANGE',
        verseReference: 'Romans 8:15 (NIV)',
      };
      expect(await notifications.emit({ ...event, userWawuId: S1 })).toBeNull();
      expect(
        await notifications.emit({ ...event, userWawuId: S2 }),
      ).not.toBeNull();
    });
  });

  describe('a day with no TGIF sends nothing', () => {
    it('writes no notice and no marker when the book cannot give the day', async () => {
      const broken = new TgifDailyNoticeService(
        prisma,
        notifications,
        {
          day: () => {
            throw new Error('TGIF book 03.json is not month 3 in full');
          },
        } as unknown as TgifContentService,
        moduleRef.get(ConfigService),
      );
      expect(await broken.run(AT_0700)).toEqual({
        day: D1,
        state: 'no_tgif',
        written: 0,
      });
      expect(
        await prisma.notification.count({ where: { kind: 'tgif_daily' } }),
      ).toBe(0);
      expect(await prisma.tgifDailyNotice.count()).toBe(0);
    });
  });

  describe('safe to run twice, and to fail', () => {
    it('two hub instances looking at the same moment make one notice per person', async () => {
      const other = new TgifDailyNoticeService(
        prisma,
        notifications,
        content,
        moduleRef.get(ConfigService),
      );
      const [a, b] = await Promise.all([job.run(AT_0700), other.run(AT_0700)]);
      expect(a.written + b.written).toBe(await owed());
      for (const id of SYNTHETIC) expect(await noticesOf(id)).toHaveLength(1);
      expect(
        await prisma.notification.count({ where: { kind: 'tgif_daily' } }),
      ).toBe(await owed());
    });

    it('works through more people than one chunk, each once', async () => {
      const crowd = Array.from({ length: TGIF_NOTICE_CHUNK * 2 + 37 }, (_, i) =>
        uid(10_000 + i),
      );
      await profile(crowd);
      const report = await job.run(AT_0700);
      expect(report.state).toBe('done');
      const total = await owed();
      expect(report.written).toBe(total);
      expect(
        await prisma.notification.count({ where: { kind: 'tgif_daily' } }),
      ).toBe(total);
      const dupes = await prisma.notification.groupBy({
        by: ['userWawuId'],
        where: { kind: 'tgif_daily' },
        _count: { _all: true },
        having: { userWawuId: { _count: { gt: 1 } } },
      });
      expect(dupes).toEqual([]);
      await prisma.notification.deleteMany({ where: { kind: 'tgif_daily' } });
      await prisma.tgifDailyNotice.deleteMany({});
      await prisma.userProfile.deleteMany({
        where: { wawuUserId: { in: crowd } },
      });
    });

    it('a failed write is undone, so the next look makes the notice', async () => {
      const spy = jest
        .spyOn(notifications, 'emitTgifDaily')
        .mockRejectedValueOnce(new Error('the write failed'));
      const failed = await job.run(AT_0700);
      expect(failed).toMatchObject({ state: 'failed', written: 0 });
      expect(await prisma.tgifDailyNotice.count()).toBe(0);
      expect(await noticesOf(S1)).toHaveLength(0);
      spy.mockRestore();

      const next = await job.run(AT_0730);
      expect(next.state).toBe('done');
      expect(await noticesOf(S1)).toHaveLength(1);
    });

    it('keeps the markers of the last few days and deletes older ones', async () => {
      await prisma.tgifDailyNotice.createMany({
        data: [
          { userWawuId: S1, day: new Date('2027-03-04T00:00:00Z') },
          { userWawuId: S1, day: new Date('2027-03-08T00:00:00Z') },
        ],
      });
      await job.run(AT_0700);
      const days = (
        await prisma.tgifDailyNotice.findMany({
          where: { userWawuId: S1 },
          select: { day: true },
          orderBy: { day: 'asc' },
        })
      ).map((r) => r.day.toISOString().slice(0, 10));
      expect(days).toEqual(['2027-03-08', D1]);
    });
  });

  describe('the phone push', () => {
    it('is sent through the push sender with the notice words and the day it opens', async () => {
      const token = await phoneFor(S1);
      await job.run(AT_0700);
      const [row] = await noticesOf(S1);
      const report = await sender.runOnce();
      expect(report.sent).toBeGreaterThanOrEqual(1);
      const mine = stand.sentMessages().filter((m) => m.to === token);
      expect(mine).toHaveLength(1);
      expect(mine[0].title).toBe(row.title);
      expect(mine[0].body).toBe(row.body);
      expect(mine[0].data).toEqual({
        notificationId: row.id,
        kind: 'tgif_daily',
        target: { kind: 'tgif_day', id: D1 },
      });
      expect(JSON.stringify(mine[0])).not.toMatch(DASHES);
    });

    it('is not sent once the person has turned TGIF off, though the notice was already written', async () => {
      const token = await phoneFor(SIGNED_IN_A);
      await job.run(AT_0700);
      expect(await noticesOf(SIGNED_IN_A)).toHaveLength(1);
      await patch(false).expect(200);
      await sender.runOnce();
      expect(stand.sentMessages().filter((m) => m.to === token)).toHaveLength(
        0,
      );
      const deliveries = await prisma.pushDelivery.findMany({
        where: { userWawuId: SIGNED_IN_A },
      });
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]).toMatchObject({
        status: 'skipped',
        reason: 'switch_off',
      });
    });

    it('is the only push a person gets for the day, however often the job and the sender look', async () => {
      const token = await phoneFor(S2);
      await job.run(AT_0700);
      await sender.runOnce();
      await job.run(AT_0730);
      await sender.runOnce();
      await job.run(AT_0810);
      await sender.runOnce();
      expect(stand.sentMessages().filter((m) => m.to === token)).toHaveLength(
        1,
      );
    });
  });

  it('makes no call to Expo itself: only the push sender reaches it', async () => {
    await phoneFor(S1);
    await job.run(AT_0700);
    expect(stand.requests).toHaveLength(0);
  });
});
