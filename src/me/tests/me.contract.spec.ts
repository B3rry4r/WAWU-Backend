// Contract tests for task ME-10: GET /me/counts, /me/saved (and saving a
// creator), /me/purchases (and lesson progress), /me/notifications and
// /me/earnings (and its sales).
//
// Real HTTP against the caller's DATABASE_URL, with real RS256 tokens from
// mock-wawu-id (its port from WAWU_ID_JWKS_URL, else 4001), like every other
// contract spec. Notifications are written by the real emit sites (a follow,
// a content unlock, a paid question, a tip, a rating), not inserted by hand.
// Everything this spec writes it removes, so the seeded world is left as it
// was found.

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { ChildProcess, spawn } from 'child_process';
import type { Server } from 'http';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { NotificationModule } from '../../notification/notification.module';
import { PurchaseModule } from '../../purchase/purchase.module';
import { ContentPieceModule } from '../../content-piece/content-piece.module';
import { DirectMessageModule } from '../../direct-message/direct-message.module';
import { FollowRelationshipModule } from '../../follow-relationship/follow-relationship.module';
import { BlockedAccountModule } from '../../blocked-account/blocked-account.module';
import { MeModule } from '../me.module';
import { lagosMonthOf } from '../me-earnings.service';
import type {
  EarningSalePage,
  LessonDoneState,
  MeCountsView,
  MyEarningsView,
  NotificationFeedItem,
  NotificationFeedPage,
  PurchasePage,
  SavedCreatorState,
  SavedPage,
} from '../me-view.type';

/** The `data` of a success body, typed as the route's contract says. */
const dataOf = <T>(res: { body: unknown }): T => (res.body as { data: T }).data;

// Seeded WAWU IDs (mock-wawu-id/server.js, prisma/seed.ts).
const PLAIN = '00000000-0000-4000-8000-000000000001';
const BASIC = '00000000-0000-4000-8000-000000000002'; // creator
const PRO = '00000000-0000-4000-8000-000000000003'; // creator, dmPrice 300
const SEEDED_USERS = [PLAIN, BASIC, PRO];

// Seeded pieces and rows.
const CAC_COURSE = '10000000-0000-4000-8000-000000000001'; // PRO, paid ₦5,000, 2 lessons, PLAIN bought it
const MAKEUP_VIDEO = '10000000-0000-4000-8000-000000000002'; // BASIC, free
const INVOICE_TEMPLATE = '10000000-0000-4000-8000-000000000003'; // PRO, paid ₦1,500
const LESSON_1 = '11000000-0000-4000-8000-000000000001';
const LESSON_2 = '11000000-0000-4000-8000-000000000002';
const SEEDED_NOTIFICATIONS = [
  'a0000000-0000-4000-8000-000000000001',
  'a0000000-0000-4000-8000-000000000002',
];

// Rows this spec makes and removes.
const EVENT_ID = 'e1000000-0000-4000-8000-0000000000e1';
const ROOM_ID = 'e1000000-0000-4000-8000-0000000000c1';
const PURCHASE_PREFIX = 'me10-';

const MOCK_WAWU_ID_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_WAWU_ID_BASE = `http://localhost:${MOCK_WAWU_ID_PORT}`;

async function waitForHealth(url: string, timeoutMs = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function login(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_WAWU_ID_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) throw new Error(`mock-wawu-id login failed for ${identifier}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

describe('ME-10: the caller’s own lists (contract)', () => {
  let moduleRef: TestingModule;
  let app: INestApplication;
  let prisma: PrismaService;
  let mockWawuId: ChildProcess | undefined;
  let plain: string;
  let basic: string;
  let pro: string;

  const http = () => request(app.getHttpServer() as Server);
  const get = (token: string, url: string) =>
    http().get(url).set('Authorization', `Bearer ${token}`);

  async function cleanUp(): Promise<void> {
    await prisma.notification.deleteMany({
      where: {
        userWawuId: { in: SEEDED_USERS },
        id: { notIn: SEEDED_NOTIFICATIONS },
      },
    });
    await prisma.savedCreator.deleteMany({
      where: { userWawuId: { in: SEEDED_USERS } },
    });
    await prisma.savedItem.deleteMany({
      where: {
        userWawuId: PLAIN,
        contentId: { in: [MAKEUP_VIDEO, INVOICE_TEMPLATE] },
      },
    });
    await prisma.eventSave.deleteMany({ where: { eventId: EVENT_ID } });
    await prisma.event.deleteMany({ where: { id: EVENT_ID } });
    await prisma.courseLessonProgress.deleteMany({
      where: { userWawuId: { in: SEEDED_USERS } },
    });
    await prisma.blockedAccount.deleteMany({
      where: {
        userWawuId: { in: SEEDED_USERS },
        blockedWawuId: { in: SEEDED_USERS },
      },
    });
    await prisma.followRelationship.deleteMany({
      where: { followerWawuId: PLAIN, followingWawuId: BASIC },
    });
    await prisma.contentRating.deleteMany({
      where: { userWawuId: PLAIN, contentId: CAC_COURSE },
    });
    await prisma.purchase.deleteMany({
      where: {
        OR: [
          { flutterwaveTxRef: { startsWith: PURCHASE_PREFIX } },
          { buyerWawuId: PLAIN, contentId: INVOICE_TEMPLATE },
          { buyerWawuId: PLAIN, type: 'tip', creatorWawuId: BASIC },
        ],
      },
    });
    await prisma.directMessage.deleteMany({
      where: {
        OR: [
          { flutterwaveTxRef: { startsWith: PURCHASE_PREFIX } },
          { senderWawuId: PLAIN, text: 'ME-10 asks a paid question.' },
        ],
      },
    });
    await prisma.creditSpend.deleteMany({ where: { communityId: ROOM_ID } });
    await prisma.community.deleteMany({ where: { id: ROOM_ID } });
  }

  beforeAll(async () => {
    if (!(await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`, 1000))) {
      mockWawuId = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '../../../mock-wawu-id'),
        env: { ...process.env, MOCK_WAWU_ID_PORT },
        stdio: 'ignore',
      });
      if (!(await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`))) {
        throw new Error('mock-wawu-id did not become healthy in time');
      }
    }
    plain = await login('user@test.wawu.dev');
    basic = await login('creator-basic@test.wawu.dev');
    pro = await login('creator-pro@test.wawu.dev');

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        NotificationModule,
        BlockedAccountModule,
        PurchaseModule,
        ContentPieceModule,
        DirectMessageModule,
        FollowRelationshipModule,
        MeModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();
    prisma = moduleRef.get(PrismaService);
    await cleanUp();
  }, 40000);

  afterAll(async () => {
    await cleanUp();
    await app?.close();
    mockWawuId?.kill();
  });

  // -------------------------------------------------------------------------
  describe('every route needs a signed-in caller', () => {
    it.each([
      ['get', '/me/counts'],
      ['get', '/me/saved'],
      ['put', `/me/saved/creators/${BASIC}`],
      ['delete', `/me/saved/creators/${BASIC}`],
      ['get', '/me/purchases'],
      ['put', `/me/lessons/${LESSON_1}/done`],
      ['delete', `/me/lessons/${LESSON_1}/done`],
      ['get', '/me/notifications'],
      ['get', '/me/earnings'],
      ['get', '/me/earnings/sales'],
    ] as const)('%s %s without a token is 401', async (method, url) => {
      await http()[method](url).expect(401);
    });
  });

  // -------------------------------------------------------------------------
  describe('Saved (M30)', () => {
    beforeAll(async () => {
      // PLAIN has the seeded save of CAC_COURSE (PRO's). Add a free piece of
      // BASIC's, an event BASIC hosts, and BASIC as a creator, in that order.
      await prisma.savedItem.create({
        data: {
          userWawuId: PLAIN,
          contentId: MAKEUP_VIDEO,
          savedAt: new Date(Date.now() - 3000),
        },
      });
      await prisma.event.create({
        data: {
          id: EVENT_ID,
          hostWawuId: BASIC,
          name: 'ME-10 Lagos Creators Meetup',
          description: 'A meetup.',
          hostOrg: 'Chidi Creates',
          format: 'in_person',
          type: 'meetup',
          startsAt: new Date('2027-10-04T15:00:00.000Z'),
          location: 'Lagos',
          status: 'published',
        },
      });
      await prisma.eventSave.create({
        data: {
          eventId: EVENT_ID,
          userWawuId: PLAIN,
          savedAt: new Date(Date.now() - 2000),
        },
      });
    });

    it('a user can save a creator, and saving again changes nothing', async () => {
      const first = await http()
        .put(`/me/saved/creators/${BASIC}`)
        .set('Authorization', `Bearer ${plain}`)
        .expect(200);
      expect(dataOf<SavedCreatorState>(first)).toEqual({
        creatorWawuId: BASIC,
        saved: true,
      });
      await http()
        .put(`/me/saved/creators/${BASIC}`)
        .set('Authorization', `Bearer ${plain}`)
        .expect(200);
      expect(
        await prisma.savedCreator.count({ where: { userWawuId: PLAIN } }),
      ).toBe(1);
    });

    it('a user sees everything saved, newest first, with what each card needs', async () => {
      const res = await get(plain, '/me/saved').expect(200);
      const items = dataOf<SavedPage>(res).items;
      expect(items.map((i) => i.kind)).toEqual([
        'creator',
        'event',
        'content',
        'content',
      ]);
      expect(dataOf<SavedPage>(res).nextCursor).toBeNull();
      const [creator, event, free, bought] = items;
      expect(creator.creator!.wawuId).toBe(BASIC);
      expect(creator.creator!.handle).toBe('chidi-creates');
      expect(creator.content).toBeNull();
      expect(event.event).toMatchObject({
        id: EVENT_ID,
        name: 'ME-10 Lagos Creators Meetup',
        startsAt: '2027-10-04T15:00:00.000Z',
        status: 'published',
      });
      expect(free.content).toMatchObject({
        id: MAKEUP_VIDEO,
        accessType: 'free',
        priceKobo: null,
        bought: false,
      });
      // M30 "Bought": PLAIN has a completed purchase of the course.
      expect(bought.content).toMatchObject({
        id: CAC_COURSE,
        accessType: 'paid',
        priceKobo: 500000,
        bought: true,
      });
      expect(bought.content!.creator.wawuId).toBe(PRO);
    });

    it('a user can filter by tab', async () => {
      const kinds = async (type: string) =>
        dataOf<SavedPage>(
          await get(plain, `/me/saved?type=${type}`).expect(200),
        ).items.map((i) => i.kind);
      expect(await kinds('content')).toEqual(['content', 'content']);
      expect(await kinds('events')).toEqual(['event']);
      expect(await kinds('creators')).toEqual(['creator']);
      await get(plain, '/me/saved?type=products').expect(400);
    });

    it('pages across all three tables with an opaque cursor, each row once', async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 6; i += 1) {
        const url: string = `/me/saved?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const page: SavedPage = dataOf<SavedPage>(
          await get(plain, url).expect(200),
        );
        seen.push(...page.items.map((it) => it.id));
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      expect(seen).toHaveLength(4);
      expect(new Set(seen).size).toBe(4);
      await get(plain, '/me/saved?cursor=not-ours').expect(400);
      await get(plain, '/me/saved?limit=0').expect(400);
      await get(plain, '/me/saved?limit=101').expect(400);
    });

    it('counts what it lists (M7 "Saved")', async () => {
      const res = await get(plain, '/me/counts').expect(200);
      expect(dataOf<MeCountsView>(res).saved).toBe(4);
    });

    it('a block hides saves of that person (SETTINGS-04), in both directions, and unblocking brings them back', async () => {
      // PLAIN blocks BASIC: BASIC's piece, event and BASIC drop out.
      await prisma.blockedAccount.create({
        data: { userWawuId: PLAIN, blockedWawuId: BASIC },
      });
      let res = await get(plain, '/me/saved').expect(200);
      expect(dataOf<SavedPage>(res).items.map((i) => i.kind)).toEqual([
        'content',
      ]);
      expect(dataOf<MeCountsView>(await get(plain, '/me/counts')).saved).toBe(
        1,
      );
      await prisma.blockedAccount.deleteMany({
        where: { userWawuId: PLAIN, blockedWawuId: BASIC },
      });

      // PRO blocks PLAIN: PRO's course drops out of PLAIN's list.
      await prisma.blockedAccount.create({
        data: { userWawuId: PRO, blockedWawuId: PLAIN },
      });
      res = await get(plain, '/me/saved?type=content').expect(200);
      expect(dataOf<SavedPage>(res).items.map((i) => i.content!.id)).toEqual([
        MAKEUP_VIDEO,
      ]);
      // Saving a person who blocked you is the same 404 as nobody.
      await http()
        .put(`/me/saved/creators/${PRO}`)
        .set('Authorization', `Bearer ${plain}`)
        .expect(404);
      await prisma.blockedAccount.deleteMany({
        where: { userWawuId: PRO, blockedWawuId: PLAIN },
      });

      expect(dataOf<MeCountsView>(await get(plain, '/me/counts')).saved).toBe(
        4,
      );
    });

    it('a piece no longer live and an event taken down are not listed', async () => {
      await prisma.event.update({
        where: { id: EVENT_ID },
        data: { status: 'removed' },
      });
      let res = await get(plain, '/me/saved?type=events').expect(200);
      expect(dataOf<SavedPage>(res).items).toEqual([]);
      // Called off is still listed, marked so.
      await prisma.event.update({
        where: { id: EVENT_ID },
        data: { status: 'cancelled' },
      });
      res = await get(plain, '/me/saved?type=events').expect(200);
      expect(dataOf<SavedPage>(res).items[0].event!.status).toBe('cancelled');
      await prisma.event.update({
        where: { id: EVENT_ID },
        data: { status: 'published' },
      });
    });

    it('refuses saving yourself, nobody, or a malformed id; unsaving is idempotent', async () => {
      await http()
        .put(`/me/saved/creators/${PLAIN}`)
        .set('Authorization', `Bearer ${plain}`)
        .expect(400);
      await http()
        .put('/me/saved/creators/e1000000-0000-4000-8000-0000000000ff')
        .set('Authorization', `Bearer ${plain}`)
        .expect(404);
      await http()
        .put('/me/saved/creators/not-a-uuid')
        .set('Authorization', `Bearer ${plain}`)
        .expect(400);
      for (let i = 0; i < 2; i += 1) {
        const res = await http()
          .delete(`/me/saved/creators/${BASIC}`)
          .set('Authorization', `Bearer ${plain}`)
          .expect(200);
        expect(dataOf<SavedCreatorState>(res)).toEqual({
          creatorWawuId: BASIC,
          saved: false,
        });
      }
      const res = await get(plain, '/me/saved?type=creators').expect(200);
      expect(dataOf<SavedPage>(res).items).toEqual([]);
    });

    it('another person sees only their own saves', async () => {
      const res = await get(basic, '/me/saved').expect(200);
      expect(dataOf<SavedPage>(res).items).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  describe('My purchases (M29) and course progress', () => {
    it('lists completed purchases only, with the course’s lessons and progress', async () => {
      // A pending and a failed charge for the template are not purchases.
      await prisma.purchase.createMany({
        data: [
          {
            contentId: INVOICE_TEMPLATE,
            type: 'content',
            buyerWawuId: PLAIN,
            creatorWawuId: PRO,
            amount: 1500,
            commissionRate: 0.15,
            flutterwaveTxRef: `${PURCHASE_PREFIX}pending`,
            status: 'pending',
          },
          {
            contentId: INVOICE_TEMPLATE,
            type: 'content',
            buyerWawuId: PLAIN,
            creatorWawuId: PRO,
            amount: 1500,
            commissionRate: 0.15,
            flutterwaveTxRef: `${PURCHASE_PREFIX}failed`,
            status: 'failed',
          },
        ],
      });
      const res = await get(plain, '/me/purchases').expect(200);
      expect(dataOf<PurchasePage>(res).items).toHaveLength(1);
      const [row] = dataOf<PurchasePage>(res).items;
      expect(row.content).toMatchObject({
        id: CAC_COURSE,
        title: 'SEEDED: CAC in 7 days',
        contentType: 'course',
      });
      expect(row.content.creator.wawuId).toBe(PRO);
      expect(row.lessons).toEqual({ total: 2, done: 0 });
      expect(
        dataOf<MeCountsView>(await get(plain, '/me/counts')).purchases,
      ).toBe(1);
      await prisma.purchase.deleteMany({
        where: { flutterwaveTxRef: { startsWith: PURCHASE_PREFIX } },
      });
    });

    it('a buyer can mark lessons done and not done, and M29 shows "n of N done"', async () => {
      const done = await http()
        .put(`/me/lessons/${LESSON_1}/done`)
        .set('Authorization', `Bearer ${plain}`)
        .expect(200);
      expect(dataOf<LessonDoneState>(done)).toEqual({
        lessonId: LESSON_1,
        contentId: CAC_COURSE,
        done: true,
        lessons: { total: 2, done: 1 },
      });
      // Again: still one.
      await http()
        .put(`/me/lessons/${LESSON_1}/done`)
        .set('Authorization', `Bearer ${plain}`)
        .expect(200);
      let list = await get(plain, '/me/purchases').expect(200);
      expect(dataOf<PurchasePage>(list).items[0].lessons).toEqual({
        total: 2,
        done: 1,
      });

      await http()
        .put(`/me/lessons/${LESSON_2}/done`)
        .set('Authorization', `Bearer ${plain}`)
        .expect(200);
      const undone = await http()
        .delete(`/me/lessons/${LESSON_1}/done`)
        .set('Authorization', `Bearer ${plain}`)
        .expect(200);
      expect(dataOf<LessonDoneState>(undone).lessons).toEqual({
        total: 2,
        done: 1,
      });
      expect(dataOf<LessonDoneState>(undone).done).toBe(false);
      list = await get(plain, '/me/purchases').expect(200);
      expect(dataOf<PurchasePage>(list).items[0].lessons).toEqual({
        total: 2,
        done: 1,
      });
    });

    it('someone who has not bought a paid course cannot mark its lessons (404), its creator can', async () => {
      await http()
        .put(`/me/lessons/${LESSON_1}/done`)
        .set('Authorization', `Bearer ${basic}`)
        .expect(404);
      await http()
        .put(`/me/lessons/${LESSON_1}/done`)
        .set('Authorization', `Bearer ${pro}`)
        .expect(200);
      await http()
        .put('/me/lessons/e1000000-0000-4000-8000-0000000000ff/done')
        .set('Authorization', `Bearer ${plain}`)
        .expect(404);
      await http()
        .put('/me/lessons/nope/done')
        .set('Authorization', `Bearer ${plain}`)
        .expect(400);
    });

    it('a blocked buyer cannot mark lessons, but keeps the purchase on their list', async () => {
      await prisma.blockedAccount.create({
        data: { userWawuId: PRO, blockedWawuId: PLAIN },
      });
      await http()
        .put(`/me/lessons/${LESSON_1}/done`)
        .set('Authorization', `Bearer ${plain}`)
        .expect(404);
      const list = await get(plain, '/me/purchases').expect(200);
      expect(dataOf<PurchasePage>(list).items).toHaveLength(1);
      await prisma.blockedAccount.deleteMany({
        where: { userWawuId: PRO, blockedWawuId: PLAIN },
      });
    });

    it('a user can search by title or by the creator’s handle', async () => {
      const ids = async (q: string) =>
        dataOf<PurchasePage>(
          await get(plain, `/me/purchases?q=${encodeURIComponent(q)}`).expect(
            200,
          ),
        ).items.map((i) => i.content.id);
      expect(await ids('cac in')).toEqual([CAC_COURSE]);
      expect(await ids('ZAINAB')).toEqual([CAC_COURSE]);
      expect(await ids('nothing like it')).toEqual([]);
      // Wildcards are characters, not patterns.
      expect(await ids('%%')).toEqual([]);
      expect(await ids('__')).toEqual([]);
      await get(plain, '/me/purchases?q=%20P%20').expect(400);
      await get(plain, `/me/purchases?q=${'x'.repeat(61)}`).expect(400);
    });
  });

  // -------------------------------------------------------------------------
  describe('Notifications (M31, M32): opening one opens what it is about', () => {
    const feed = async (token: string, category = 'all') =>
      dataOf<NotificationFeedPage>(
        await get(token, `/me/notifications?category=${category}`).expect(200),
      );
    /** The first row of a kind; fails the test when there is none. */
    const first = (items: NotificationFeedItem[], kind: string) => {
      const row = items.find((i) => i.kind === kind);
      if (!row) throw new Error(`no ${kind} notification`);
      return row;
    };
    /** What a Flutterwave-era checkout answers: its txRef (and a DM's thread). */
    type Checkout = { flutterwaveConfig: { txRef: string }; threadId: string };

    it('a follow opens the follower’s profile, with their name', async () => {
      await http()
        .post(`/creators/${BASIC}/follow`)
        .set('Authorization', `Bearer ${plain}`)
        .expect((r) => expect([200, 201]).toContain(r.status));
      const { items } = await feed(basic);
      const row = first(items, 'new_follower');
      expect(row.category).toBe('other');
      expect(row.target).toEqual({
        kind: 'profile',
        id: PLAIN,
        title: null,
        deadlineAt: null,
      });
      expect(row.actor!.wawuId).toBe(PLAIN);
      expect(row.actor!.handle).toBe('adaeze');
    });

    it('a sale opens the piece sold and shows its money in kobo', async () => {
      const init = await http()
        .post(`/content/${INVOICE_TEMPLATE}/unlock`)
        .set('Authorization', `Bearer ${plain}`)
        .send({});
      await http()
        .post(`/content/${INVOICE_TEMPLATE}/unlock/verify`)
        .set('Authorization', `Bearer ${plain}`)
        .send({
          tx_ref: dataOf<Checkout>(init).flutterwaveConfig.txRef,
          transaction_id: 'me10-flw-sale',
        })
        .expect((r) => expect([200, 201]).toContain(r.status));
      const { items } = await feed(pro, 'money');
      const row = first(items, 'sale');
      expect(row.amountKobo).toBe(127500);
      expect(row.target).toMatchObject({
        kind: 'content',
        id: INVOICE_TEMPLATE,
        title: 'SEEDED: Invoice Template Pack',
      });
      expect(row.actor!.wawuId).toBe(PLAIN);
      // The buyer's own purchases now list it, newest first, with no lessons.
      const mine = await get(plain, '/me/purchases').expect(200);
      expect(dataOf<PurchasePage>(mine).items[0].content.id).toBe(
        INVOICE_TEMPLATE,
      );
      expect(dataOf<PurchasePage>(mine).items[0].lessons).toBeNull();
    });

    it('a paid question opens the question, with its reply deadline', async () => {
      const init = await http()
        .post(`/dm/${PRO}/send`)
        .set('Authorization', `Bearer ${plain}`)
        .send({ text: 'ME-10 asks a paid question.' });
      await http()
        .post(`/dm/${dataOf<Checkout>(init).threadId}/send/verify`)
        .set('Authorization', `Bearer ${plain}`)
        .send({
          tx_ref: dataOf<Checkout>(init).flutterwaveConfig.txRef,
          transaction_id: 'me10-flw-dm',
        })
        .expect((r) => expect([200, 201]).toContain(r.status));
      const dm = await prisma.directMessage.findFirstOrThrow({
        where: { senderWawuId: PLAIN, text: 'ME-10 asks a paid question.' },
      });
      const { items } = await feed(pro, 'messages');
      expect(items.every((i) => i.category === 'messages')).toBe(true);
      const row = first(items, 'dm_received');
      expect(row.target).toEqual({
        kind: 'paid_question',
        id: dm.id,
        title: null,
        deadlineAt: dm.deadlineAt.toISOString(),
      });
      expect(row.amountKobo).toBe(30000);
    });

    it('a first rating is a review that opens the piece; changing it is not news', async () => {
      await http()
        .put(`/content/${CAC_COURSE}/rating`)
        .set('Authorization', `Bearer ${plain}`)
        .send({ rating: 4 })
        .expect(200);
      await http()
        .put(`/content/${CAC_COURSE}/rating`)
        .set('Authorization', `Bearer ${plain}`)
        .send({ rating: 5 })
        .expect(200);
      const { items } = await feed(pro, 'content');
      const reviews = items.filter((i) => i.kind === 'review_received');
      expect(reviews).toHaveLength(1);
      expect(reviews[0].body).toContain('4 out of 5');
      expect(reviews[0].target).toMatchObject({
        kind: 'content',
        id: CAC_COURSE,
      });
      expect(reviews[0].actor!.wawuId).toBe(PLAIN);
      expect(items.every((i) => i.category === 'content')).toBe(true);
    });

    it('a tip opens the tipper; older rows with no target still list, routed by kind', async () => {
      const init = await http()
        .post('/tips')
        .set('Authorization', `Bearer ${plain}`)
        .send({ creatorWawuId: BASIC, amount: 2000 });
      await http()
        .post('/tips/verify')
        .set('Authorization', `Bearer ${plain}`)
        .send({
          tx_ref: dataOf<Checkout>(init).flutterwaveConfig.txRef,
          transaction_id: 'me10-flw-tip',
        })
        .expect((r) => expect([200, 201]).toContain(r.status));
      const { items } = await feed(basic, 'money');
      const tip = first(items, 'tip_received');
      expect(tip.amountKobo).toBe(170000);
      expect(tip.target).toMatchObject({ kind: 'profile', id: PLAIN });

      // The seeded `sale` row predates ME-10: listed, no target, no actor.
      const all = await feed(pro);
      const seeded = all.items.find((i) => i.id === SEEDED_NOTIFICATIONS[0]);
      if (!seeded) throw new Error('seeded notification missing');
      expect(seeded.target).toBeNull();
      expect(seeded.actor).toBeNull();
    });

    it('a block hides the person in it, not the notification (SETTINGS-04)', async () => {
      await prisma.blockedAccount.create({
        data: { userWawuId: BASIC, blockedWawuId: PLAIN },
      });
      const { items } = await feed(basic);
      const follow = first(items, 'new_follower');
      const tip = first(items, 'tip_received');
      expect(follow.actor).toBeNull();
      expect(follow.target).toBeNull();
      expect(tip.actor).toBeNull();
      expect(tip.amountKobo).toBe(170000);
      await prisma.blockedAccount.deleteMany({
        where: { userWawuId: BASIC, blockedWawuId: PLAIN },
      });
    });

    it('pages newest first, counts unread whatever the chip, and M7 reads the same count', async () => {
      const all = await feed(pro);
      const unread = await prisma.notification.count({
        where: { userWawuId: PRO, read: false },
      });
      expect(all.unreadCount).toBe(unread);
      expect((await feed(pro, 'content')).unreadCount).toBe(unread);
      expect(
        dataOf<MeCountsView>(await get(pro, '/me/counts')).unreadNotifications,
      ).toBe(unread);
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const url: string = `/me/notifications?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const res = await get(pro, url).expect(200);
        ids.push(...dataOf<NotificationFeedPage>(res).items.map((i) => i.id));
        cursor = dataOf<NotificationFeedPage>(res).nextCursor;
      } while (cursor);
      expect(ids).toEqual(all.items.map((i) => i.id));
      await get(pro, '/me/notifications?category=shop').expect(400);
    });

    it('GET /notifications (the web’s) answers exactly the fields it always did', async () => {
      const res = await get(pro, '/notifications').expect(200);
      const row = dataOf<{ items: { data: Record<string, unknown>[] } }>(res)
        .items.data[0];
      expect(Object.keys(row).sort()).toEqual(
        [
          'actionHref',
          'actionLabel',
          'amount',
          'body',
          'campaignId',
          'createdAt',
          'creditsCount',
          'id',
          'imageUrl',
          'kind',
          'read',
          'title',
          'tone',
          'userWawuId',
        ].sort(),
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('Earnings (M7, M18): a month is only that month, and never a balance', () => {
    // BASIC's own completed sales, in Africa/Lagos months of 2025.
    const at = (iso: string) => new Date(iso);
    beforeAll(async () => {
      await prisma.community.create({
        data: {
          id: ROOM_ID,
          name: 'ME-10 room',
          description: 'A room.',
          hostWawuId: BASIC,
          kind: 'open',
        },
      });
      const purchase = (
        ref: string,
        type: 'content' | 'tip',
        amount: number,
        when: string,
        status: 'completed' | 'pending' | 'failed' = 'completed',
        creator = BASIC,
      ) => ({
        contentId: type === 'content' ? MAKEUP_VIDEO : null,
        type,
        buyerWawuId: PLAIN,
        creatorWawuId: creator,
        amount,
        commissionRate: 0.15,
        flutterwaveTxRef: `${PURCHASE_PREFIX}${ref}`,
        status,
        purchasedAt: at(when),
      });
      await prisma.purchase.createMany({
        data: [
          // March 2025 (Lagos): 23:30 UTC on 28 Feb is 00:30 on 1 Mar in Lagos.
          purchase('mar-1', 'content', 2000, '2025-02-28T23:30:00.000Z'),
          purchase('mar-2', 'tip', 1000, '2025-03-15T10:00:00.000Z'),
          // Not completed: never earnings.
          purchase(
            'mar-p',
            'content',
            9000,
            '2025-03-16T10:00:00.000Z',
            'pending',
          ),
          purchase('mar-f', 'tip', 9000, '2025-03-17T10:00:00.000Z', 'failed'),
          // 23:00 UTC on 31 Mar is midnight on 1 Apr in Lagos: April.
          purchase('apr-1', 'tip', 4000, '2025-03-31T23:00:00.000Z'),
          // February 2025 (Lagos).
          purchase('feb-1', 'content', 1000, '2025-02-10T10:00:00.000Z'),
          // Somebody else's sale in March: never BASIC's.
          purchase(
            'mar-o',
            'content',
            7000,
            '2025-03-20T10:00:00.000Z',
            'completed',
            PRO,
          ),
        ],
      });
      await prisma.directMessage.createMany({
        data: [
          {
            creatorWawuId: BASIC,
            senderWawuId: PLAIN,
            text: 'answered',
            amount: 300,
            status: 'responded',
            sentAt: at('2025-03-09T08:00:00.000Z'),
            deadlineAt: at('2025-03-10T08:00:00.000Z'),
            respondedAt: at('2025-03-09T09:00:00.000Z'),
            flutterwaveTxRef: `${PURCHASE_PREFIX}dm-1`,
          },
          {
            creatorWawuId: BASIC,
            senderWawuId: PLAIN,
            text: 'still waiting',
            amount: 300,
            status: 'awaiting_response',
            sentAt: at('2025-03-09T08:00:00.000Z'),
            deadlineAt: at('2025-03-10T08:00:00.000Z'),
            flutterwaveTxRef: `${PURCHASE_PREFIX}dm-2`,
          },
          {
            creatorWawuId: BASIC,
            senderWawuId: PLAIN,
            text: 'refunded',
            amount: 300,
            status: 'refunded',
            sentAt: at('2025-03-09T08:00:00.000Z'),
            deadlineAt: at('2025-03-10T08:00:00.000Z'),
            flutterwaveTxRef: `${PURCHASE_PREFIX}dm-3`,
          },
        ],
      });
      await prisma.creditSpend.create({
        data: {
          userWawuId: PLAIN,
          communityId: ROOM_ID,
          creatorWawuId: BASIC,
          creditsSpent: 2,
          spentAt: at('2025-03-12T12:00:00.000Z'),
          earning: {
            create: {
              creatorWawuId: BASIC,
              communityId: ROOM_ID,
              creditsSpent: 2,
              creditsFunded: 2,
              grossKobo: 2000,
              hostShareKobo: 1700,
              platformShareKobo: 300,
              earnedAt: at('2025-03-12T12:00:00.000Z'),
            },
          },
        },
      });
    });

    it('"This month" earnings show only that month', async () => {
      const res = await get(basic, '/me/earnings?month=2025-03').expect(200);
      // 2000 and 1000 naira at 85% (170,000 + 85,000 kobo), the answered
      // question 300 at 85% (25,500), credits 1,700 kobo.
      expect(dataOf<MyEarningsView>(res)).toMatchObject({
        month: '2025-03',
        earnedKobo: 170000 + 85000 + 25500 + 1700,
        salesCount: 4,
        previousMonth: '2025-02',
        previousEarnedKobo: 85000,
        changePct: Math.round(((282200 - 85000) * 100) / 85000),
      });
      const months = dataOf<MyEarningsView>(res).months;
      expect(months).toHaveLength(12);
      expect(months[0].month).toBe('2024-04');
      expect(months[11]).toEqual({ month: '2025-03', earnedKobo: 282200 });
      expect(months[10]).toEqual({ month: '2025-02', earnedKobo: 85000 });
      const april = await get(basic, '/me/earnings?month=2025-04').expect(200);
      expect(dataOf<MyEarningsView>(april).earnedKobo).toBe(340000);
      expect(dataOf<MyEarningsView>(april).salesCount).toBe(1);
    });

    it('lists the month’s sales, newest first, paged', async () => {
      const seen: EarningSalePage['items'] = [];
      let cursor: string | null = null;
      do {
        const url: string = `/me/earnings/sales?month=2025-03&limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const res = await get(basic, url).expect(200);
        const page = dataOf<EarningSalePage>(res);
        expect(page.month).toBe('2025-03');
        seen.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen.map((s) => [s.stream, s.earnedKobo])).toEqual([
        ['tip', 85000],
        ['community_credits', 1700],
        ['paid_question', 25500],
        ['content', 170000],
      ]);
      expect(seen[1].title).toBe('ME-10 room');
      expect(seen[3]).toMatchObject({
        contentId: MAKEUP_VIDEO,
        occurredAt: '2025-02-28T23:30:00.000Z',
      });
    });

    it('defaults to this Lagos month, and somebody with no sales earned nothing', async () => {
      const res = await get(basic, '/me/earnings').expect(200);
      expect(dataOf<MyEarningsView>(res).month).toBe(lagosMonthOf(new Date()));
      const buyer = await get(plain, '/me/earnings?month=2025-03').expect(200);
      expect(dataOf<MyEarningsView>(buyer).earnedKobo).toBe(0);
      expect(dataOf<MyEarningsView>(buyer).changePct).toBeNull();
      expect(
        dataOf<MyEarningsView>(buyer).months.every((m) => m.earnedKobo === 0),
      ).toBe(true);
    });

    it('refuses a month that is not YYYY-MM', async () => {
      for (const month of [
        '2025-3',
        '2025-13',
        '1999-01',
        'march',
        '2025-03-01',
      ]) {
        await get(basic, `/me/earnings?month=${month}`).expect(400);
        await get(basic, `/me/earnings/sales?month=${month}`).expect(400);
      }
    });

    it('never names a balance', async () => {
      const res = await get(basic, '/me/earnings?month=2025-03').expect(200);
      expect(
        JSON.stringify(dataOf<MyEarningsView>(res)).toLowerCase(),
      ).not.toContain('balance');
    });
  });
});
