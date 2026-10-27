// Contract tests for STORE-QUESTION and STORE-SALE-NOTICE (R-101, ruling 1A): a paid question bought
// in the app store, its earning when answered, its question credit when it is not, and the creator's
// notice of each store sale. Real HTTP, a real database, real guards and the real grant code; the two
// stores' servers are stand-ins (test/store/store-standins.ts). Run with
//   WAWU_ID_JWKS_URL=http://localhost:10750/.well-known/jwks.json WAWU_ID_BASE_URL=http://localhost:10750
//   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/test_question_store?schema=public

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/test_question_store?schema=public';

import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'child_process';
import type { Server } from 'http';
import type { INestApplication } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { composeNotification } from '../../../notification/notification-event';
import {
  API,
  BUYER,
  build,
  codeOf,
  dataOf,
  ensureMockWawuId,
  HOST,
  mintToken,
  OTHER,
  PEOPLE,
  STAND_IN_CONFIG,
} from '../../../../test/store/store-test-kit';
import {
  StandInAppStore,
  StandInGooglePlay,
  verified,
} from '../../../../test/store/store-standins';
import { payableAt } from '../../store-buy-rules';
import { STORE_LADDER } from '../../store-ladder';
import { StoreQuestionService } from '../store-question.service';
import { DmRefundService } from '../../../direct-message/dm-refund.service';
import { STORE_REFUND_MARK } from '../../../direct-message/store-question-ref';
import { NotificationService } from '../../../notification/notification.service';
import { SchedulerService } from '../../../scheduler/scheduler.service';

jest.setTimeout(120_000);

type Intent = {
  intentId: string;
  productId: string;
  accountToken: string;
  expiresAt: string;
  purchase?: PurchaseView;
};
type PurchaseView = {
  id: string;
  kind: string;
  buyKind: string | null;
  intentId: string | null;
  targetId: string | null;
  status: string;
  alreadyGranted: boolean;
  flag: string | null;
  credit?: { id: string; amountKobo: number; message: string } | null;
  paidWithCredit?: string | null;
  grant: { questionId?: string | null; creatorWawuId?: string | null };
};
type CreditList = {
  credits: Array<{ id: string; amountKobo: number; scope: string | null }>;
};

const HOUR = 3_600_000;
const NO_GRANTS = { packId: null, pack: null, tierId: null, days: null };
const WORDS = 'How do you price a first brand deal?';

describe('STORE-QUESTION: a paid question bought in the store (stand-in stores)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let questions: StoreQuestionService;
  let mock: ChildProcess | undefined;
  let google: StandInGooglePlay;
  let apple: StandInAppStore;
  let acctBuyer: string;
  const roomIds: string[] = [];
  const pieceIds: string[] = [];
  let piece: string;
  let room: string;

  const http = () => request(app.getHttpServer() as Server);
  const as = (token: string) => ({
    get: (url: string) =>
      http().get(`${API}${url}`).set('Authorization', `Bearer ${token}`),
    post: (url: string, body: object) =>
      http()
        .post(`${API}${url}`)
        .set('Authorization', `Bearer ${token}`)
        .send(body),
  });
  let buyer: ReturnType<typeof as>;
  let host: ReturnType<typeof as>;
  let other: ReturnType<typeof as>;
  const uid = () => randomUUID().slice(0, 8);

  const ask = (who: typeof buyer, body: object) =>
    who.post('/store/intents', body);
  const q = (
    platform: 'android' | 'ios',
    creator = HOST,
    listPriceNaira = 1000,
    text = WORDS,
  ) => ({
    platform,
    kind: 'question',
    creatorWawuId: creator,
    listPriceNaira,
    text,
  });
  const content = (platform: 'android' | 'ios') => ({
    platform,
    kind: 'content',
    contentId: piece,
    listPriceNaira: 1000,
  });
  const tip = (platform: 'android' | 'ios', listPriceNaira = 500) => ({
    platform,
    kind: 'tip',
    creatorWawuId: HOST,
    listPriceNaira,
  });
  const pass = (platform: 'android' | 'ios') => ({
    platform,
    kind: 'pass',
    communityId: room,
    listPriceNaira: 1000,
  });
  async function intentFor(body: object, who = buyer): Promise<Intent> {
    return dataOf<Intent>(await ask(who, body).expect(201));
  }
  function iosSale(
    transactionId: string,
    storeProductId: string,
    over: Partial<Parameters<typeof verified>[0]> = {},
  ): void {
    apple.transactions.set(
      transactionId,
      verified({
        platform: 'ios',
        storeProductId,
        storeTransactionId: transactionId,
        accountToken: acctBuyer,
        ...over,
      }),
    );
  }
  const postIos = (
    transactionId: string,
    intentId: string | undefined,
    productId = 'wawu.buy.1000',
  ) =>
    buyer.post('/store/purchases', {
      platform: 'ios',
      productId,
      transactionId,
      ...(intentId ? { intentId } : {}),
    });
  const appleNote = (id: string, type: string, transactionId: string) => {
    const t = apple.transactions.get(transactionId)!;
    apple.notifications.set(`signed-${id}`, {
      notificationId: id,
      type,
      subtype: null,
      environment: 'production',
      transaction: { ...t },
      signedAt: null,
    });
    return http()
      .post(`${API}/webhooks/app-store`)
      .send({ signedPayload: `signed-${id}` });
  };
  const outcomeOf = (res: request.Response) =>
    dataOf<{ outcome: string }>(res).outcome;

  /** A question bought on Apple at `price` for `creator`: the intent, the sale, the purchase. */
  let seq = 0;
  async function buyQuestion(
    creator = HOST,
    price = 1000,
  ): Promise<{ intent: Intent; view: PurchaseView; tx: string }> {
    seq += 1;
    const tx = `61000000${String(seq).padStart(5, '0')}`;
    const intent = await intentFor(q('ios', creator, price));
    iosSale(tx, `wawu.buy.${price}`);
    const view = dataOf<PurchaseView>(
      await postIos(tx, intent.intentId, `wawu.buy.${price}`).expect(201),
    );
    return { intent, view, tx };
  }
  /** The messages of this spec's own people: a seeded database holds others. */
  const ourMessages = () =>
    prisma.directMessage.count({ where: { creatorWawuId: { in: PEOPLE } } });
  const dm = (id: string) =>
    prisma.directMessage.findUniqueOrThrow({ where: { id } });
  const notices = (userWawuId: string, kind: string) =>
    prisma.notification.findMany({ where: { userWawuId, kind } });
  const answer = (id: string) =>
    host.post(`/dm/${id}/respond`, {
      text: 'Start with what you would charge a friend.',
    });

  async function wipe(): Promise<void> {
    await prisma.earningDeductionTake.deleteMany({});
    await prisma.earningDeduction.deleteMany({
      where: { storePurchaseId: { not: null } },
    });
    await prisma.storeEarning.deleteMany({});
    await prisma.purchase.deleteMany({
      where: { flutterwaveTxRef: { startsWith: 'store:' } },
    });
    await prisma.communityPass.deleteMany({
      where: { userWawuId: { in: PEOPLE } },
    });
    await prisma.communityMembership.deleteMany({
      where: { userWawuId: { in: PEOPLE } },
    });
    await prisma.directMessage.deleteMany({
      where: { creatorWawuId: { in: PEOPLE } },
    });
    await prisma.storePurchase.deleteMany({});
    await prisma.storePurchaseIntent.deleteMany({});
    await prisma.storeCredit.deleteMany({});
    await prisma.storeNotification.deleteMany({});
    await prisma.notification.deleteMany({
      where: { userWawuId: { in: PEOPLE } },
    });
    await prisma.creatorNoResponseTracker.deleteMany({
      where: { creatorWawuId: { in: PEOPLE } },
    });
    await prisma.blockedAccount.deleteMany({
      where: { userWawuId: { in: PEOPLE } },
    });
    await prisma.creatorState.updateMany({
      where: { wawuUserId: { in: [HOST, BUYER] } },
      data: { dmEnabled: true, dmPrice: 1000, dmResponseHours: 24 },
    });
    await prisma.creatorState.updateMany({
      where: { wawuUserId: OTHER },
      data: { dmEnabled: true, dmPrice: 500, dmResponseHours: 12 },
    });
  }

  beforeAll(async () => {
    mock = await ensureMockWawuId();
    google = new StandInGooglePlay();
    apple = new StandInAppStore();
    ({ app, moduleRef } = await build(STAND_IN_CONFIG, google, apple));
    prisma = moduleRef.get(PrismaService);
    questions = moduleRef.get(StoreQuestionService);
    buyer = as(mintToken(BUYER));
    host = as(mintToken(HOST));
    other = as(mintToken(OTHER));
    acctBuyer = dataOf<{ accountToken: string }>(
      await buyer.get('/store/products?platform=android').expect(200),
    ).accountToken;

    await prisma.storePurchase.deleteMany({});
    await prisma.storeProduct.deleteMany({});
    await prisma.storeProduct.createMany({
      data: (['android', 'ios'] as const).flatMap((platform) =>
        STORE_LADDER.map((s, i) => ({
          platform,
          kind: 'buy' as const,
          storeProductId: `wawu.buy.${s.listNaira}`,
          title: `Buy at ${s.listNaira} naira`,
          grants: NO_GRANTS,
          referenceKobo: s.listNaira * 100,
          storePriceKobo: s.storeNaira * 100,
          sortOrder: i + 1,
        })),
      ),
    });
    for (const [id, handle] of [
      [HOST, 'sqhost'],
      [BUYER, 'sqbuyer'],
      [OTHER, 'sqother'],
    ] as const) {
      await prisma.userProfile.upsert({
        where: { wawuUserId: id },
        create: {
          wawuUserId: id,
          accountType: 'creator',
          handle: `${handle}_${uid()}`,
        },
        update: {},
      });
      await prisma.creatorState.upsert({
        where: { wawuUserId: id },
        create: { wawuUserId: id, dmEnabled: true, dmPrice: 1000 },
        update: {},
      });
    }
    const row = await prisma.contentPiece.create({
      data: {
        slug: `sq-${uid()}`,
        creatorWawuId: HOST,
        contentType: 'video',
        title: `Question spec piece ${uid()}`,
        description: 'A piece',
        category: 'business_entrepreneurship',
        previewAssetUrl: 'https://cdn.example.com/p.jpg',
        fullAssetUrl: 'https://cdn.example.com/f.mp4',
        accessType: 'paid',
        price: 1000,
        status: 'live',
      },
    });
    piece = row.id;
    pieceIds.push(row.id);
    const c = await prisma.community.create({
      data: {
        name: `Question spec room ${uid()}`,
        description: 'A private room.',
        hostWawuId: HOST,
        kind: 'private',
        passPrice: { create: { priceKobo: 100_000n } },
      },
    });
    room = c.id;
    roomIds.push(c.id);
    await wipe();
  });

  afterAll(async () => {
    if (prisma) {
      await wipe();
      await prisma.storePurchase.deleteMany({});
      await prisma.storeAccountToken.deleteMany({
        where: { wawuUserId: { in: PEOPLE } },
      });
      await prisma.storeProduct.deleteMany({});
      await prisma.communityPassPrice.deleteMany({
        where: { communityId: { in: roomIds } },
      });
      await prisma.community.deleteMany({ where: { id: { in: roomIds } } });
      await prisma.contentPiece.deleteMany({ where: { id: { in: pieceIds } } });
      await prisma.creatorState.deleteMany({
        where: { wawuUserId: { in: PEOPLE } },
      });
      await prisma.userProfile.deleteMany({
        where: { wawuUserId: { in: PEOPLE } },
      });
    }
    await app?.close();
    mock?.kill();
  });

  beforeEach(async () => {
    await wipe();
    google.oneTime.clear();
    google.consumed.length = 0;
    apple.transactions.clear();
    apple.notifications.clear();
  });

  // ----------------------------------------------------------------- intents

  describe('POST /store/intents with kind question', () => {
    it("answers the ladder product, the account token and the expiry, and keeps the words and the creator's window", async () => {
      const body = await intentFor(q('android'));
      expect(body.productId).toBe('wawu.buy.1000');
      expect(body.accountToken).toBe(acctBuyer);
      const ms = new Date(body.expiresAt).getTime() - Date.now();
      expect(ms).toBeGreaterThan(59 * 60_000);
      expect(ms).toBeLessThanOrEqual(HOUR);
      expect(
        await prisma.storePurchaseIntent.findUniqueOrThrow({
          where: { id: body.intentId },
        }),
      ).toMatchObject({
        wawuUserId: BUYER,
        kind: 'question',
        targetId: HOST,
        listPriceNaira: 1000,
        listPriceKobo: 100_000,
        status: 'open',
        questionText: WORDS,
        questionWindowHours: 24,
      });
      // Nothing was charged, sent or earned.
      expect(await ourMessages()).toBe(0);
      expect(await prisma.storeEarning.count({})).toBe(0);
    });

    it("another creator's window is the one the asker is shown", async () => {
      const body = await intentFor(q('android', OTHER, 500));
      expect(
        (
          await prisma.storePurchaseIntent.findUniqueOrThrow({
            where: { id: body.intentId },
          })
        ).questionWindowHours,
      ).toBe(12);
    });

    it('asking again with the same words is the same intent; other words replace it', async () => {
      const a = await intentFor(q('android'));
      const b = await intentFor(q('android'));
      expect(b.intentId).toBe(a.intentId);
      const c = await intentFor(q('android', HOST, 1000, 'Something else?'));
      expect(c.intentId).not.toBe(a.intentId);
      expect(
        (
          await prisma.storePurchaseIntent.findUniqueOrThrow({
            where: { id: a.intentId },
          })
        ).status,
      ).toBe('replaced');
      expect(
        await prisma.storePurchaseIntent.count({ where: { status: 'open' } }),
      ).toBe(1);
    });

    it('refuses the words that are missing, too long, or sent with another kind, and a thing the kind is not about', async () => {
      const noText = { ...q('android'), text: undefined };
      expect((await ask(buyer, noText)).status).toBe(400);
      expect((await ask(buyer, q('android', HOST, 1000, '   '))).status).toBe(
        400,
      );
      expect(
        (await ask(buyer, q('android', HOST, 1000, 'x'.repeat(2001)))).status,
      ).toBe(400);
      expect(
        (await ask(buyer, { ...tip('android'), text: WORDS })).status,
      ).toBe(400);
      expect(
        (await ask(buyer, { ...q('android'), contentId: piece })).status,
      ).toBe(400);
      expect(
        (await ask(buyer, { ...q('android'), communityId: room })).status,
      ).toBe(400);
      expect(await prisma.storePurchaseIntent.count({})).toBe(0);
    });

    it("refuses: a price off the list, a price that is not the creator's, oneself, nobody, a creator who does not take questions", async () => {
      const offList = await ask(buyer, q('android', HOST, 1234)).expect(400);
      expect(codeOf(offList)).toBe('price_not_on_list');
      expect(
        codeOf(await ask(buyer, q('android', HOST, 500)).expect(409)),
      ).toBe('store_intent_price_changed');
      expect(codeOf(await ask(buyer, q('android', BUYER)).expect(409))).toBe(
        'store_intent_not_payable',
      );
      expect(
        codeOf(await ask(buyer, q('android', randomUUID())).expect(404)),
      ).toBe('store_intent_target_not_found');
      await prisma.creatorState.update({
        where: { wawuUserId: HOST },
        data: { dmEnabled: false },
      });
      expect(codeOf(await ask(buyer, q('android')).expect(409))).toBe(
        'store_intent_not_payable',
      );
      await prisma.creatorState.update({
        where: { wawuUserId: HOST },
        data: { dmEnabled: true, dmPrice: null },
      });
      expect(codeOf(await ask(buyer, q('android')).expect(409))).toBe(
        'store_intent_not_payable',
      );
      expect(await prisma.storePurchaseIntent.count({})).toBe(0);
    });

    it('refuses across a block and while the creator is paused for missing replies', async () => {
      await prisma.blockedAccount.create({
        data: { userWawuId: HOST, blockedWawuId: BUYER },
      });
      expect(codeOf(await ask(buyer, q('android')).expect(409))).toBe(
        'store_intent_not_payable',
      );
      await prisma.blockedAccount.deleteMany({
        where: { userWawuId: { in: PEOPLE } },
      });
      await prisma.creatorNoResponseTracker.create({
        data: {
          creatorWawuId: HOST,
          penaltyState: 'disabled_7d',
          dmDisabledUntil: new Date(Date.now() + 3 * 24 * HOUR),
        },
      });
      expect(codeOf(await ask(buyer, q('android')).expect(409))).toBe(
        'store_intent_not_payable',
      );
    });

    it('refuses a second question to a creator who has not answered the first', async () => {
      await buyQuestion();
      const second = await ask(buyer, q('android', HOST, 1000, 'And another?'));
      expect(second.status).toBe(409);
      expect(codeOf(second)).toBe('store_intent_not_payable');
      // Another creator is free to ask.
      await ask(buyer, q('android', OTHER, 500)).expect(201);
    });
  });

  // ---------------------------------------------------------------- the sale

  describe('the sale sends the question', () => {
    it('sends it as the wallet path does, holds the money in the store, and a replay sends nothing more', async () => {
      const { intent, view, tx } = await buyQuestion();
      expect(view).toMatchObject({
        kind: 'buy',
        buyKind: 'question',
        intentId: intent.intentId,
        targetId: HOST,
        status: 'granted',
        alreadyGranted: false,
        flag: null,
      });
      expect(view.grant.questionId).toBe(intent.intentId);
      const row = await dm(intent.intentId);
      expect(row).toMatchObject({
        creatorWawuId: HOST,
        senderWawuId: BUYER,
        text: WORDS,
        amount: 1000,
        status: 'awaiting_response',
        flutterwaveTxRef: `store:${view.id}`,
        responseWindowHours: 24,
        refundStatus: 'not_owed',
      });
      expect(row.deadlineAt.getTime() - row.sentAt.getTime()).toBe(24 * HOUR);
      // The words live on the message now.
      expect(
        (
          await prisma.storePurchaseIntent.findUniqueOrThrow({
            where: { id: intent.intentId },
          })
        ).questionText,
      ).toBeNull();
      // Not in a wallet and not in a hold.
      expect(
        await prisma.walletPayment.count({
          where: { payerWawuUserId: { in: PEOPLE } },
        }),
      ).toBe(0);
      expect(
        await prisma.walletHold.count({
          where: { payeeWawuUserId: { in: PEOPLE } },
        }),
      ).toBe(0);
      // The creator's 85% is recorded on the purchase, and nothing is earned yet.
      expect(
        await prisma.storePurchase.findUniqueOrThrow({
          where: { id: view.id },
        }),
      ).toMatchObject({
        creatorWawuUserId: HOST,
        creatorShareKobo: 85_000,
        referenceKobo: 100_000,
        buyKind: 'question',
      });
      expect(await prisma.storeEarning.count({})).toBe(0);
      // The creator is told of the new question once.
      const got = await notices(HOST, 'dm_received');
      expect(got).toHaveLength(1);
      expect(got[0].amount).toBe(1000);
      // The same transaction again: nothing more is sent or told.
      const again = dataOf<PurchaseView>(
        await postIos(tx, intent.intentId).expect(201),
      );
      expect(again).toMatchObject({ id: view.id, alreadyGranted: true });
      expect(await ourMessages()).toBe(1);
      expect(await notices(HOST, 'dm_received')).toHaveLength(1);
      // It is in the creator's inbox like any paid question.
      const inbox = dataOf<Array<{ id: string }>>(
        await host.get('/dm/inbox').expect(200),
      );
      expect(inbox.map((i) => i.id)).toContain(intent.intentId);
    });

    it('the creator turned paid messages off after the intent: the payment becomes a question credit and no question is sent', async () => {
      const intent = await intentFor(q('ios'));
      await prisma.creatorState.update({
        where: { wawuUserId: HOST },
        data: { dmEnabled: false },
      });
      iosSale('6100099000001', 'wawu.buy.1000');
      const view = dataOf<PurchaseView>(
        await postIos('6100099000001', intent.intentId).expect(201),
      );
      expect(view.status).toBe('credited');
      expect(view.credit?.amountKobo).toBe(100_000);
      expect(view.credit?.message).toContain('ask any creator a question');
      expect(await ourMessages()).toBe(0);
      expect(await prisma.storeEarning.count({})).toBe(0);
      expect(await prisma.storeCredit.findFirstOrThrow({})).toMatchObject({
        wawuUserId: BUYER,
        amountKobo: 100_000,
        scope: 'question',
        status: 'open',
      });
    });

    it('the creator raised the price after the intent: the asker still asks at the price they paid', async () => {
      const intent = await intentFor(q('ios'));
      await prisma.creatorState.update({
        where: { wawuUserId: HOST },
        data: { dmPrice: 2000 },
      });
      iosSale('6100099000002', 'wawu.buy.1000');
      const view = dataOf<PurchaseView>(
        await postIos('6100099000002', intent.intentId).expect(201),
      );
      expect(view.status).toBe('granted');
      expect(view.flag).toBe('price_changed');
      expect((await dm(intent.intentId)).amount).toBe(1000);
    });

    it('a second sale for a creator who already has a question waiting becomes a question credit, not a second question', async () => {
      const first = await buyQuestion();
      // A second intent made before the first was sent would be refused, so make it directly.
      const second = await prisma.storePurchaseIntent.create({
        data: {
          wawuUserId: BUYER,
          platform: 'ios',
          kind: 'question',
          targetId: HOST,
          listPriceNaira: 1000,
          listPriceKobo: 100_000,
          productId: (
            await prisma.storeProduct.findFirstOrThrow({
              where: { platform: 'ios', storeProductId: 'wawu.buy.1000' },
            })
          ).id,
          storeProductId: 'wawu.buy.1000',
          expiresAt: new Date(Date.now() + HOUR),
          questionText: 'A second one',
          questionWindowHours: 24,
        },
      });
      iosSale('6100099000003', 'wawu.buy.1000');
      const view = dataOf<PurchaseView>(
        await postIos('6100099000003', second.id).expect(201),
      );
      expect(view.status).toBe('credited');
      expect(await ourMessages()).toBe(1);
      expect(first.view.status).toBe('granted');
    });
  });

  // -------------------------------------------------------------- the answer

  describe('answered in time', () => {
    it("the creator's 85% of the list price becomes an earning payable 3 working days from the answer, and they are told once", async () => {
      const { intent, view } = await buyQuestion();
      // The answer, some time after the question.
      await prisma.directMessage.update({
        where: { id: intent.intentId },
        data: { sentAt: new Date(Date.now() - 5 * HOUR) },
      });
      const res = await answer(intent.intentId).expect(201);
      expect(dataOf<{ status: string }>(res).status).toBe('responded');
      const row = await dm(intent.intentId);
      expect(row.respondedAt).not.toBeNull();
      const earning = await prisma.storeEarning.findFirstOrThrow({});
      expect(earning).toMatchObject({
        storePurchaseId: view.id,
        role: 'sale',
        payeeWawuUserId: HOST,
        kind: 'paid_dm',
        targetId: intent.intentId,
        listPriceKobo: 100_000n,
        amountKobo: 85_000n,
        status: 'owed',
      });
      // Counted from the answer, not from the sale.
      expect(earning.earnedAt.getTime()).toBe(row.respondedAt!.getTime());
      expect(earning.availableAt.getTime()).toBe(
        payableAt(row.respondedAt!).getTime(),
      );
      // Told once, with the creator's 85% in naira.
      const told = await notices(HOST, 'question_answered');
      expect(told).toHaveLength(1);
      expect(told[0]).toMatchObject({ amount: 850, tone: 'success' });
      expect(told[0].body).toContain('₦850');
      expect(told[0].body).not.toMatch(/—/);
    });

    it('asking the hook again, a second reply and the sweep make no second earning and no second notice', async () => {
      const { intent } = await buyQuestion();
      await answer(intent.intentId).expect(201);
      const row = await dm(intent.intentId);
      await questions.onAnswered({
        id: row.id,
        flutterwaveTxRef: row.flutterwaveTxRef,
      });
      await host
        .post(`/dm/${intent.intentId}/replies`, { text: 'One more thing.' })
        .catch(() => undefined);
      expect(await questions.sweep()).toMatchObject({ expired: 0, earned: 0 });
      expect(await prisma.storeEarning.count({})).toBe(1);
      expect(await notices(HOST, 'question_answered')).toHaveLength(1);
    });

    it('an answer whose own step did not finish is recorded by the sweep, once', async () => {
      const { intent } = await buyQuestion();
      // The creator replied, but the step after the reply never ran (a crash).
      await prisma.directMessage.update({
        where: { id: intent.intentId },
        data: {
          status: 'responded',
          respondedAt: new Date(),
          responseText: 'Here you go.',
        },
      });
      expect(await prisma.storeEarning.count({})).toBe(0);
      expect(await questions.sweep()).toMatchObject({ earned: 1 });
      expect(await questions.sweep()).toMatchObject({ earned: 0 });
      expect(await prisma.storeEarning.count({})).toBe(1);
      expect(await notices(HOST, 'question_answered')).toHaveLength(1);
    });

    it('a question paid with a question credit earns the creator the same 85% of its price', async () => {
      await prisma.storeCredit.create({
        data: {
          wawuUserId: BUYER,
          amountKobo: 100_000,
          sourcePurchaseId: randomUUID(),
          scope: 'question',
        },
      });
      const paid = dataOf<Intent>(
        await ask(buyer, {
          ...q('android', OTHER, 500),
          payWith: 'credit',
        }).expect(201),
      );
      expect(paid.purchase).toMatchObject({
        status: 'granted',
        buyKind: 'question',
      });
      expect(typeof paid.purchase?.paidWithCredit).toBe('string');
      await other
        .post(`/dm/${paid.intentId}/respond`, { text: 'Sure.' })
        .expect(201);
      expect(await prisma.storeEarning.findFirstOrThrow({})).toMatchObject({
        payeeWawuUserId: OTHER,
        amountKobo: 42_500n,
      });
    });
  });

  // ------------------------------------------------------------ the deadline

  describe('not answered by the deadline', () => {
    async function pastDeadline(id: string): Promise<void> {
      await prisma.directMessage.update({
        where: { id },
        data: {
          sentAt: new Date(Date.now() - 26 * HOUR),
          deadlineAt: new Date(Date.now() - 2 * HOUR),
        },
      });
    }

    it('no earning; the asker gets a question credit worth the list price, and is told once; the sweep twice makes one', async () => {
      const { intent, view } = await buyQuestion();
      await pastDeadline(intent.intentId);
      expect(await questions.sweep()).toMatchObject({ expired: 1 });
      expect(await questions.sweep()).toMatchObject({ expired: 0 });
      const row = await dm(intent.intentId);
      expect(row).toMatchObject({
        status: 'refunded',
        refundStatus: 'settled',
      });
      expect(await prisma.storeEarning.count({})).toBe(0);
      const credits = await prisma.storeCredit.findMany({});
      expect(credits).toHaveLength(1);
      expect(credits[0]).toMatchObject({
        wawuUserId: BUYER,
        amountKobo: 100_000,
        scope: 'question',
        status: 'open',
        sourcePurchaseId: view.id,
        originPurchaseId: view.id,
      });
      expect(row.refundReference).toBe(`store_credit:${credits[0].id}`);
      const told = await notices(BUYER, 'question_credit');
      expect(told).toHaveLength(1);
      expect(told[0].body).toContain('₦1,000');
      expect(await notices(HOST, 'question_answered')).toHaveLength(0);
      // The credit is listed with its scope.
      const list = dataOf<CreditList>(
        await buyer.get('/store/credits').expect(200),
      );
      expect(list.credits).toEqual([
        expect.objectContaining({ amountKobo: 100_000, scope: 'question' }),
      ]);
      // The creator can no longer answer.
      await answer(intent.intentId).expect(409);
      // A question not answered counts against the creator's standing, as any does.
      expect(
        await prisma.directMessage.count({
          where: { creatorWawuId: HOST, status: 'refunded' },
        }),
      ).toBe(1);
    });

    it('a question answered before the deadline is never credited, and a late answer is refused', async () => {
      const a = await buyQuestion();
      await answer(a.intent.intentId).expect(201);
      await prisma.directMessage.update({
        where: { id: a.intent.intentId },
        data: { deadlineAt: new Date(Date.now() - HOUR) },
      });
      expect(await questions.sweep()).toMatchObject({ expired: 0 });
      expect(await prisma.storeCredit.count({})).toBe(0);
      expect(await prisma.storeEarning.count({})).toBe(1);
    });
  });

  // ------------------------------------------------------------ the credit

  describe('a question credit', () => {
    const credit = (kobo: number, scope: string | null = 'question') =>
      prisma.storeCredit.create({
        data: {
          wawuUserId: BUYER,
          amountKobo: kobo,
          sourcePurchaseId: randomUUID(),
          scope,
        },
      });

    it('pays for a question to any creator at that price or less; the rest stays a question credit', async () => {
      const c = await credit(100_000);
      const res = dataOf<Intent>(
        await ask(buyer, {
          ...q('android', OTHER, 500),
          payWith: 'credit',
        }).expect(201),
      );
      expect(res.purchase).toMatchObject({
        status: 'granted',
        buyKind: 'question',
        paidWithCredit: c.id,
      });
      expect(
        await prisma.storeCredit.findUniqueOrThrow({ where: { id: c.id } }),
      ).toMatchObject({ status: 'spent', spentPurchaseId: res.purchase!.id });
      const rest = await prisma.storeCredit.findMany({
        where: { status: 'open' },
      });
      expect(rest).toHaveLength(1);
      expect(rest[0]).toMatchObject({ amountKobo: 50_000, scope: 'question' });
      // The question was sent to the creator asked, with no store sheet.
      expect(await dm(res.intentId)).toMatchObject({
        creatorWawuId: OTHER,
        amount: 500,
        status: 'awaiting_response',
      });
      // The rest pays for another question at its price, and at no more.
      expect(
        codeOf(
          await ask(buyer, {
            ...q('android', HOST, 1000, 'Dearer one'),
            payWith: 'credit',
          }).expect(409),
        ),
      ).toBe('store_credit_insufficient');
    });

    it('never pays for a piece, a tip or a pass', async () => {
      await credit(500_000);
      for (const body of [
        content('android'),
        tip('android'),
        pass('android'),
      ]) {
        expect(
          codeOf(await ask(buyer, { ...body, payWith: 'credit' }).expect(409)),
        ).toBe('store_credit_insufficient');
      }
      expect(
        await prisma.storeCredit.count({ where: { status: 'open' } }),
      ).toBe(1);
      expect(await prisma.storePurchase.count({})).toBe(0);
    });

    it('is the only credit that pays for a question: a credit with no scope does not', async () => {
      await credit(500_000, null);
      expect(
        codeOf(
          await ask(buyer, { ...q('android'), payWith: 'credit' }).expect(409),
        ),
      ).toBe('store_credit_insufficient');
      // And it still pays for what it always did.
      const tipped = dataOf<Intent>(
        await ask(buyer, { ...tip('android'), payWith: 'credit' }).expect(201),
      );
      expect(tipped.purchase?.status).toBe('granted');
      // The rest of an unscoped credit stays unscoped.
      expect(
        (
          await prisma.storeCredit.findFirstOrThrow({
            where: { status: 'open' },
          })
        ).scope,
      ).toBeNull();
    });

    it('a credit that is spent on a question the creator cannot take is not lost', async () => {
      const c = await credit(100_000);
      await prisma.creatorState.update({
        where: { wawuUserId: OTHER },
        data: { dmEnabled: false },
      });
      expect(
        codeOf(
          await ask(buyer, {
            ...q('android', OTHER, 500),
            payWith: 'credit',
          }).expect(409),
        ),
      ).toBe('store_intent_not_payable');
      expect(
        (await prisma.storeCredit.findUniqueOrThrow({ where: { id: c.id } }))
          .status,
      ).toBe('open');
    });
  });

  // --------------------------------------------------------------- refunds

  describe('a store refund of the question purchase', () => {
    it('before the answer: the question is withdrawn, nothing is earned, the creator is not marked as having missed it; the notice twice does it once; a reversal opens it again', async () => {
      const { intent, view, tx } = await buyQuestion();
      expect(outcomeOf(await appleNote('q-r1', 'REFUND', tx))).toBe(
        'taken_back',
      );
      const row = await dm(intent.intentId);
      expect(row).toMatchObject({
        status: 'refunded',
        refundStatus: 'settled',
        refundReference: STORE_REFUND_MARK,
      });
      expect(await prisma.storeEarning.count({})).toBe(0);
      expect(
        (
          await prisma.storePurchase.findUniqueOrThrow({
            where: { id: view.id },
          })
        ).status,
      ).toBe('refunded');
      await answer(intent.intentId).expect(409);
      expect(outcomeOf(await appleNote('q-r2', 'REFUND', tx))).toBe(
        'duplicate',
      );
      // Not a miss in the creator's standing.
      expect(
        await prisma.directMessage.count({
          where: {
            creatorWawuId: HOST,
            status: 'refunded',
            OR: [
              { refundReference: null },
              { refundReference: { not: STORE_REFUND_MARK } },
            ],
          },
        }),
      ).toBe(0);
      // Apple reverses the refund: the question is open again, with its deadline.
      expect(outcomeOf(await appleNote('q-rev', 'REFUND_REVERSED', tx))).toBe(
        'restored',
      );
      expect(await dm(intent.intentId)).toMatchObject({
        status: 'awaiting_response',
        refundStatus: 'not_owed',
        refundReference: null,
      });
      await answer(intent.intentId).expect(201);
      expect(await prisma.storeEarning.count({})).toBe(1);
    });

    it('after the answer: the answer stays and the creator’s earning is taken back as for any ladder sale', async () => {
      const { intent, view, tx } = await buyQuestion();
      await answer(intent.intentId).expect(201);
      expect(outcomeOf(await appleNote('q-r3', 'REFUND', tx))).toBe(
        'taken_back',
      );
      expect((await dm(intent.intentId)).status).toBe('responded');
      expect(await prisma.storeEarning.findFirstOrThrow({})).toMatchObject({
        status: 'cancelled',
        cancelReason: 'refunded_by_store',
      });
      expect(
        (
          await prisma.storePurchase.findUniqueOrThrow({
            where: { id: view.id },
          })
        ).takenBack,
      ).toMatchObject({
        question: 'answered',
        earning: { earning: 'cancelled' },
      });
      // The notice again does nothing more; the earning is not paid out after a refund.
      expect(outcomeOf(await appleNote('q-r4', 'REFUND', tx))).toBe(
        'duplicate',
      );
      expect(await prisma.earningDeduction.count({})).toBe(0);
      // A late sweep records nothing for a refunded purchase.
      expect(await questions.sweep()).toMatchObject({ earned: 0 });
      expect(await prisma.storeEarning.count({})).toBe(1);
    });

    it('after the answer and after the creator was paid: a deduction of the same amount, once', async () => {
      const { intent, tx } = await buyQuestion();
      await answer(intent.intentId).expect(201);
      await prisma.storeEarning.updateMany({
        data: { status: 'paid', paidAt: new Date() },
      });
      expect(outcomeOf(await appleNote('q-r5', 'REFUND', tx))).toBe(
        'taken_back',
      );
      const deductions = await prisma.earningDeduction.findMany({});
      expect(deductions).toHaveLength(1);
      expect(deductions[0]).toMatchObject({
        payeeWawuUserId: HOST,
        amountKobo: 85_000n,
      });
    });

    it('after the deadline: the question credit it made is voided, and a reversal brings it back', async () => {
      const { intent, tx } = await buyQuestion();
      await prisma.directMessage.update({
        where: { id: intent.intentId },
        data: { deadlineAt: new Date(Date.now() - HOUR) },
      });
      await questions.sweep();
      expect((await prisma.storeCredit.findFirstOrThrow({})).status).toBe(
        'open',
      );
      expect(outcomeOf(await appleNote('q-r6', 'REFUND', tx))).toBe(
        'taken_back',
      );
      expect((await prisma.storeCredit.findFirstOrThrow({})).status).toBe(
        'void',
      );
      expect(outcomeOf(await appleNote('q-rev2', 'REFUND_REVERSED', tx))).toBe(
        'restored',
      );
      expect((await prisma.storeCredit.findFirstOrThrow({})).status).toBe(
        'open',
      );
    });

    it('a refund of the payment a spent question credit is made of takes back the question it paid for, once', async () => {
      const { intent, tx } = await buyQuestion();
      await prisma.directMessage.update({
        where: { id: intent.intentId },
        data: { deadlineAt: new Date(Date.now() - HOUR) },
      });
      await questions.sweep();
      // The asker spends the credit on a question to the other creator.
      const paid = dataOf<Intent>(
        await ask(buyer, {
          ...q('android', OTHER, 500, 'Paid with the credit'),
          payWith: 'credit',
        }).expect(201),
      );
      await other
        .post(`/dm/${paid.intentId}/respond`, { text: 'Sure.' })
        .expect(201);
      expect(await prisma.storeEarning.count({})).toBe(1);
      expect(outcomeOf(await appleNote('q-r7', 'REFUND', tx))).toBe(
        'taken_back',
      );
      // What the credit paid for is taken back: its earning is cancelled, the rest of the credit is void.
      expect(await prisma.storeEarning.findFirstOrThrow({})).toMatchObject({
        status: 'cancelled',
      });
      expect(
        await prisma.storeCredit.count({ where: { status: 'open' } }),
      ).toBe(0);
    });
  });

  // --------------------------------------------------------- the sale notice

  describe('STORE-SALE-NOTICE: the creator is told of each store sale, once, with their 85% in naira', () => {
    it('a piece, a tip and a pass', async () => {
      const pieceIntent = await intentFor(content('ios'));
      iosSale('6100088000001', 'wawu.buy.1000');
      await postIos('6100088000001', pieceIntent.intentId).expect(201);
      const tipIntent = await intentFor(tip('ios', 500));
      iosSale('6100088000002', 'wawu.buy.500');
      await postIos('6100088000002', tipIntent.intentId, 'wawu.buy.500').expect(
        201,
      );
      const passIntent = await intentFor(pass('ios'));
      iosSale('6100088000003', 'wawu.buy.1000');
      await postIos('6100088000003', passIntent.intentId).expect(201);

      const sale = await notices(HOST, 'sale');
      expect(sale).toHaveLength(1);
      expect(sale[0]).toMatchObject({ amount: 850, tone: 'success' });
      expect(sale[0].body).toContain('₦850');
      const tipped = await notices(HOST, 'tip_received');
      expect(tipped).toHaveLength(1);
      expect(tipped[0]).toMatchObject({ amount: 425 });
      const passed = await notices(HOST, 'pass_sold');
      expect(passed).toHaveLength(1);
      expect(passed[0]).toMatchObject({ amount: 850 });
      expect(passed[0].body).toContain('Question spec room');

      // The same sales posted again tell nobody again.
      await postIos('6100088000001', pieceIntent.intentId).expect(201);
      await postIos('6100088000002', tipIntent.intentId, 'wawu.buy.500').expect(
        201,
      );
      await postIos('6100088000003', passIntent.intentId).expect(201);
      expect(await notices(HOST, 'sale')).toHaveLength(1);
      expect(await notices(HOST, 'tip_received')).toHaveLength(1);
      expect(await notices(HOST, 'pass_sold')).toHaveLength(1);
      // No notice says wallet, balance or cash, and none carries an em-dash.
      for (const n of [...sale, ...tipped, ...passed])
        expect(`${n.title} ${n.body}`).not.toMatch(/—|wallet|balance|cash/i);
    });

    it('a sale paid with a store credit is told too; a payment that became a credit tells nobody', async () => {
      await prisma.storeCredit.create({
        data: {
          wawuUserId: BUYER,
          amountKobo: 50_000,
          sourcePurchaseId: randomUUID(),
        },
      });
      await ask(buyer, { ...tip('android', 500), payWith: 'credit' }).expect(
        201,
      );
      expect(await notices(HOST, 'tip_received')).toHaveLength(1);
      // A piece taken down: paid, credited, nobody earns, nobody is told.
      const gone = await intentFor(content('ios'));
      await prisma.contentPiece.update({
        where: { id: piece },
        data: { status: 'removed' },
      });
      iosSale('6100088000004', 'wawu.buy.1000');
      const view = dataOf<PurchaseView>(
        await postIos('6100088000004', gone.intentId).expect(201),
      );
      await prisma.contentPiece.update({
        where: { id: piece },
        data: { status: 'live' },
      });
      expect(view.status).toBe('credited');
      expect(await notices(HOST, 'sale')).toHaveLength(0);
    });

    it('a question is told when it is answered, not when it is asked', async () => {
      const { intent } = await buyQuestion();
      expect(await notices(HOST, 'question_answered')).toHaveLength(0);
      await answer(intent.intentId).expect(201);
      const told = await notices(HOST, 'question_answered');
      expect(told).toHaveLength(1);
      expect(told[0].amount).toBe(850);
    });
  });

  // ------------------------------------------------------- patch round 1

  describe('patch round 1 (verifier findings)', () => {
    it('VQ-1: the creator is told an unanswered store question gives the asker a question credit, with their real window; the wallet words are unchanged', async () => {
      const { intent } = await buyQuestion(OTHER, 500);
      const got = await notices(OTHER, 'dm_received');
      expect(got).toHaveLength(1);
      expect(got[0].body).toBe(
        'Someone paid ₦500 to ask you a question. Reply within 12 hours or they get a question credit instead.',
      );
      expect(got[0].body).not.toMatch(/refund|—/);
      // The hourly reminder says the same of the same question.
      await prisma.directMessage.update({
        where: { id: intent.intentId },
        data: { deadlineAt: new Date(Date.now() + 3.6 * HOUR) },
      });
      const scheduler = new SchedulerService(
        prisma,
        moduleRef.get(NotificationService, { strict: false }),
        moduleRef.get(DmRefundService, { strict: false }),
      );
      await scheduler.remindDmDeadlines();
      const reminders = await notices(OTHER, 'dm_deadline');
      expect(reminders).toHaveLength(1);
      expect(reminders[0].body).toMatch(
        /^A paid question is still waiting\. About [34] hours left to reply before they get a question credit instead\.$/,
      );
      // The wallet and web words keep their wording.
      expect(
        composeNotification({
          kind: 'dm_received',
          userWawuId: 'u',
          amount: 1000,
        }).body,
      ).toBe(
        'Someone paid ₦1,000 to message you. Reply within 24 hours or it is refunded to them.',
      );
      expect(
        composeNotification({
          kind: 'dm_deadline',
          userWawuId: 'u',
          hoursLeft: 3,
        }).body,
      ).toBe(
        'A paid DM is still waiting. About 3 hours left to reply before it is refunded.',
      );
    });

    it('VQ-2: a reversal while the person has another question waiting on the creator gives a question credit, not a second waiting question', async () => {
      const a = await buyQuestion();
      expect(outcomeOf(await appleNote('v2-refund', 'REFUND', a.tx))).toBe(
        'taken_back',
      );
      // Asked again after the refund.
      const b = await buyQuestion();
      expect(b.view.status).toBe('granted');
      expect(
        outcomeOf(await appleNote('v2-reverse', 'REFUND_REVERSED', a.tx)),
      ).toBe('restored');
      const waiting = await prisma.directMessage.findMany({
        where: {
          senderWawuId: BUYER,
          creatorWawuId: HOST,
          status: 'awaiting_response',
        },
      });
      expect(waiting.map((m) => m.id)).toEqual([b.intent.intentId]);
      // The first question stays withdrawn (no miss for the creator) and its payment is a credit.
      expect(await dm(a.intent.intentId)).toMatchObject({
        status: 'refunded',
        refundReference: STORE_REFUND_MARK,
      });
      expect(await prisma.storeCredit.findFirstOrThrow({})).toMatchObject({
        wawuUserId: BUYER,
        amountKobo: 100_000,
        scope: 'question',
        status: 'open',
        sourcePurchaseId: a.view.id,
      });
      expect(
        (
          await prisma.storePurchase.findUniqueOrThrow({
            where: { id: a.view.id },
          })
        ).status,
      ).toBe('granted');
      // A second refund of the restored payment voids that credit.
      expect(outcomeOf(await appleNote('v2-refund2', 'REFUND', a.tx))).toBe(
        'taken_back',
      );
      expect((await prisma.storeCredit.findFirstOrThrow({})).status).toBe(
        'void',
      );
    });

    it('VQ-3: the words are cleared from the intent when the sale is credited instead of sent', async () => {
      const off = await intentFor(q('ios'));
      await prisma.creatorState.update({
        where: { wawuUserId: HOST },
        data: { dmEnabled: false },
      });
      iosSale('6100077000001', 'wawu.buy.1000');
      expect(
        dataOf<PurchaseView>(
          await postIos('6100077000001', off.intentId).expect(201),
        ).status,
      ).toBe('credited');
      expect(
        (
          await prisma.storePurchaseIntent.findUniqueOrThrow({
            where: { id: off.intentId },
          })
        ).questionText,
      ).toBeNull();
      // And when one is already waiting.
      await prisma.creatorState.update({
        where: { wawuUserId: HOST },
        data: { dmEnabled: true },
      });
      await buyQuestion();
      const product = await prisma.storeProduct.findFirstOrThrow({
        where: { platform: 'ios', storeProductId: 'wawu.buy.1000' },
      });
      const second = await prisma.storePurchaseIntent.create({
        data: {
          wawuUserId: BUYER,
          platform: 'ios',
          kind: 'question',
          targetId: HOST,
          listPriceNaira: 1000,
          listPriceKobo: 100_000,
          productId: product.id,
          storeProductId: 'wawu.buy.1000',
          expiresAt: new Date(Date.now() + HOUR),
          questionText: 'A second one',
          questionWindowHours: 24,
        },
      });
      iosSale('6100077000002', 'wawu.buy.1000');
      expect(
        dataOf<PurchaseView>(
          await postIos('6100077000002', second.id).expect(201),
        ).status,
      ).toBe('credited');
      expect(
        (
          await prisma.storePurchaseIntent.findUniqueOrThrow({
            where: { id: second.id },
          })
        ).questionText,
      ).toBeNull();
    });
  });

  // ---------------------------------------------------- the wallet path stays

  describe('the wallet path and the web are untouched', () => {
    it('the web’s sweeps leave a store question alone', async () => {
      const { intent } = await buyQuestion();
      await prisma.directMessage.update({
        where: { id: intent.intentId },
        data: { deadlineAt: new Date(Date.now() - HOUR) },
      });
      const scheduler = new SchedulerService(
        prisma,
        moduleRef.get(NotificationService, { strict: false }),
        moduleRef.get(DmRefundService, { strict: false }),
      );
      await scheduler.refundExpiredDms();
      expect(await dm(intent.intentId)).toMatchObject({
        status: 'awaiting_response',
        refundStatus: 'not_owed',
      });
    });
  });
});
