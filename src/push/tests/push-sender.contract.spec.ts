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

import { randomUUID } from 'crypto';
import { ConsoleLogger, Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TestingLogger } from '@nestjs/testing/services/testing-logger.service';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../../generated/prisma/client';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { NotificationModule } from '../../notification/notification.module';
import { NotificationService } from '../../notification/notification.service';
import { AccountPurgeModule } from '../../account-purge/account-purge.module';
import { AccountPurgeService } from '../../account-purge/account-purge.service';
import { BlockedAccountService } from '../../blocked-account/blocked-account.service';
import { PushModule } from '../push.module';
import { PushTokenService } from '../push-token.service';
import { PushSenderService } from '../push-sender.service';
import { ExpoPushClient } from '../expo-push.client';
import {
  PUSH_LOCK_SECONDS,
  PUSH_MAX_TOKENS_PER_USER,
  PUSH_RECEIPTS,
  PUSH_RETRY,
} from '../push-config';
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
  let blocks: BlockedAccountService;
  const stand = new ExpoStandIn();
  const savedEnv = { ...process.env };
  const savedTimeout = new ExpoPushClient().requestTimeoutMs;

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
  // Every write a spec makes is scoped to its own people: specs touch only
  // rows they create (lead ruling, 7 Oct 2026, VB-3).
  const makeReceiptsDue = () =>
    prisma.pushDelivery.updateMany({
      where: { status: 'sent', userWawuId: { in: USERS } },
      data: { receiptDueAt: new Date(Date.now() - 1000) },
    });
  const makeRetriesDue = () =>
    prisma.pushDelivery.updateMany({
      where: { status: 'pending', userWawuId: { in: USERS } },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    });
  /** Makes the rows a stopped instance would leave look older than the lock. */
  const ageLocks = (user: string) =>
    prisma.pushDelivery.updateMany({
      where: { userWawuId: user, status: { in: ['claimed', 'sending'] } },
      data: {
        lockedAt: new Date(Date.now() - (PUSH_LOCK_SECONDS + 60) * 1000),
      },
    });
  /** Another hub instance on the same database. */
  const second = () =>
    new PushSenderService(prisma, notifications, new ExpoPushClient(), blocks);

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
    blocks = moduleRef.get(BlockedAccountService);
    await moduleRef.init();
  }, 60000);

  const clean = async () => {
    await prisma.pushDelivery.deleteMany({
      where: { userWawuId: { in: USERS } },
    });
    await prisma.pushStoppedAccount.deleteMany({
      where: { userWawuId: { in: USERS } },
    });
    await prisma.blockedAccount.deleteMany({
      where: {
        OR: [{ userWawuId: { in: USERS } }, { blockedWawuId: { in: USERS } }],
      },
    });
    await prisma.contentPiece.deleteMany({
      where: { creatorWawuId: { in: USERS } },
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
    expoClient.requestTimeoutMs = savedTimeout;
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
      // the fields chosen for the message (Default (agent), owner may override)
      expect(message.priority).toBe('high');
      expect(Object.keys(message).sort()).toEqual(
        ['body', 'data', 'priority', 'title', 'to', 'ttl'].sort(),
      );

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

    // Its own time limit, like the receipts test below (VB-5).
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
    }, 60000);

    // Made directly as 320 sent rows (two statements), not by sending 320
    // pushes first, and given its own time limit: on a loaded machine the
    // 5 s default is not a property of the code under test (VB-5).
    it('asks for receipts in chunks of at most 300 ids', async () => {
      const note = (await tip(USER_A))!;
      const tokenRows = Array.from({ length: 320 }, () => ({
        id: randomUUID(),
        userWawuId: USER_A,
        expoPushToken: newToken(),
        platform: 'android',
      }));
      await prisma.pushToken.createMany({ data: tokenRows });
      await prisma.pushDelivery.createMany({
        data: tokenRows.map((t) => ({
          notificationId: note.id,
          userWawuId: USER_A,
          pushTokenId: t.id,
          status: 'sent',
          attempts: 1,
          ticketId: randomUUID(),
          sentAt: new Date(Date.now() - 60_000),
          receiptDueAt: new Date(Date.now() - 1000),
        })),
      });
      for (const d of await deliveriesOf(USER_A))
        stand.receipts.set(d.ticketId!, EXPO_SHAPES.ok);
      const report = await sender.collectReceipts();
      expect(report.delivered).toBe(320);
      const sizes = stand
        .receiptRequests()
        .map((r) => (r.json as { ids: string[] }).ids.length);
      expect(sizes.sort((a, b) => b - a)).toEqual([300, 20]);
    }, 60000);
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
        where: { userWawuId: USER_A },
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
      await second().prune();
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

    it('a sender that throws mid-send does not touch notifications, and the pass reports instead of throwing; the held row goes back to the queue once', async () => {
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
      // it threw after the row was marked `sending`: held until the lock time
      expect((await deliveriesOf(USER_A))[0]).toMatchObject({
        status: 'sending',
        attempts: 1,
      });
      await sender.runOnce();
      expect((await deliveriesOf(USER_A))[0].status).toBe('sending');
      // past the lock time the reaper puts it back once, with its attempt count
      await ageLocks(USER_A);
      await sender.runOnce();
      const [d] = await deliveriesOf(USER_A);
      expect(d).toMatchObject({ status: 'sent', attempts: 2 });
      expect(d.interruptedSend).toBe(true);
      expect(stand.sentMessages()).toHaveLength(1);
    });
  });

  describe('logs', () => {
    it('no log line carries a token or the words of a notification, on any path (refused, rate limited, unauthorised, not Expo, dead token, thrown), at any level', async () => {
      const logged: string[] = [];
      const spies = [process.stdout, process.stderr].map((stream) =>
        jest.spyOn(stream, 'write').mockImplementation((chunk: unknown) => {
          logged.push(String(chunk));
          return true;
        }),
      );
      // Nest's testing logger prints errors only; every level is printed
      // here, so a token in a log or warn line is seen too (D7).
      Logger.overrideLogger(new ConsoleLogger());
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
          [403, `<html>denied ${token}</html>`],
        ] as const) {
          stand.sendBehaviour = () => ({ status, body });
          // put the delivery back to be sent, whatever the last pass made of it
          await prisma.pushDelivery.updateMany({
            where: { userWawuId: USER_A },
            data: {
              status: 'pending',
              lockedAt: null,
              nextAttemptAt: new Date(Date.now() - 1000),
            },
          });
          await sender.runOnce();
        }
        expect(stand.sendRequests()).toHaveLength(5);
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
        // a receipt request that fails is a warn line
        const [sent] = await prisma.pushDelivery.findMany({
          where: { userWawuId: USER_A, status: 'sent' },
        });
        expect(sent).toBeDefined();
        stand.receiptBehaviour = () => ({
          status: 503,
          body: { error: token },
        });
        await makeReceiptsDue();
        await sender.runOnce();
        const all = logged.join('\n');
        // the failures were logged, the warnings among them
        expect(all).toContain('Expo refused a send request');
        expect(all).toContain('without an answer from Expo');
        expect(all).toContain('Receipt request failed');
        expect(all).not.toContain(token);
        expect(all).not.toContain(dead);
        expect(all).not.toContain(row.title);
        expect(all).not.toContain(row.body);
        expect(all).not.toContain(`inbox03-${RUN}`);
      } finally {
        Logger.overrideLogger(new TestingLogger());
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
  describe('a crash or a hung Expo loses nothing that was never sent (VB-1)', () => {
    /** The rows another instance claimed (or marked sending) before it stopped. */
    const leaveHeld = async (user: string, status: 'claimed' | 'sending') => {
      await sender.enqueue();
      await prisma.pushDelivery.updateMany({
        where: { userWawuId: user, status: 'pending' },
        data: {
          status,
          claimId: 'stopped-instance',
          attempts: 1,
          lockedAt: new Date(),
        },
      });
    };

    it('a batch claimed by an instance that stopped before sending is put back and sent, once each', async () => {
      await register(USER_A);
      await register(USER_A);
      for (let i = 0; i < 40; i += 1) await tip(USER_A, 300 + i);
      await leaveHeld(USER_A, 'claimed');
      // while the lock is fresh nobody touches it (D7)
      const early = await sender.runOnce();
      expect(early.requeued).toBe(0);
      expect(stand.sendRequests()).toHaveLength(0);
      await ageLocks(USER_A);
      const report = await sender.runOnce();
      expect(report.requeued).toBe(80);
      expect(report.sent).toBe(80);
      const keys = stand
        .sentMessages()
        .map(
          (m) =>
            `${(m.data as { notificationId: string }).notificationId}|${m.to}`,
        );
      expect(keys).toHaveLength(80);
      expect(new Set(keys).size).toBe(80);
      const ds = await deliveriesOf(USER_A);
      expect(ds.every((d) => d.status === 'sent' && d.attempts === 2)).toBe(
        true,
      );
      expect(ds.every((d) => !d.interruptedSend)).toBe(true);
    }, 60000);

    it('a row an instance stopped holding mid-send goes back once, keeping its attempt count; found mid-send again it is failed, never sent a third time', async () => {
      await register(USER_A);
      await tip(USER_A);
      await leaveHeld(USER_A, 'sending');
      await sender.runOnce();
      expect(stand.sendRequests()).toHaveLength(0); // fresh: still held
      await ageLocks(USER_A);
      await sender.runOnce();
      let [d] = await deliveriesOf(USER_A);
      expect(d).toMatchObject({
        status: 'sent',
        attempts: 2,
        interruptedSend: true,
      });
      expect(stand.sentMessages()).toHaveLength(1);

      // the same thing once more: no second chance
      await prisma.pushDelivery.update({
        where: { id: d.id },
        data: { status: 'sending', claimId: 'stopped-again' },
      });
      await ageLocks(USER_A);
      await sender.runOnce();
      [d] = await deliveriesOf(USER_A);
      expect(d).toMatchObject({ status: 'failed', reason: 'send_interrupted' });
      expect(stand.sentMessages()).toHaveLength(1);
    });

    it('a row out of attempts that an instance stopped holding is failed, not put back', async () => {
      await register(USER_A);
      await tip(USER_A);
      await leaveHeld(USER_A, 'claimed');
      await prisma.pushDelivery.updateMany({
        where: { userWawuId: USER_A },
        data: { attempts: PUSH_RETRY.maxAttempts },
      });
      await ageLocks(USER_A);
      await sender.runOnce();
      expect((await deliveriesOf(USER_A))[0]).toMatchObject({
        status: 'failed',
        reason: 'claim_interrupted',
      });
      expect(stand.sendRequests()).toHaveLength(0);
    });

    it('an instance whose claim was reaped and taken by another instance does not send it again', async () => {
      await register(USER_A);
      await tip(USER_A);
      await sender.enqueue();
      // instance A claims, then stalls past the lock
      const a = sender as unknown as {
        claim(id: string, limit: number): Promise<Array<{ id: string }>>;
        sendBatch(id: string, rows: unknown[], r: unknown): Promise<boolean>;
      };
      const held = await a.claim('instance-a', 10);
      expect(held).toHaveLength(1);
      await ageLocks(USER_A);
      // instance B reaps it and sends it
      await second().runOnce();
      expect(stand.sentMessages()).toHaveLength(1);
      // A wakes up and carries on with its old batch: nothing goes out
      await a.sendBatch('instance-a', held, {
        skipped: 0,
        sent: 0,
        failed: 0,
        retried: 0,
        tokensDisabled: 0,
      });
      expect(stand.sentMessages()).toHaveLength(1);
      expect((await deliveriesOf(USER_A))[0].status).toBe('sent');
    });

    it('a stale claim never puts a row on the wire while another instance holds it', async () => {
      await register(USER_A);
      await tip(USER_A);
      await sender.enqueue();
      const a = sender as unknown as {
        claim(id: string, limit: number): Promise<Array<{ id: string }>>;
        sendBatch(id: string, rows: unknown[], r: unknown): Promise<boolean>;
      };
      const held = await a.claim('instance-a', 10);
      await ageLocks(USER_A);
      expect(await sender.reapStuck()).toBe(1);
      // instance B has just claimed it and is checking it
      await prisma.pushDelivery.updateMany({
        where: { userWawuId: USER_A },
        data: {
          status: 'claimed',
          claimId: 'instance-b',
          lockedAt: new Date(),
        },
      });
      await a.sendBatch('instance-a', held, {
        skipped: 0,
        sent: 0,
        failed: 0,
        retried: 0,
        tokensDisabled: 0,
      });
      expect(stand.sendRequests()).toHaveLength(0);
      expect((await deliveriesOf(USER_A))[0]).toMatchObject({
        status: 'claimed',
        claimId: 'instance-b',
      });
    });

    it('an answer that comes back after the reaper took the row back changes nothing: the instance now sending it records its own ticket', async () => {
      await register(USER_A);
      await tip(USER_A);
      await sender.enqueue();
      const gate = () => {
        let open!: () => void;
        const opened = new Promise<void>((r) => (open = r));
        return { open, opened };
      };
      // instance A: its request reaches Expo, the answer is held up
      const a = gate();
      const aCalled = gate();
      const spyA = jest
        .spyOn(expoClient, 'send')
        .mockImplementation(async (messages) => {
          aCalled.open();
          await a.opened;
          return {
            kind: 'tickets',
            tickets: messages.map(() => ({ status: 'ok', id: 'late-from-a' })),
          };
        });
      const passA = sender.runOnce();
      await aCalled.opened;
      // past the lock, instance B takes the row back and is mid-send itself
      await ageLocks(USER_A);
      const clientB = new ExpoPushClient();
      const b = gate();
      const bCalled = gate();
      jest.spyOn(clientB, 'send').mockImplementation(async (messages) => {
        bCalled.open();
        await b.opened;
        return {
          kind: 'tickets',
          tickets: messages.map(() => ({ status: 'ok', id: 'from-b' })),
        };
      });
      const passB = new PushSenderService(
        prisma,
        notifications,
        clientB,
        blocks,
      ).runOnce();
      await bCalled.opened;
      // A's late answer arrives while B holds the row
      a.open();
      await passA;
      spyA.mockRestore();
      let [d] = await deliveriesOf(USER_A);
      expect(d).toMatchObject({ status: 'sending', ticketId: null });
      b.open();
      await passB;
      [d] = await deliveriesOf(USER_A);
      expect(d).toMatchObject({ status: 'sent', ticketId: 'from-b' });
    });

    // Found in round 2: with the table's statistics taken while it was empty,
    // `WHERE id IN (SELECT ... LIMIT 100 FOR UPDATE SKIP LOCKED)` became a
    // nested loop that ran the subquery again per row and claimed 162 rows.
    it('a claim takes at most one batch, whatever the planner believes about the table', async () => {
      await prisma.$executeRawUnsafe('ANALYZE "PushDelivery"');
      await prisma.pushToken.createMany({
        data: Array.from({ length: 250 }, () => ({
          userWawuId: USER_A,
          expoPushToken: newToken(),
          platform: 'android',
          createdAt: new Date(Date.now() - 60_000),
        })),
      });
      await tip(USER_A);
      expect(await sender.enqueue()).toBe(250);
      const claim = (
        sender as unknown as {
          claim(id: string, limit: number): Promise<unknown[]>;
        }
      ).claim.bind(sender);
      expect(await claim('batch-1', 100)).toHaveLength(100);
      expect(await claim('batch-2', 100)).toHaveLength(100);
      expect(await claim('batch-3', 100)).toHaveLength(50);
    }, 60000);

    it('a hung Expo fails only the batch that was on the wire (never resent); the rest is sent on the next pass', async () => {
      await prisma.pushToken.createMany({
        data: Array.from({ length: 250 }, () => ({
          userWawuId: USER_A,
          expoPushToken: newToken(),
          platform: 'android',
          createdAt: new Date(Date.now() - 60_000),
        })),
      });
      await tip(USER_A);
      expoClient.requestTimeoutMs = 300;
      let calls = 0;
      stand.sendBehaviour = (messages) => {
        calls += 1;
        return calls === 1
          ? { status: 200, body: { data: [] }, delayMs: 1500 }
          : {
              status: 200,
              body: {
                data: messages.map(() => ({ status: 'ok', id: randomUUID() })),
              },
            };
      };
      const first = await sender.runOnce();
      expect(first.claimed).toBe(100); // the pass stopped at the hung request
      let ds = await deliveriesOf(USER_A);
      expect(ds.filter((d) => d.status === 'failed')).toHaveLength(100);
      expect(
        ds
          .filter((d) => d.status === 'failed')
          .every((d) => d.reason === 'send_unconfirmed_timeout'),
      ).toBe(true);
      expect(ds.filter((d) => d.status === 'pending')).toHaveLength(150);
      // Expo answers again; the short limit was only for the hung request
      expoClient.requestTimeoutMs = savedTimeout;

      const second_ = await sender.runOnce();
      expect(second_.sent).toBe(150);
      ds = await deliveriesOf(USER_A);
      expect(ds.filter((d) => d.status === 'sent')).toHaveLength(150);
      // each phone was on the wire once: the 100 that timed out were not sent again
      const sentTo = stand.sentMessages().map((m) => m.to);
      expect(sentTo).toHaveLength(250);
      expect(new Set(sentTo).size).toBe(250);
    }, 60000);
  });

  describe('the real client when Expo does not answer in time (VB-6)', () => {
    it('a send with no answer in time is unknown: failed, and never sent again', async () => {
      await register(USER_A);
      await tip(USER_A);
      expoClient.requestTimeoutMs = 200;
      stand.sendBehaviour = () => ({
        status: 200,
        body: { data: [{ status: 'ok', id: randomUUID() }] },
        delayMs: 1000,
      });
      const report = await sender.runOnce();
      expect(report.failed).toBe(1);
      expect((await deliveriesOf(USER_A))[0]).toMatchObject({
        status: 'failed',
        reason: 'send_unconfirmed_timeout',
      });
      stand.sendBehaviour = null;
      await makeRetriesDue();
      await sender.runOnce();
      await sleep(1200); // the late answer arrives and changes nothing
      await sender.runOnce();
      expect(stand.sendRequests()).toHaveLength(1);
      expect((await deliveriesOf(USER_A))[0].status).toBe('failed');
    }, 30000);
  });

  describe("a refusal that is not Expo's own (D5)", () => {
    it('a 403 with no Expo error in it (a proxy) is retried, not taken as bad credentials', async () => {
      await register(USER_A);
      await tip(USER_A);
      stand.sendBehaviour = () => ({
        status: 403,
        body: '<html>denied</html>',
      });
      await sender.runOnce();
      expect((await deliveriesOf(USER_A))[0]).toMatchObject({
        status: 'pending',
        reason: 'http_403',
        attempts: 1,
      });
      stand.sendBehaviour = null;
      await makeRetriesDue();
      await sender.runOnce();
      expect((await deliveriesOf(USER_A))[0].status).toBe('sent');
    });

    it("a 401 in Expo's own error shape is a refusal: failed, not retried", async () => {
      await register(USER_A);
      await tip(USER_A);
      stand.sendBehaviour = () => ({
        status: 401,
        body: { errors: [{ code: 'UNAUTHORIZED', message: 'bad token' }] },
      });
      await sender.runOnce();
      expect((await deliveriesOf(USER_A))[0]).toMatchObject({
        status: 'failed',
        reason: 'UNAUTHORIZED',
      });
      await makeRetriesDue();
      await sender.runOnce();
      expect(stand.sendRequests()).toHaveLength(1);
    });
  });

  describe('blocks (VB-2)', () => {
    const block = (by: string, whom: string) =>
      prisma.blockedAccount.create({
        data: { userWawuId: by, blockedWawuId: whom },
      });
    const followedBy = (recipient: string, actor: string) =>
      notifications.emit({
        kind: 'new_follower',
        userWawuId: recipient,
        about: { target: { kind: 'profile', id: actor }, actorWawuId: actor },
      });

    it('a block made after the notification, by the recipient, means no push', async () => {
      await register(USER_A);
      expect(await followedBy(USER_A, USER_B)).not.toBeNull();
      await block(USER_A, USER_B);
      const report = await sender.runOnce();
      expect(report.skipped).toBe(1);
      expect(stand.sendRequests()).toHaveLength(0);
      expect((await deliveriesOf(USER_A))[0]).toMatchObject({
        status: 'skipped',
        reason: 'blocked',
      });
    });

    it('a block the other way (the actor blocked the recipient) means no push either', async () => {
      await register(USER_A);
      await followedBy(USER_A, USER_B);
      await block(USER_B, USER_A);
      await sender.runOnce();
      expect(stand.sendRequests()).toHaveLength(0);
      expect((await deliveriesOf(USER_A))[0].reason).toBe('blocked');
    });

    it('a notification about something else whose actor is blocked (a sale, a paid question) is not pushed', async () => {
      await register(USER_A);
      await notifications.emit({
        kind: 'dm_received',
        userWawuId: USER_A,
        amount: 2000,
        about: {
          target: { kind: 'paid_question', id: randomUUID() },
          actorWawuId: USER_B,
        },
      });
      await notifications.emit({
        kind: 'tip_received',
        userWawuId: USER_A,
        netAmount: 850,
        about: { target: { kind: 'profile', id: USER_C } },
      });
      await block(USER_A, USER_B);
      await block(USER_C, USER_A);
      await sender.runOnce();
      expect(stand.sendRequests()).toHaveLength(0);
      expect((await deliveriesOf(USER_A)).map((d) => d.reason)).toEqual([
        'blocked',
        'blocked',
      ]);
    });

    it('with no block the push goes, and carries the person it is about; no push ever carries a blocked person', async () => {
      await register(USER_A);
      await followedBy(USER_A, USER_B);
      await followedBy(USER_A, USER_C);
      await block(USER_A, USER_C);
      await sender.runOnce();
      const messages = stand.sentMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0].data).toMatchObject({
        target: { kind: 'profile', id: USER_B },
      });
      expect(JSON.stringify(stand.requests)).not.toContain(USER_C);
    });
  });

  describe('a scheduled account deletion (VU-2)', () => {
    it("forgets the person's phones and queued pushes, stores no new phone, and the sender sends nothing", async () => {
      const token = await register(USER_C);
      await tip(USER_C);
      await sender.enqueue();
      expect(await deliveriesOf(USER_C)).toHaveLength(1);
      await tokens.stopAccount(USER_C);
      expect(
        await prisma.pushToken.count({ where: { userWawuId: USER_C } }),
      ).toBe(0);
      expect(await deliveriesOf(USER_C)).toHaveLength(0);
      expect(
        await tokens.register(USER_C, {
          expoPushToken: token,
          platform: 'android',
        }),
      ).toBe(false);
      expect(
        await prisma.pushToken.count({ where: { userWawuId: USER_C } }),
      ).toBe(0);
      await tip(USER_C);
      await sender.runOnce();
      expect(stand.sendRequests()).toHaveLength(0);
      // asking twice is harmless
      await tokens.stopAccount(USER_C);
      expect(
        await prisma.pushStoppedAccount.count({
          where: { userWawuId: USER_C },
        }),
      ).toBe(1);
    });

    it('a phone that got in anyway (written before the stop reached it) is skipped at send time', async () => {
      await register(USER_C);
      await tip(USER_C);
      await sender.enqueue();
      await prisma.pushStoppedAccount.create({ data: { userWawuId: USER_C } });
      await sender.runOnce();
      expect(stand.sendRequests()).toHaveLength(0);
      expect((await deliveriesOf(USER_C))[0]).toMatchObject({
        status: 'skipped',
        reason: 'account_closing',
      });
    });

    it('the purge deletes the mark with the rest', async () => {
      await tokens.stopAccount(USER_C);
      await moduleRef.get(AccountPurgeService).purge(USER_C);
      expect(
        await prisma.pushStoppedAccount.count({
          where: { userWawuId: USER_C },
        }),
      ).toBe(0);
    });
  });

  describe('lock-screen words (VB-4)', () => {
    const REASON = 'Your cover shows a phone number, remove it';

    it("a piece sent back says so, with the piece's title and never the admin's reason", async () => {
      await register(USER_A);
      const piece = await prisma.contentPiece.create({
        data: {
          slug: `inbox03-${RUN}-rejected`,
          creatorWawuId: USER_A,
          contentType: 'video',
          title: 'Lagos at night',
          description: 'Made by push-sender.contract.spec.ts.',
          category: 'beauty',
          tags: [],
          accessType: 'free',
          price: 0,
          previewAssetUrl: 'https://storage.test/inbox03.mp4',
          status: 'rejected',
        },
      });
      const row = await notifications.emit({
        kind: 'content_rejected',
        userWawuId: USER_A,
        contentTitle: 'Lagos at night',
        reason: REASON,
        about: { target: { kind: 'content', id: piece.id } },
      });
      expect(row!.body).toContain(REASON); // the list keeps it
      await sender.runOnce();
      const [message] = stand.sentMessages();
      expect(message.title).toBe(row!.title);
      expect(message.body).toBe(
        '“Lagos at night” was sent back. Tap to see why.',
      );
      expect(JSON.stringify(stand.requests)).not.toContain(REASON);
    });

    it('with no piece to name, it still says the upload was sent back and nothing more', async () => {
      await register(USER_A);
      await notifications.emit({
        kind: 'content_rejected',
        userWawuId: USER_A,
        contentTitle: 'x',
        reason: REASON,
      });
      await sender.runOnce();
      expect(stand.sentMessages()[0].body).toBe(
        'Your upload was sent back. Tap to see why.',
      );
      expect(JSON.stringify(stand.requests)).not.toContain(REASON);
    });

    it('a review keeps its words: the piece title and the stars are public', async () => {
      await register(USER_A);
      const row = await notifications.emit({
        kind: 'review_received',
        userWawuId: USER_A,
        contentTitle: 'Lagos at night',
        stars: 4,
      });
      await sender.runOnce();
      expect(stand.sentMessages()[0].body).toBe(row!.body);
    });
  });

  // D4: the database's own clock in UTC for every write and comparison. Two
  // sessions whose time zone is not UTC, one each side of it: Lagos (+1, a
  // plausible production setting) and New York (-4 in October).
  describe.each(['Africa/Lagos', 'America/New_York'])(
    'a database session whose time zone is %s (D4)',
    (zone) => {
      let zoned: PrismaClient;
      let zSender: PushSenderService;
      let zTokens: PushTokenService;

      beforeAll(async () => {
        zoned = new PrismaClient({
          adapter: new PrismaPg({
            connectionString: process.env.DATABASE_URL,
            options: `-c TimeZone=${zone}`,
          }),
        });
        const [{ tz }] = await zoned.$queryRaw<Array<{ tz: string }>>`
          SELECT current_setting('TimeZone') AS "tz"`;
        expect(tz).toBe(zone);
        const asService = zoned as unknown as PrismaService;
        zSender = new PushSenderService(
          asService,
          notifications,
          expoClient,
          blocks,
        );
        zTokens = new PushTokenService(asService);
      });
      afterAll(async () => {
        await zoned.$disconnect();
      });

      const near = (at: Date | null, expectedMs: number) => {
        expect(at).not.toBeNull();
        expect(Math.abs(at!.getTime() - expectedMs)).toBeLessThan(30_000);
      };

      it('a phone registered just now gets a notification written just after, and its times read back as now', async () => {
        const token = newToken();
        await zTokens.register(USER_A, {
          expoPushToken: token,
          platform: 'android',
        });
        const row = await prisma.pushToken.findUniqueOrThrow({
          where: { expoPushToken: token },
        });
        near(row.createdAt, Date.now());
        near(row.lastSeenAt, Date.now());
        await sleep(8);
        await tip(USER_A);
        const report = await zSender.runOnce();
        expect(report.sent).toBe(1);
        const [d] = await deliveriesOf(USER_A);
        near(d.sentAt, Date.now());
        near(
          d.receiptDueAt,
          Date.now() + PUSH_RECEIPTS.firstCheckSeconds * 1000,
        );
      });

      it('a notification older than the look-back is not pushed', async () => {
        await zTokens.register(USER_A, {
          expoPushToken: newToken(),
          platform: 'android',
        });
        const old = (await tip(USER_A))!;
        await prisma.notification.update({
          where: { id: old.id },
          data: { createdAt: new Date(Date.now() - 3 * 3_600_000) },
        });
        await zSender.runOnce();
        expect(stand.sendRequests()).toHaveLength(0);
      });

      it('a retry waits its backoff and is taken when due, not hours early or late', async () => {
        await register(USER_A);
        await tip(USER_A);
        stand.sendBehaviour = () => ({ status: 503, body: {} });
        await zSender.runOnce();
        let [d] = await deliveriesOf(USER_A);
        expect(d.status).toBe('pending');
        near(d.nextAttemptAt, Date.now() + PUSH_RETRY.retryBaseSeconds * 1000);
        stand.sendBehaviour = null;
        await makeRetriesDue();
        await zSender.runOnce();
        [d] = await deliveriesOf(USER_A);
        expect(d.status).toBe('sent');
      });

      it('a receipt is asked for when due', async () => {
        await register(USER_A);
        await tip(USER_A);
        await zSender.runOnce();
        const [d] = await deliveriesOf(USER_A);
        stand.receipts.set(d.ticketId!, EXPO_SHAPES.ok);
        await zSender.runOnce();
        expect(stand.receiptRequests()).toHaveLength(0); // not due yet
        await makeReceiptsDue();
        const report = await zSender.runOnce();
        expect(report.delivered).toBe(1);
      });

      it('the reaper leaves a fresh hold alone and takes back an old one', async () => {
        await register(USER_A);
        await tip(USER_A);
        await zSender.enqueue();
        await prisma.pushDelivery.updateMany({
          where: { userWawuId: USER_A },
          data: { status: 'claimed', claimId: 'other', lockedAt: new Date() },
        });
        expect(await zSender.reapStuck()).toBe(0);
        await ageLocks(USER_A);
        expect(await zSender.reapStuck()).toBe(1);
      });
    },
  );
});
