// INBOX-03: the phone push sender behind NotificationService.
//
// Real Postgres, real NotificationService, real PushTokenService and
// PushSenderService. The ONLY stand-in is Expo's HTTP endpoint (a local server,
// expo-stand-in.ts): Expo's own hosts are not reachable from the sandbox this
// was built in, and no phone exists, so "Expo accepted it and the receipt says
// delivered" is shown against the documented wire shapes, never against the
// real service. See the builder report.

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { NotificationModule } from '../../notification/notification.module';
import { NotificationService } from '../../notification/notification.service';
import { AccountPurgeModule } from '../../account-purge/account-purge.module';
import { AccountPurgeService } from '../../account-purge/account-purge.service';
import { PushModule } from '../push.module';
import { PushTokenService } from '../push-token.service';
import { PushSenderService } from '../push-sender.service';
import { ExpoPushClient } from '../expo-push.client';
import { PUSH_MAX_TOKENS_PER_USER, PUSH_RETRY } from '../push-config';
import { EXPO_SHAPES, ExpoStandIn } from './expo-stand-in';

const RUN = Date.now().toString(36);
const uid = (n: number) =>
  `e5000000-0000-4000-8000-${RUN.padStart(6, '0').slice(-6)}${String(n).padStart(6, '0')}`;
const USER_A = uid(1);
const USER_B = uid(2);
const USER_C = uid(3);
const USERS = [USER_A, USER_B, USER_C];

let tokenSeq = 0;
const newToken = () => `ExponentPushToken[inbox03-${RUN}-${(tokenSeq += 1)}]`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An em-dash or an en-dash, written as escapes so this file has none. */
const DASHES = new RegExp('[\\u2014\\u2013]');

describe('Phone push sender (INBOX-03)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let notifications: NotificationService;
  let tokens: PushTokenService;
  let sender: PushSenderService;
  let expoClient: ExpoPushClient;
  const stand = new ExpoStandIn();
  const savedEnv = { ...process.env };

  const register = async (user: string, token = newToken()) => {
    await tokens.register(user, { expoPushToken: token, platform: 'android' });
    await sleep(8); // a notification must be written after the token to be pushed to it
    return token;
  };
  const tip = (user: string, amount = 850) =>
    notifications.emit({
      kind: 'tip_received',
      userWawuId: user,
      netAmount: amount,
    });
  const deliveriesOf = (user: string) =>
    prisma.pushDelivery.findMany({
      where: { userWawuId: user },
      orderBy: { createdAt: 'asc' },
    });
  const makeReceiptsDue = () =>
    prisma.pushDelivery.updateMany({
      where: { status: 'sent' },
      data: { receiptDueAt: new Date(Date.now() - 1000) },
    });
  const makeRetriesDue = () =>
    prisma.pushDelivery.updateMany({
      where: { status: 'pending' },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    });

  beforeAll(async () => {
    await stand.start();
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        NotificationModule,
        AccountPurgeModule,
        PushModule,
      ],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    notifications = moduleRef.get(NotificationService);
    tokens = moduleRef.get(PushTokenService);
    sender = moduleRef.get(PushSenderService);
    expoClient = moduleRef.get(ExpoPushClient);
    await moduleRef.init();
  }, 60000);

  const clean = async () => {
    await prisma.pushDelivery.deleteMany({
      where: { userWawuId: { in: USERS } },
    });
    await prisma.pushToken.deleteMany({ where: { userWawuId: { in: USERS } } });
    await prisma.notification.deleteMany({
      where: { userWawuId: { in: USERS } },
    });
    await prisma.notificationSettings.deleteMany({
      where: { userWawuId: { in: USERS } },
    });
  };

  beforeEach(async () => {
    await clean();
    stand.reset();
    process.env.PUSH_ENABLED = 'true';
    process.env.EXPO_PUSH_BASE_URL = stand.baseUrl;
    delete process.env.EXPO_ACCESS_TOKEN;
  });

  afterAll(async () => {
    await clean();
    process.env = savedEnv;
    await stand.stop();
    await moduleRef.close();
  });

  describe('capability 1 (the send and the receipt, against the stand-in)', () => {
    it('a notification for a registered phone is sent with its own words, a ticket is kept, and the receipt marks it delivered', async () => {
      process.env.EXPO_ACCESS_TOKEN = 'stand-in-access-token';
      const token = await register(USER_A);
      const row = await notifications.emit({
        kind: 'community_join_approved',
        userWawuId: USER_A,
        communityId: 'c0000000-0000-4000-8000-000000000001',
        communityName: 'Lagos Makers',
      });
      expect(row).not.toBeNull();

      const first = await sender.runOnce();
      expect(first.enqueued).toBe(1);
      expect(first.sent).toBe(1);

      const requests = stand.sendRequests();
      expect(requests).toHaveLength(1);
      expect(requests[0].headers.authorization).toBe(
        'Bearer stand-in-access-token',
      );
      expect(requests[0].headers.accept).toBe('application/json');
      expect(requests[0].headers['content-type']).toBe('application/json');
      const [message] = requests[0].json as Array<Record<string, unknown>>;
      expect(message.to).toBe(token);
      // the notification's own title and body, nothing composed here
      expect(message.title).toBe(row!.title);
      expect(message.body).toBe(row!.body);
      expect(message.data).toEqual({
        notificationId: row!.id,
        kind: 'community_join_approved',
        actionHref: '/communities/c0000000-0000-4000-8000-000000000001',
        target: {
          kind: 'community',
          id: 'c0000000-0000-4000-8000-000000000001',
        },
      });
      expect(JSON.stringify(message)).not.toMatch(DASHES);

      const [d1] = await deliveriesOf(USER_A);
      expect(d1.status).toBe('sent');
      expect(d1.ticketId).toBeTruthy();

      // not asked about before it is due (Expo recommends waiting)
      await sender.runOnce();
      expect(stand.receiptRequests()).toHaveLength(0);

      stand.receipts.set(d1.ticketId!, EXPO_SHAPES.ok);
      await makeReceiptsDue();
      const third = await sender.runOnce();
      expect(third.delivered).toBe(1);
      expect(stand.receiptRequests()).toHaveLength(1);
      expect(stand.receiptRequests()[0].json).toEqual({ ids: [d1.ticketId] });
      expect((await deliveriesOf(USER_A))[0].status).toBe('delivered');
    });

    it('a receipt Expo does not have yet is asked for again later, and a delivery with none after a day is expired', async () => {
      await register(USER_A);
      await tip(USER_A);
      await sender.runOnce();
      await makeReceiptsDue();
      await sender.runOnce(); // stand-in has no receipt: left out of the answer, as Expo does
      let [d] = await deliveriesOf(USER_A);
      expect(d.status).toBe('sent');
      expect(d.receiptChecks).toBe(1);
      expect(d.receiptDueAt!.getTime()).toBeGreaterThan(Date.now());

      await prisma.pushDelivery.update({
        where: { id: d.id },
        data: {
          receiptDueAt: new Date(Date.now() - 1000),
          sentAt: new Date(Date.now() - 25 * 3_600_000),
        },
      });
      await sender.runOnce();
      [d] = await deliveriesOf(USER_A);
      expect(d.status).toBe('expired');
    });

    it('sends in chunks of at most 100 messages', async () => {
      const row = (await tip(USER_A))!;
      void row;
      // 250 phones for one person, made directly: the cap belongs to register()
      await prisma.pushToken.createMany({
        data: Array.from({ length: 250 }, () => ({
          userWawuId: USER_A,
          expoPushToken: newToken(),
          platform: 'android',
          createdAt: new Date(Date.now() - 60_000),
        })),
      });
      const report = await sender.runOnce();
      expect(report.enqueued).toBe(250);
      expect(report.sent).toBe(250);
      const sizes = stand
        .sendRequests()
        .map((r) => (r.json as unknown[]).length);
      expect(sizes.sort((a, b) => b - a)).toEqual([100, 100, 50]);
    });

    it('asks for receipts in chunks of at most 300 ids', async () => {
      await tip(USER_A);
      await prisma.pushToken.createMany({
        data: Array.from({ length: 320 }, () => ({
          userWawuId: USER_A,
          expoPushToken: newToken(),
          platform: 'android',
          createdAt: new Date(Date.now() - 60_000),
        })),
      });
      await sender.runOnce();
      for (const d of await deliveriesOf(USER_A))
        stand.receipts.set(d.ticketId!, EXPO_SHAPES.ok);
      await makeReceiptsDue();
      const report = await sender.runOnce();
      expect(report.delivered).toBe(320);
      const sizes = stand
        .receiptRequests()
        .map((r) => (r.json as { ids: string[] }).ids.length);
      expect(sizes.sort((a, b) => b - a)).toEqual([300, 20]);
    });
  });

  describe('capability 2 (a category the person turned off is not sent)', () => {
    it('a kind whose switch is off is never written, so never sent', async () => {
      await register(USER_A);
      await prisma.notificationSettings.create({
        data: { userWawuId: USER_A, newFollowers: false },
      });
      expect(
        await notifications.emit({ kind: 'new_follower', userWawuId: USER_A }),
      ).toBeNull();
      await sender.runOnce();
      expect(stand.sendRequests()).toHaveLength(0);
      expect(await deliveriesOf(USER_A)).toHaveLength(0);
    });

    it('every switch that gates a pushed kind holds: moneyIn, contentReviews, refunds, dmReminders, newFollowers', async () => {
      await register(USER_A);
      await prisma.notificationSettings.create({
        data: {
          userWawuId: USER_A,
          newFollowers: false,
          dmReminders: false,
          refunds: false,
          moneyIn: false,
          contentReviews: false,
        },
      });
      const emitted = await Promise.all([
        notifications.emit({
          kind: 'tip_received',
          userWawuId: USER_A,
          netAmount: 1,
        }),
        notifications.emit({
          kind: 'sale',
          userWawuId: USER_A,
          contentTitle: 'x',
          netAmount: 1,
        }),
        notifications.emit({
          kind: 'dm_refunded',
          userWawuId: USER_A,
          amount: 1,
        }),
        notifications.emit({
          kind: 'dm_deadline',
          userWawuId: USER_A,
          hoursLeft: 3,
        }),
        notifications.emit({ kind: 'new_follower', userWawuId: USER_A }),
        notifications.emit({
          kind: 'content_published',
          userWawuId: USER_A,
          contentTitle: 'x',
        }),
        notifications.emit({
          kind: 'content_rejected',
          userWawuId: USER_A,
          contentTitle: 'x',
        }),
        notifications.emit({
          kind: 'review_received',
          userWawuId: USER_A,
          contentTitle: 'x',
          stars: 5,
        }),
      ]);
      expect(emitted.every((r) => r === null)).toBe(true);
      await sender.runOnce();
      expect(stand.sendRequests()).toHaveLength(0);
    });

    it('a switch turned off AFTER the notification was written and BEFORE the send is honoured', async () => {
      await register(USER_A);
      expect(await tip(USER_A)).not.toBeNull();
      await sender.enqueue();
      await prisma.notificationSettings.create({
        data: { userWawuId: USER_A, moneyIn: false },
      });
      const report = await sender.runOnce();
      expect(report.skipped).toBe(1);
      expect(stand.sendRequests()).toHaveLength(0);
      expect((await deliveriesOf(USER_A))[0]).toMatchObject({
        status: 'skipped',
        reason: 'switch_off',
      });
    });

    it('a paid question reaches the list whatever the switch says (G-24) but the phone does not buzz when "Paid questions" is off', async () => {
      await register(USER_A);
      await prisma.notificationSettings.create({
        data: { userWawuId: USER_A, dmReminders: false },
      });
      const row = await notifications.emit({
        kind: 'dm_received',
        userWawuId: USER_A,
        amount: 2000,
      });
      expect(row).not.toBeNull(); // the list is as it always was
      await sender.runOnce();
      expect(stand.sendRequests()).toHaveLength(0);
      expect((await deliveriesOf(USER_A))[0]).toMatchObject({
        status: 'skipped',
        reason: 'switch_off',
      });
    });

    it('a person with no settings row, or a switch never set, is pushed to', async () => {
      await register(USER_A);
      await tip(USER_A);
      await sender.runOnce();
      expect(stand.sentMessages()).toHaveLength(1);
    });

    it('kinds held for the owner are written to the list and never pushed', async () => {
      await register(USER_A);
      const rows = await Promise.all([
        notifications.emit({
          kind: 'kyc_verified',
          userWawuId: USER_A,
          approved: true,
        }),
        notifications.emit({
          kind: 'credits_low',
          userWawuId: USER_A,
          creditsCount: 1,
        }),
        notifications.emit({
          kind: 'verify_reminder',
          userWawuId: USER_A,
          audience: 'creator',
        }),
        notifications.emit({
          kind: 'paid_dm_paused',
          userWawuId: USER_A,
          unansweredPct: 40,
          windowDays: 14,
          pauseDays: 7,
          until: new Date(),
        }),
        notifications.emit({
          kind: 'campaign',
          userWawuId: USER_A,
          campaignId: 'c1',
          title: 'Hello',
          body: 'World',
          tone: 'info',
          imageUrl: null,
          actionLabel: null,
          actionHref: null,
        }),
      ]);
      expect(rows.every((r) => r !== null)).toBe(true);
      const report = await sender.runOnce();
      expect(report.enqueued).toBe(0);
      expect(stand.sendRequests()).toHaveLength(0);
    });

    it('a notification already read in the app is not pushed', async () => {
      await register(USER_A);
      const row = (await tip(USER_A))!;
      await sender.enqueue();
      await prisma.notification.update({
        where: { id: row.id },
        data: { read: true },
      });
      await sender.runOnce();
      expect(stand.sendRequests()).toHaveLength(0);
      expect((await deliveriesOf(USER_A))[0].reason).toBe('already_read');
    });
  });

  describe('capability 3 (a dead token is cleaned up)', () => {
    it('DeviceNotRegistered on the ticket disables the token, and nothing more is sent to it', async () => {
      const dead = await register(USER_A);
      const live = await register(USER_A);
      stand.ticketErrors.set(dead, 'DeviceNotRegistered');
      await tip(USER_A);
      const report = await sender.runOnce();
      expect(report.tokensDisabled).toBe(1);
      const rows = await prisma.pushToken.findMany({
        where: { userWawuId: USER_A },
      });
      const byToken = new Map(rows.map((r) => [r.expoPushToken, r]));
      expect(byToken.get(dead)!.disabledAt).not.toBeNull();
      expect(byToken.get(dead)!.disabledReason).toBe('DeviceNotRegistered');
      expect(byToken.get(live)!.disabledAt).toBeNull();

      stand.reset();
      await tip(USER_A);
      await sender.runOnce();
      expect(stand.sentMessages().map((m) => m.to)).toEqual([live]);
    });

    it('DeviceNotRegistered on the RECEIPT disables the token, once, however often it is read', async () => {
      const token = await register(USER_A);
      await tip(USER_A);
      await sender.runOnce();
      const [d] = await deliveriesOf(USER_A);
      stand.receipts.set(d.ticketId!, EXPO_SHAPES.deviceNotRegistered(token));
      await makeReceiptsDue();
      await sender.runOnce();
      const disabled = await prisma.pushToken.findUniqueOrThrow({
        where: { expoPushToken: token },
      });
      expect(disabled.disabledAt).not.toBeNull();
      expect((await deliveriesOf(USER_A))[0]).toMatchObject({
        status: 'failed',
        reason: 'DeviceNotRegistered',
      });

      // a second job, or a late repeat, changes nothing
      await prisma.pushDelivery.updateMany({
        data: { status: 'sent', receiptDueAt: new Date(Date.now() - 1000) },
      });
      await sender.runOnce();
      const again = await prisma.pushToken.findUniqueOrThrow({
        where: { expoPushToken: token },
      });
      expect(again.disabledAt!.getTime()).toBe(disabled.disabledAt!.getTime());
    });

    it('a late DeviceNotRegistered for a send made BEFORE the phone registered again does not kill the new registration', async () => {
      const token = await register(USER_A);
      await tip(USER_A);
      await sender.runOnce();
      const [d] = await deliveriesOf(USER_A);
      // the phone is signed in again by somebody else: the token moves and is new
      await sleep(8);
      await tokens.register(USER_B, {
        expoPushToken: token,
        platform: 'android',
      });
      stand.receipts.set(d.ticketId!, EXPO_SHAPES.deviceNotRegistered(token));
      await makeReceiptsDue();
      await sender.runOnce();
      const row = await prisma.pushToken.findUniqueOrThrow({
        where: { expoPushToken: token },
      });
      expect(row.userWawuId).toBe(USER_B);
      expect(row.disabledAt).toBeNull();
    });

    it('a dead token that registers again is live again, and is not sent what was written before', async () => {
      const token = await register(USER_A);
      await prisma.pushToken.update({
        where: { expoPushToken: token },
        data: { disabledAt: new Date(), disabledReason: 'DeviceNotRegistered' },
      });
      await tip(USER_A);
      await sleep(8);
      await tokens.register(USER_A, {
        expoPushToken: token,
        platform: 'android',
      });
      await sender.runOnce();
      expect(stand.sendRequests()).toHaveLength(0);
      const row = await prisma.pushToken.findUniqueOrThrow({
        where: { expoPushToken: token },
      });
      expect(row.disabledAt).toBeNull();
      await sleep(8);
      await tip(USER_A);
      await sender.runOnce();
      expect(stand.sentMessages()).toHaveLength(1);
    });

    it('a dead token disabled long ago is deleted by the hourly clean-up, a recent one is kept', async () => {
      const old = await register(USER_A);
      const recent = await register(USER_A);
      await prisma.pushToken.update({
        where: { expoPushToken: old },
        data: {
          disabledAt: new Date(Date.now() - 40 * 86_400_000),
          disabledReason: 'DeviceNotRegistered',
        },
      });
      await prisma.pushToken.update({
        where: { expoPushToken: recent },
        data: {
          disabledAt: new Date(Date.now() - 2 * 86_400_000),
          disabledReason: 'DeviceNotRegistered',
        },
      });
      // a fresh instance: prune runs at most once an hour per process
      await new PushSenderService(
        prisma,
        notifications,
        new ExpoPushClient(),
      ).prune();
      const left = (
        await prisma.pushToken.findMany({ where: { userWawuId: USER_A } })
      ).map((t) => t.expoPushToken);
      expect(left).toEqual([recent]);
    });
  });

  describe('a push failure never reaches the notification or its caller', () => {
    it('with Expo refusing connections the notification is written, and the delivery waits to retry with a growing delay', async () => {
      await register(USER_A);
      const closed = new ExpoStandIn();
      await closed.start();
      process.env.EXPO_PUSH_BASE_URL = closed.baseUrl;
      await closed.stop();
      const row = await tip(USER_A);
      expect(row).not.toBeNull();
      const report = await sender.runOnce();
      expect(report.retried).toBe(1);
      const [d] = await deliveriesOf(USER_A);
      expect(d).toMatchObject({
        status: 'pending',
        attempts: 1,
        reason: 'no_connection',
      });
      expect(d.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
      expect(
        await prisma.notification.count({ where: { userWawuId: USER_A } }),
      ).toBe(1);
    });

    it('a 429 and then a 500 are retried; Expo answering later sends it; five failures end it as failed', async () => {
      await register(USER_A);
      await tip(USER_A);
      stand.sendBehaviour = () => ({
        status: 429,
        body: EXPO_SHAPES.rateLimited,
      });
      await sender.runOnce();
      let [d] = await deliveriesOf(USER_A);
      expect(d).toMatchObject({
        status: 'pending',
        attempts: 1,
        reason: 'http_429',
      });

      stand.sendBehaviour = () => ({ status: 500, body: {} });
      await makeRetriesDue();
      await sender.runOnce();
      [d] = await deliveriesOf(USER_A);
      expect(d).toMatchObject({
        status: 'pending',
        attempts: 2,
        reason: 'http_500',
      });

      stand.sendBehaviour = null;
      await makeRetriesDue();
      await sender.runOnce();
      [d] = await deliveriesOf(USER_A);
      expect(d.status).toBe('sent');
      expect(d.attempts).toBe(3);

      await tip(USER_A, 900);
      stand.sendBehaviour = () => ({ status: 500, body: {} });
      for (let i = 0; i < PUSH_RETRY.maxAttempts + 1; i += 1) {
        await makeRetriesDue();
        await sender.runOnce();
      }
      const failed = (await deliveriesOf(USER_A)).find(
        (x) => x.status === 'failed',
      );
      expect(failed!.reason).toBe('retries_exhausted_http_500');
      expect(failed!.attempts).toBe(PUSH_RETRY.maxAttempts);
    });

    it('a request Expo refuses (4xx) fails the deliveries and is not retried', async () => {
      await register(USER_A);
      await tip(USER_A);
      stand.sendBehaviour = () => ({
        status: 400,
        body: EXPO_SHAPES.badRequest,
      });
      await sender.runOnce();
      expect((await deliveriesOf(USER_A))[0]).toMatchObject({
        status: 'failed',
        reason: 'VALIDATION_ERROR',
      });
      await makeRetriesDue();
      await sender.runOnce();
      expect(stand.sendRequests()).toHaveLength(1);
    });

    it('an answer that cannot be matched to the messages is failed and never sent again (it may have been accepted)', async () => {
      await register(USER_A);
      await tip(USER_A);
      stand.sendBehaviour = () => ({ status: 200, body: { data: [] } });
      await sender.runOnce();
      expect((await deliveriesOf(USER_A))[0]).toMatchObject({
        status: 'failed',
        reason: 'send_unconfirmed_unreadable_answer',
      });
      await sender.runOnce();
      expect(stand.sendRequests()).toHaveLength(1);
    });

    it('no answer in time is failed and never sent again', async () => {
      await register(USER_A);
      await tip(USER_A);
      const spy = jest
        .spyOn(expoClient, 'send')
        .mockResolvedValue({ kind: 'unknown', reason: 'timeout' });
      await sender.runOnce();
      spy.mockRestore();
      expect((await deliveriesOf(USER_A))[0]).toMatchObject({
        status: 'failed',
        reason: 'send_unconfirmed_timeout',
      });
    });

    it('a ticket error MessageTooBig fails that delivery only; MessageRateExceeded is retried', async () => {
      const big = await register(USER_A);
      const busy = await register(USER_A);
      await tip(USER_A);
      stand.sendBehaviour = (messages) => ({
        status: 200,
        body: {
          data: messages.map((m) =>
            m.to === big
              ? EXPO_SHAPES.messageTooBig
              : m.to === busy
                ? {
                    status: 'error',
                    message: 'rate',
                    details: { error: 'MessageRateExceeded' },
                  }
                : { status: 'ok', id: 'x' },
          ),
        },
      });
      await sender.runOnce();
      const ds = await deliveriesOf(USER_A);
      expect(ds.map((d) => d.status).sort()).toEqual(['failed', 'pending']);
      expect(ds.find((d) => d.status === 'failed')!.reason).toBe(
        'MessageTooBig',
      );
    });

    it('a sender that throws does not touch notifications, and the pass reports instead of throwing', async () => {
      await register(USER_A);
      const spy = jest
        .spyOn(expoClient, 'send')
        .mockRejectedValue(new Error('boom'));
      const row = await tip(USER_A);
      expect(row).not.toBeNull();
      await expect(sender.runOnce()).resolves.toBeDefined();
      spy.mockRestore();
      expect(
        await prisma.notification.count({ where: { userWawuId: USER_A } }),
      ).toBe(1);
      // the delivery was held when it threw; it is failed after the lock time, never sent twice
      await prisma.pushDelivery.updateMany({
        data: { lockedAt: new Date(Date.now() - 10 * 60_000) },
      });
      await sender.runOnce();
      expect((await deliveriesOf(USER_A))[0]).toMatchObject({
        status: 'failed',
        reason: 'send_interrupted',
      });
      expect(stand.sendRequests()).toHaveLength(0);
    });
  });

  describe('logs', () => {
    it('no log line carries a token or the words of a notification, on any path (refused, rate limited, unauthorised, dead token, thrown)', async () => {
      const logged: string[] = [];
      const spies = [process.stdout, process.stderr].map((stream) =>
        jest.spyOn(stream, 'write').mockImplementation((chunk: unknown) => {
          logged.push(String(chunk));
          return true;
        }),
      );
      try {
        const token = await register(USER_A);
        const dead = await register(USER_A);
        const row = (await tip(USER_A, 777))!;
        for (const [status, body] of [
          [400, EXPO_SHAPES.badRequest],
          [
            401,
            {
              errors: [{ code: 'UNAUTHORIZED', message: `bad token ${token}` }],
            },
          ],
          [429, EXPO_SHAPES.rateLimited],
          [500, { error: token }],
        ] as const) {
          stand.sendBehaviour = () => ({ status, body });
          // put the delivery back to be sent, whatever the last pass made of it
          await prisma.pushDelivery.updateMany({
            data: {
              status: 'pending',
              lockedAt: null,
              nextAttemptAt: new Date(Date.now() - 1000),
            },
          });
          await sender.runOnce();
        }
        expect(stand.sendRequests()).toHaveLength(4 * 1);
        stand.sendBehaviour = null;
        stand.ticketErrors.set(dead, 'DeviceNotRegistered');
        await prisma.pushDelivery.deleteMany({ where: { userWawuId: USER_A } });
        await sender.runOnce();
        stand.sendBehaviour = () => ({
          status: 200,
          body: {
            data: [
              {
                status: 'error',
                message: `no ${token}`,
                details: { error: 'InvalidCredentials' },
              },
            ],
          },
        });
        const spy = jest
          .spyOn(expoClient, 'send')
          .mockRejectedValue(new Error('boom'));
        await tip(USER_A, 778);
        await sender.runOnce();
        spy.mockRestore();
        const all = logged.join('\n');
        expect(all.length).toBeGreaterThan(0); // the failures were logged
        expect(all).not.toContain(token);
        expect(all).not.toContain(dead);
        expect(all).not.toContain(row.title);
        expect(all).not.toContain(row.body);
        expect(all).not.toContain(`inbox03-${RUN}`);
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    });
  });

  describe('the kill switch', () => {
    it('with PUSH_ENABLED not true nothing is enqueued, sent or fetched, whatever else is set', async () => {
      await register(USER_A);
      await tip(USER_A);
      for (const value of [undefined, '', 'false', '1', 'TRUE', 'yes']) {
        if (value === undefined) delete process.env.PUSH_ENABLED;
        else process.env.PUSH_ENABLED = value;
        const report = await sender.runOnce();
        expect(report).toMatchObject({ enqueued: 0, claimed: 0, sent: 0 });
      }
      expect(stand.requests).toHaveLength(0);
      expect(await deliveriesOf(USER_A)).toHaveLength(0);
    });

    it('turning it on pushes only what is recent, never a backlog', async () => {
      await register(USER_A);
      const old = (await tip(USER_A))!;
      await prisma.notification.update({
        where: { id: old.id },
        data: { createdAt: new Date(Date.now() - 3 * 3_600_000) },
      });
      await sender.runOnce();
      expect(stand.sendRequests()).toHaveLength(0);
    });
  });

  describe('who gets it', () => {
    it("a token that moves to another person is no longer pushed for the first person, and the second is not sent the first one's past", async () => {
      const token = await register(USER_A);
      await tip(USER_A);
      await sender.enqueue();
      await sleep(8);
      await tokens.register(USER_B, {
        expoPushToken: token,
        platform: 'android',
      });
      await sender.runOnce();
      expect(stand.sendRequests()).toHaveLength(0);
      expect((await deliveriesOf(USER_A))[0]).toMatchObject({
        status: 'skipped',
        reason: 'token_moved',
      });
      expect(await deliveriesOf(USER_B)).toHaveLength(0);
      await tip(USER_B);
      await sender.runOnce();
      expect(stand.sentMessages()).toHaveLength(1);
    });

    it('a signed-out phone (token removed) is not pushed, even with a send already queued', async () => {
      const token = await register(USER_A);
      await tip(USER_A);
      await sender.enqueue();
      await tokens.remove(USER_A, token);
      await sender.runOnce();
      expect(stand.sendRequests()).toHaveLength(0);
      expect(await deliveriesOf(USER_A)).toHaveLength(0); // the delivery went with the token
    });

    it('a person one phone per notification: two phones get two pushes, another person none', async () => {
      await register(USER_A);
      await register(USER_A);
      await register(USER_B);
      await tip(USER_A);
      await sender.runOnce();
      expect(stand.sentMessages()).toHaveLength(2);
    });

    it("account deletion removes the person's tokens and delivery log", async () => {
      await register(USER_C);
      await tip(USER_C);
      await sender.runOnce();
      expect(
        await prisma.pushToken.count({ where: { userWawuId: USER_C } }),
      ).toBe(1);
      const purge = moduleRef.get(AccountPurgeService);
      await purge.purge(USER_C);
      expect(
        await prisma.pushToken.count({ where: { userWawuId: USER_C } }),
      ).toBe(0);
      expect(
        await prisma.pushDelivery.count({ where: { userWawuId: USER_C } }),
      ).toBe(0);
    });
  });

  describe('two hub instances', () => {
    const second = () =>
      new PushSenderService(prisma, notifications, new ExpoPushClient());

    it('parallel passes in two instances send each notification to each phone exactly once', async () => {
      await register(USER_A);
      await register(USER_A);
      const ids: string[] = [];
      for (let i = 0; i < 20; i += 1)
        ids.push((await tip(USER_A, 100 + i))!.id);
      const other = second();
      for (let round = 0; round < 3; round += 1) {
        await Promise.all([
          sender.runOnce(),
          other.runOnce(),
          sender.runOnce(),
          other.runOnce(),
        ]);
      }
      const messages = stand.sentMessages();
      expect(messages).toHaveLength(40);
      const keys = messages.map(
        (m) =>
          `${(m.data as { notificationId: string }).notificationId}|${m.to}`,
      );
      expect(new Set(keys).size).toBe(40);
      expect(
        new Set(
          messages.map(
            (m) => (m.data as { notificationId: string }).notificationId,
          ),
        ),
      ).toEqual(new Set(ids));
      expect(
        await prisma.pushDelivery.count({
          where: { userWawuId: USER_A, status: 'sent' },
        }),
      ).toBe(40);
    });

    /** Holds a row lock on the user's deliveries the way another instance mid-claim would. */
    const holdDeliveries = async (user: string) => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked!: () => void;
      const isLocked = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const holder = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "PushDelivery" WHERE "userWawuId" = ${user} FOR UPDATE`;
          locked();
          await held;
        },
        { timeout: 30000 },
      );
      await isLocked;
      return { release, done: holder };
    };
    const within = async (ms: number, work: Promise<unknown>) =>
      Promise.race([work.then(() => 'done'), sleep(ms).then(() => 'blocked')]);

    it('a delivery another instance holds is skipped, not waited for, and is sent once when the holder lets go', async () => {
      await register(USER_A);
      await tip(USER_A);
      await sender.enqueue();
      const hold = await holdDeliveries(USER_A);
      let pass: Promise<unknown> = Promise.resolve();
      try {
        pass = sender.runOnce();
        expect(await within(3000, pass)).toBe('done');
        expect(stand.sendRequests()).toHaveLength(0);
      } finally {
        hold.release();
        await hold.done;
        await pass;
      }
      await sender.runOnce();
      expect(stand.sentMessages()).toHaveLength(1);
    });

    it('a receipt another instance holds is skipped, not waited for, and not asked about twice', async () => {
      await register(USER_A);
      await tip(USER_A);
      await sender.runOnce();
      const [d] = await deliveriesOf(USER_A);
      stand.receipts.set(d.ticketId!, EXPO_SHAPES.ok);
      await makeReceiptsDue();
      const hold = await holdDeliveries(USER_A);
      let pass: Promise<unknown> = Promise.resolve();
      try {
        pass = sender.collectReceipts();
        expect(await within(3000, pass)).toBe('done');
        expect(stand.receiptRequests()).toHaveLength(0);
      } finally {
        hold.release();
        await hold.done;
        await pass;
      }
      await sender.collectReceipts();
      expect(stand.receiptRequests()).toHaveLength(1);
      expect((await deliveriesOf(USER_A))[0].status).toBe('delivered');
    });

    it('parallel enqueues make one delivery per notification and phone', async () => {
      await register(USER_A);
      await tip(USER_A);
      const other = second();
      await Promise.all([
        sender.enqueue(),
        other.enqueue(),
        sender.enqueue(),
        other.enqueue(),
      ]);
      expect(await deliveriesOf(USER_A)).toHaveLength(1);
    });

    it('parallel receipt jobs process each delivery once and disable a dead token once', async () => {
      const dead = await register(USER_A);
      await register(USER_A);
      stand.ticketErrors.clear();
      for (let i = 0; i < 6; i += 1) await tip(USER_A, 200 + i);
      await sender.runOnce();
      for (const d of await deliveriesOf(USER_A)) {
        const msg = stand.ticketMessages.get(d.ticketId!)!;
        stand.receipts.set(
          d.ticketId!,
          msg.to === dead
            ? EXPO_SHAPES.deviceNotRegistered(dead)
            : EXPO_SHAPES.ok,
        );
      }
      await makeReceiptsDue();
      stand.requests.length = 0;
      const other = second();
      const reports = await Promise.all([
        sender.collectReceipts(),
        other.collectReceipts(),
        sender.collectReceipts(),
        other.collectReceipts(),
      ]);
      const asked = stand
        .receiptRequests()
        .flatMap((r) => (r.json as { ids: string[] }).ids);
      expect(asked).toHaveLength(12);
      expect(new Set(asked).size).toBe(12);
      expect(reports.reduce((n, r) => n + r.delivered, 0)).toBe(6);
      expect(reports.reduce((n, r) => n + r.tokensDisabled, 0)).toBe(6); // six dead-token receipts, one per delivery to it
      const ds = await deliveriesOf(USER_A);
      expect(ds.filter((d) => d.status === 'delivered')).toHaveLength(6);
      expect(ds.filter((d) => d.status === 'failed')).toHaveLength(6);
      const row = await prisma.pushToken.findUniqueOrThrow({
        where: { expoPushToken: dead },
      });
      expect(row.disabledAt).not.toBeNull();
    });
  });

  describe('tokens: parallel registration', () => {
    it('two people registering the same phone at the same moment leave exactly one owner', async () => {
      for (let i = 0; i < 10; i += 1) {
        const token = newToken();
        await Promise.all([
          tokens.register(USER_A, {
            expoPushToken: token,
            platform: 'android',
          }),
          tokens.register(USER_B, { expoPushToken: token, platform: 'ios' }),
        ]);
        const rows = await prisma.pushToken.findMany({
          where: { expoPushToken: token },
        });
        expect(rows).toHaveLength(1);
        expect([USER_A, USER_B]).toContain(rows[0].userWawuId);
      }
    });

    it('parallel registrations by one person never leave more than the cap, and keep the newest', async () => {
      const made = Array.from({ length: PUSH_MAX_TOKENS_PER_USER + 5 }, () =>
        newToken(),
      );
      await Promise.all(
        made.map((t) =>
          tokens.register(USER_A, { expoPushToken: t, platform: 'android' }),
        ),
      );
      expect(
        await prisma.pushToken.count({ where: { userWawuId: USER_A } }),
      ).toBe(PUSH_MAX_TOKENS_PER_USER);
      // one more, alone: the least recently seen goes, the new one stays
      const extra = newToken();
      await tokens.register(USER_A, {
        expoPushToken: extra,
        platform: 'android',
      });
      expect(
        await prisma.pushToken.count({ where: { userWawuId: USER_A } }),
      ).toBe(PUSH_MAX_TOKENS_PER_USER);
      expect(
        await prisma.pushToken.count({ where: { expoPushToken: extra } }),
      ).toBe(1);
    });
  });
});
