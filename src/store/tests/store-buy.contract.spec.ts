// Contract tests for STORE-BUY-HUB (R-101): buying a piece, a tip and a community pass through Apple
// and Google from one price ladder, `wawu.buy.<naira>`. Real HTTP, a real database, real guards and
// the real grant code; the two stores' servers are stand-ins (test/store/store-standins.ts). Run with
//   WAWU_ID_JWKS_URL=http://localhost:10690/.well-known/jwks.json WAWU_ID_BASE_URL=http://localhost:10690
//   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/sb2store_test?schema=public

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/sb2store_test?schema=public';

import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'child_process';
import type { Server } from 'http';
import type { INestApplication } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AccountPurgeService } from '../../account-purge/account-purge.service';
import { AdminRole } from '../../../generated/prisma/enums';
import { AdminTokenService } from '../../admin/auth/admin-token.service';
import { StoreIntentSweepService } from '../store-intent-sweep.service';
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
} from '../../../test/store/store-test-kit';
import {
  StandInAppStore,
  StandInGooglePlay,
  verified,
} from '../../../test/store/store-standins';
import { EarningsViewService } from '../../money/earnings/earnings-view.service';
import { payableAt } from '../store-buy-rules';
import { STORE_LADDER } from '../store-ladder';
import { loadStoreConfig } from '../store-config';

jest.setTimeout(120_000);

type Intent = {
  intentId: string;
  productId: string;
  accountToken: string;
  expiresAt: string;
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
  grant: {
    contentId?: string | null;
    creatorWawuId?: string | null;
    communityId: string | null;
    until: string | null;
  };
};

const HOUR = 3_600_000;
const NO_GRANTS = { packId: null, pack: null, tierId: null, days: null };

describe('STORE-BUY-HUB: buying through the price ladder (stand-in stores)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let mock: ChildProcess | undefined;
  let google: StandInGooglePlay;
  let apple: StandInAppStore;
  let tokenBuyer: string;
  let tokenOther: string;
  /** The buyer's and the other person's account tokens (what the app binds a purchase to). */
  let acctBuyer: string;
  let acctOther: string;
  const roomIds: string[] = [];
  const pieceIds: string[] = [];
  let piece: string; // paid, 1000
  let freePiece: string;
  let removedPiece: string;
  let ownPiece: string; // the buyer's own
  let room: string; // pass 1000
  let roomNoPass: string;
  let roomOffList: string; // pass 1234

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
  let other: ReturnType<typeof as>;
  const uid = () => randomUUID().slice(0, 8);

  const ask = (who: typeof buyer, body: object) =>
    who.post('/store/intents', body);
  const content = (platform: 'android' | 'ios', listPriceNaira = 1000) => ({
    platform,
    kind: 'content',
    contentId: piece,
    listPriceNaira,
  });
  const tip = (platform: 'android' | 'ios', listPriceNaira = 500) => ({
    platform,
    kind: 'tip',
    creatorWawuId: HOST,
    listPriceNaira,
  });
  const pass = (platform: 'android' | 'ios', listPriceNaira = 1000) => ({
    platform,
    kind: 'pass',
    communityId: room,
    listPriceNaira,
  });
  async function intentFor(body: object, who = buyer): Promise<Intent> {
    return dataOf<Intent>(await ask(who, body).expect(201));
  }

  /** A Google one-time purchase the stand-in store will vouch for. */
  function androidSale(
    purchaseToken: string,
    storeProductId: string,
    order: string,
    over: Partial<Parameters<typeof verified>[0]> = {},
  ): void {
    google.oneTime.set(
      purchaseToken,
      verified({
        platform: 'android',
        storeProductId,
        storeTransactionId: order,
        accountToken: acctBuyer,
        needsAcknowledge: true,
        ...over,
      }),
    );
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
  const postAndroid = (
    purchaseToken: string,
    intentId: string | undefined,
    productId = 'wawu.buy.1000',
    who = buyer,
  ) =>
    who.post('/store/purchases', {
      platform: 'android',
      productId,
      purchaseToken,
      ...(intentId ? { intentId } : {}),
    });
  const postIos = (
    transactionId: string,
    intentId: string | undefined,
    productId = 'wawu.buy.1000',
    who = buyer,
  ) =>
    who.post('/store/purchases', {
      platform: 'ios',
      productId,
      transactionId,
      ...(intentId ? { intentId } : {}),
    });
  const appleNote = (
    id: string,
    type: string,
    transactionId: string,
    over: Partial<Parameters<typeof verified>[0]> = {},
    signedAt: Date | null = null,
  ) => {
    const t = apple.transactions.get(transactionId)!;
    apple.notifications.set(`signed-${id}`, {
      notificationId: id,
      type,
      subtype: null,
      environment: 'production',
      transaction: { ...t, ...over },
      signedAt,
    });
    return http()
      .post(`${API}/webhooks/app-store`)
      .send({ signedPayload: `signed-${id}` });
  };
  const ownedRow = (id: string) =>
    prisma.purchase.findFirstOrThrow({
      where: { flutterwaveTxRef: `store:${id}` },
    });
  const outcomeOf = (res: request.Response) =>
    dataOf<{ outcome: string }>(res).outcome;

  async function wipe(): Promise<void> {
    await prisma.earningDeductionTake.deleteMany({});
    await prisma.earningDeduction.deleteMany({
      where: { storePurchaseId: { not: null } },
    });
    await prisma.earningMove.deleteMany({
      where: { payeeWawuUserId: { in: PEOPLE } },
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
    await prisma.storePurchase.deleteMany({});
    await prisma.storePurchaseIntent.deleteMany({});
    await prisma.storeCredit.deleteMany({});
    await prisma.storeNotification.deleteMany({});
    await prisma.blockedAccount.deleteMany({
      where: { userWawuId: { in: PEOPLE } },
    });
    await prisma.contentPiece.updateMany({
      where: { id: piece },
      data: { status: 'live' },
    });
  }

  beforeAll(async () => {
    mock = await ensureMockWawuId();
    tokenBuyer = mintToken(BUYER);
    tokenOther = mintToken(OTHER);
    google = new StandInGooglePlay();
    apple = new StandInAppStore();
    ({ app, moduleRef } = await build(STAND_IN_CONFIG, google, apple));
    prisma = moduleRef.get(PrismaService);
    buyer = as(tokenBuyer);
    other = as(tokenOther);
    acctBuyer = dataOf<{ accountToken: string }>(
      await buyer.get('/store/products?platform=android').expect(200),
    ).accountToken;
    acctOther = dataOf<{ accountToken: string }>(
      await other.get('/store/products?platform=android').expect(200),
    ).accountToken;

    // The ladder: what the rows migration writes, for both stores.
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
      [HOST, 'sb2host'],
      [BUYER, 'sb2buyer'],
      [OTHER, 'sb2other'],
    ] as const)
      await prisma.userProfile.upsert({
        where: { wawuUserId: id },
        create: {
          wawuUserId: id,
          accountType: 'creator',
          handle: `${handle}_${uid()}`,
        },
        update: {},
      });
    const mkPiece = async (
      creator: string,
      over: {
        accessType: 'paid' | 'free';
        price: number;
        status: 'live' | 'removed';
      },
    ) => {
      const row = await prisma.contentPiece.create({
        data: {
          slug: `sb2-${uid()}`,
          creatorWawuId: creator,
          contentType: 'video',
          title: `Ladder piece ${uid()}`,
          description: 'A piece',
          category: 'business_entrepreneurship',
          previewAssetUrl: 'https://cdn.example.com/p.jpg',
          fullAssetUrl: 'https://cdn.example.com/f.mp4',
          ...over,
        },
      });
      pieceIds.push(row.id);
      return row.id;
    };
    piece = await mkPiece(HOST, {
      accessType: 'paid',
      price: 1000,
      status: 'live',
    });
    freePiece = await mkPiece(HOST, {
      accessType: 'free',
      price: 0,
      status: 'live',
    });
    removedPiece = await mkPiece(HOST, {
      accessType: 'paid',
      price: 1000,
      status: 'removed',
    });
    ownPiece = await mkPiece(BUYER, {
      accessType: 'paid',
      price: 1000,
      status: 'live',
    });
    const mkRoom = async (passKobo: bigint | null) => {
      const c = await prisma.community.create({
        data: {
          name: `Ladder room ${uid()}`,
          description: 'A private room.',
          hostWawuId: HOST,
          kind: 'private',
          ...(passKobo === null
            ? {}
            : { passPrice: { create: { priceKobo: passKobo } } }),
        },
      });
      roomIds.push(c.id);
      return c.id;
    };
    room = await mkRoom(100_000n);
    roomNoPass = await mkRoom(null);
    roomOffList = await mkRoom(123_400n);
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

  describe('POST /store/intents', () => {
    it('a piece: answers the product, the account token and the expiry, and records an open intent', async () => {
      const res = await ask(buyer, content('android')).expect(201);
      const body = dataOf<Intent>(res);
      expect(body.productId).toBe('wawu.buy.1000');
      expect(body.accountToken).toBe(acctBuyer);
      const ms = new Date(body.expiresAt).getTime() - Date.now();
      expect(ms).toBeGreaterThan(59 * 60_000);
      expect(ms).toBeLessThanOrEqual(HOUR);
      const row = await prisma.storePurchaseIntent.findUniqueOrThrow({
        where: { id: body.intentId },
      });
      expect(row).toMatchObject({
        wawuUserId: BUYER,
        platform: 'android',
        kind: 'content',
        targetId: piece,
        listPriceNaira: 1000,
        listPriceKobo: 100_000,
        storeProductId: 'wawu.buy.1000',
        status: 'open',
      });
    });

    it('a tip and a pass: the tip is on the tip list, the pass equals the room price', async () => {
      const t = await intentFor(tip('ios', 500));
      expect(t.productId).toBe('wawu.buy.500');
      const p = await intentFor(pass('ios', 1000));
      expect(p.productId).toBe('wawu.buy.1000');
      expect(
        await prisma.storePurchaseIntent.count({ where: { status: 'open' } }),
      ).toBe(2);
    });

    it('one open intent per person, kind and target: the same ask returns the same intent; another price or store replaces it', async () => {
      const first = await intentFor(content('android'));
      const again = await intentFor(content('android'));
      expect(again.intentId).toBe(first.intentId);

      const other1 = await intentFor(content('ios'));
      expect(other1.intentId).not.toBe(first.intentId);
      const rows = await prisma.storePurchaseIntent.findMany({
        where: { wawuUserId: BUYER, kind: 'content', targetId: piece },
        orderBy: { createdAt: 'asc' },
      });
      expect(rows.map((r) => r.status)).toEqual(['replaced', 'open']);

      // The database holds the same line: a second open row for one thing is refused.
      await expect(
        prisma.storePurchaseIntent.create({
          data: {
            wawuUserId: BUYER,
            platform: 'ios',
            kind: 'content',
            targetId: piece,
            listPriceNaira: 1000,
            listPriceKobo: 100_000,
            productId: rows[1].productId,
            storeProductId: 'wawu.buy.1000',
            expiresAt: new Date(Date.now() + HOUR),
          },
        }),
      ).rejects.toThrow();
      // Two people may each hold one for the same piece.
      const theirs = await intentFor(content('android'), other);
      expect(theirs.intentId).not.toBe(first.intentId);
    });

    it('an intent past its time is closed and a new one is made', async () => {
      const first = await intentFor(content('android'));
      await prisma.storePurchaseIntent.update({
        where: { id: first.intentId },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });
      const second = await intentFor(content('android'));
      expect(second.intentId).not.toBe(first.intentId);
      const old = await prisma.storePurchaseIntent.findUniqueOrThrow({
        where: { id: first.intentId },
      });
      expect(old.status).toBe('expired');
    });

    it('a price off the list is price_not_on_list (400) with the nearest list prices; a tip off the tip list too', async () => {
      const res = await ask(buyer, content('android', 1234)).expect(400);
      expect(codeOf(res)).toBe('price_not_on_list');
      expect(
        (res.body as { reason: Record<string, unknown> }).reason,
      ).toMatchObject({ nearestLowerNaira: 1000, nearestHigherNaira: 1500 });
      // 1500 is on the price list but not on the tip list.
      const t = await ask(buyer, tip('android', 1500)).expect(400);
      expect(codeOf(t)).toBe('price_not_on_list');
      expect((t.body as { message: string }).message).not.toContain('—');
      expect(await prisma.storePurchaseIntent.count({})).toBe(0);
    });

    it("a piece: refused when free, its own, already the person's, taken down, unknown, blocked or priced differently", async () => {
      const code = async (body: object, status: number, who = buyer) =>
        codeOf(await ask(who, body).expect(status));
      expect(
        await code({ ...content('android'), contentId: freePiece }, 409),
      ).toBe('store_intent_not_payable');
      expect(
        await code({ ...content('android'), contentId: ownPiece }, 409),
      ).toBe('store_intent_not_payable');
      expect(
        await code({ ...content('android'), contentId: removedPiece }, 404),
      ).toBe('store_intent_target_not_found');
      expect(
        await code({ ...content('android'), contentId: randomUUID() }, 404),
      ).toBe('store_intent_target_not_found');
      expect(await code(content('android', 2000), 409)).toBe(
        'store_intent_price_changed',
      );
      await prisma.purchase.create({
        data: {
          contentId: piece,
          type: 'content',
          buyerWawuId: BUYER,
          creatorWawuId: HOST,
          amount: 1000,
          commissionRate: 0.15,
          flutterwaveTxRef: `store:owned-${uid()}`,
          status: 'completed',
        },
      });
      expect(await code(content('android'), 409)).toBe(
        'store_intent_not_payable',
      );
      await prisma.blockedAccount.create({
        data: { userWawuId: OTHER, blockedWawuId: HOST },
      });
      expect(await code(content('android'), 404, other)).toBe(
        'store_intent_target_not_found',
      );
      expect(await prisma.storePurchaseIntent.count({})).toBe(0);
    });

    it('a tip: refused to oneself, to nobody, and across a block', async () => {
      const code = async (body: object, status: number, who = buyer) =>
        codeOf(await ask(who, body).expect(status));
      expect(await code({ ...tip('android'), creatorWawuId: BUYER }, 409)).toBe(
        'store_intent_not_payable',
      );
      expect(
        await code({ ...tip('android'), creatorWawuId: randomUUID() }, 404),
      ).toBe('store_intent_target_not_found');
      await prisma.blockedAccount.create({
        data: { userWawuId: HOST, blockedWawuId: OTHER },
      });
      expect(await code(tip('android'), 409, other)).toBe(
        'store_intent_not_payable',
      );
    });

    it("a pass: refused when the price is not the room's, the room sells none, it is their own, they were removed, or it is unknown or blocked", async () => {
      const code = async (body: object, status: number, who = buyer) =>
        codeOf(await ask(who, body).expect(status));
      expect(await code(pass('android', 2000), 409)).toBe(
        'store_intent_price_changed',
      );
      expect(
        await code({ ...pass('android'), communityId: roomNoPass }, 409),
      ).toBe('store_intent_not_payable');
      // The room priced at 1,234 is not on the list, so no list price equals it.
      expect(
        await code({ ...pass('android', 1000), communityId: roomOffList }, 409),
      ).toBe('store_intent_price_changed');
      expect(
        await code({ ...pass('android'), communityId: randomUUID() }, 404),
      ).toBe('store_intent_target_not_found');
      await prisma.communityMembership.create({
        data: { userWawuId: OTHER, communityId: room, status: 'pending' },
      });
      expect(await code(pass('android'), 409, other)).toBe(
        'store_intent_not_payable',
      );
      // The host does not buy their own pass.
      const asHost = as(mintToken(HOST));
      expect(await code(pass('android'), 409, asHost)).toBe(
        'store_intent_not_payable',
      );
      await prisma.blockedAccount.create({
        data: { userWawuId: BUYER, blockedWawuId: HOST },
      });
      expect(await code(pass('android'), 404)).toBe(
        'store_intent_target_not_found',
      );
    });

    it('a price the store does not sell yet is store_product_unknown (404); a request that names the wrong thing is a 400', async () => {
      await prisma.storeProduct.updateMany({
        where: { storeProductId: 'wawu.buy.1000', platform: 'ios' },
        data: { active: false },
      });
      expect(codeOf(await ask(buyer, content('ios')).expect(404))).toBe(
        'store_product_unknown',
      );
      await prisma.storeProduct.updateMany({
        where: { storeProductId: 'wawu.buy.1000' },
        data: { active: true },
      });
      await ask(buyer, {
        platform: 'android',
        kind: 'content',
        listPriceNaira: 1000,
      }).expect(400);
      await ask(buyer, { ...content('android'), creatorWawuId: HOST }).expect(
        400,
      );
      await ask(buyer, { ...content('android'), kind: 'gift' }).expect(400);
      await ask(buyer, { ...content('android'), listPriceNaira: 10.5 }).expect(
        400,
      );
    });

    it('needs a signed-in person, and answers store_not_configured with no keys', async () => {
      await http()
        .post(`${API}/store/intents`)
        .send(content('android'))
        .expect(401);
      const bare = await build(loadStoreConfig({}), null, null);
      try {
        const res = await request(bare.app.getHttpServer() as Server)
          .post(`${API}/store/intents`)
          .set('Authorization', `Bearer ${tokenBuyer}`)
          .send(content('android'))
          .expect(503);
        expect(codeOf(res)).toBe('store_not_configured');
      } finally {
        await bare.app.close();
      }
    });
  });

  // -------------------------------------------------------- GET /store/products

  it('GET /store/products lists the ladder with the list price and the Nigeria store price', async () => {
    const list = dataOf<{
      products: Array<{
        storeProductId: string;
        kind: string;
        listPriceKobo: number;
        storePriceKobo: number;
        subscription: boolean;
      }>;
    }>(await buyer.get('/store/products?platform=ios').expect(200));
    expect(list.products).toHaveLength(25);
    expect(list.products[3]).toMatchObject({
      storeProductId: 'wawu.buy.1000',
      kind: 'buy',
      listPriceKobo: 100_000,
      storePriceKobo: 130_000,
      subscription: false,
    });
  });

  // -------------------------------------------------------------- GET /prices

  describe('GET /prices', () => {
    it('adds storePriceNaira to every list price and tip, from the active ladder rows', async () => {
      const view = dataOf<{
        prices: Array<{ priceNaira: number; storePriceNaira: number | null }>;
        tips: Array<{ priceNaira: number; storePriceNaira: number | null }>;
      }>(await buyer.get('/prices').expect(200));
      expect(view.prices).toHaveLength(25);
      for (const s of STORE_LADDER)
        expect(
          view.prices.find((p) => p.priceNaira === s.listNaira),
        ).toMatchObject({
          storePriceNaira: s.storeNaira,
        });
      expect(view.tips.find((t) => t.priceNaira === 1000)).toMatchObject({
        storePriceNaira: 1300,
      });
    });

    it("is null where no ladder row is active, and one store's prices with ?platform=", async () => {
      await prisma.storeProduct.updateMany({
        where: { storeProductId: 'wawu.buy.500', platform: 'ios' },
        data: { storePriceKobo: 70_000 },
      });
      await prisma.storeProduct.updateMany({
        where: { storeProductId: 'wawu.buy.200' },
        data: { active: false },
      });
      try {
        const pick = (
          v: {
            prices: Array<{
              priceNaira: number;
              storePriceNaira: number | null;
            }>;
          },
          n: number,
        ) => v.prices.find((p) => p.priceNaira === n)!.storePriceNaira;
        type V = Parameters<typeof pick>[0];
        const both = dataOf<V>(await buyer.get('/prices').expect(200));
        const android = dataOf<V>(
          await buyer.get('/prices?platform=android').expect(200),
        );
        const ios = dataOf<V>(
          await buyer.get('/prices?platform=ios').expect(200),
        );
        expect(pick(both, 200)).toBeNull();
        // With no platform, the higher of the two stores' prices.
        expect(pick(both, 500)).toBe(700);
        expect(pick(android, 500)).toBe(650);
        expect(pick(ios, 500)).toBe(700);
        await buyer.get('/prices?platform=windows').expect(400);
      } finally {
        await prisma.storeProduct.updateMany({
          where: { storeProductId: 'wawu.buy.500' },
          data: { storePriceKobo: 65_000 },
        });
        await prisma.storeProduct.updateMany({
          where: { storeProductId: 'wawu.buy.200' },
          data: { active: true },
        });
      }
    });
  });

  // ----------------------------------------------------------- the purchases

  describe('POST /store/purchases against an intent', () => {
    it("a piece on Google: unlocks it once, records the creator's 85% of the LIST price, consumes the purchase, and a replay gives nothing more", async () => {
      const intent = await intentFor(content('android'));
      androidSale('tok-piece', 'wawu.buy.1000', 'GPA.piece-1');
      const res = await postAndroid('tok-piece', intent.intentId).expect(201);
      const view = dataOf<PurchaseView>(res);
      expect(view).toMatchObject({
        kind: 'buy',
        buyKind: 'content',
        intentId: intent.intentId,
        targetId: piece,
        status: 'granted',
        alreadyGranted: false,
        flag: null,
      });
      expect(view.grant.contentId).toBe(piece);
      expect(google.consumed).toEqual(['tok-piece']);

      // The same row the wallet path writes.
      const rows = await prisma.purchase.findMany({
        where: { flutterwaveTxRef: `store:${view.id}` },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        contentId: piece,
        type: 'content',
        buyerWawuId: BUYER,
        creatorWawuId: HOST,
        amount: 1000,
        status: 'completed',
      });
      expect(Number(rows[0].commissionRate)).toBe(0.15);

      // The creator's 85% of the list price, to be paid 3 working days on.
      const earnings = await prisma.storeEarning.findMany({});
      expect(earnings).toHaveLength(1);
      expect(earnings[0]).toMatchObject({
        storePurchaseId: view.id,
        role: 'sale',
        source: 'store',
        payeeWawuUserId: HOST,
        kind: 'content_unlock',
        targetId: piece,
        listPriceKobo: 100_000n,
        amountKobo: 85_000n,
        status: 'owed',
      });
      expect(earnings[0].availableAt).toEqual(payableAt(earnings[0].earnedAt));
      expect(earnings[0].availableAt.getTime()).toBeGreaterThan(
        earnings[0].earnedAt.getTime() + 3 * 86_400_000 - 1,
      );

      const used = await prisma.storePurchaseIntent.findUniqueOrThrow({
        where: { id: intent.intentId },
      });
      expect(used.status).toBe('used');
      expect(used.usedAt).not.toBeNull();

      const replay = await postAndroid('tok-piece', intent.intentId).expect(
        201,
      );
      expect(dataOf<PurchaseView>(replay)).toMatchObject({
        id: view.id,
        alreadyGranted: true,
      });
      expect(
        await prisma.purchase.count({
          where: { flutterwaveTxRef: `store:${view.id}` },
        }),
      ).toBe(1);
      expect(await prisma.storeEarning.count({})).toBe(1);

      // The piece is now theirs: another intent for it is refused.
      expect(codeOf(await ask(buyer, content('android')).expect(409))).toBe(
        'store_intent_not_payable',
      );
    });

    it("a tip on Apple: records the tip as the wallet path does, and 85% of the list tip is the creator's", async () => {
      const intent = await intentFor(tip('ios', 500));
      iosSale('1000000000001', 'wawu.buy.500');
      const view = dataOf<PurchaseView>(
        await postIos('1000000000001', intent.intentId, 'wawu.buy.500').expect(
          201,
        ),
      );
      expect(view).toMatchObject({ buyKind: 'tip', status: 'granted' });
      expect(view.grant.creatorWawuId).toBe(HOST);
      const row = await prisma.purchase.findFirstOrThrow({
        where: { flutterwaveTxRef: `store:${view.id}` },
      });
      expect(row).toMatchObject({
        type: 'tip',
        contentId: null,
        buyerWawuId: BUYER,
        creatorWawuId: HOST,
        amount: 500,
        status: 'completed',
      });
      const earning = await prisma.storeEarning.findFirstOrThrow({});
      expect(earning).toMatchObject({
        kind: 'tip',
        targetId: HOST,
        listPriceKobo: 50_000n,
        amountKobo: 42_500n,
      });
    });

    it('a pass: gives 30 days in the room, makes the person a member, and the host earns 85% of the list price', async () => {
      const intent = await intentFor(pass('android', 1000));
      androidSale('tok-pass', 'wawu.buy.1000', 'GPA.pass-1');
      const view = dataOf<PurchaseView>(
        await postAndroid('tok-pass', intent.intentId).expect(201),
      );
      expect(view).toMatchObject({ buyKind: 'pass', status: 'granted' });
      expect(view.grant.communityId).toBe(room);
      const period = await prisma.communityPass.findFirstOrThrow({
        where: { userWawuId: BUYER, communityId: room },
      });
      expect(period.walletPaymentId).toBe(`store:${view.id}`);
      expect(period.endsAt.getTime() - period.startsAt.getTime()).toBe(
        30 * 86_400_000,
      );
      expect(view.grant.until).toBe(period.endsAt.toISOString());
      expect(
        await prisma.communityMembership.findUniqueOrThrow({
          where: {
            userWawuId_communityId: { userWawuId: BUYER, communityId: room },
          },
        }),
      ).toMatchObject({ status: 'joined' });
      expect(await prisma.storeEarning.findFirstOrThrow({})).toMatchObject({
        kind: 'community_pass',
        payeeWawuUserId: HOST,
        targetId: room,
        amountKobo: 85_000n,
      });
      const purchase = await prisma.storePurchase.findUniqueOrThrow({
        where: { id: view.id },
      });
      expect(purchase).toMatchObject({
        creatorWawuUserId: HOST,
        creatorShareKobo: 85_000,
        referenceKobo: 100_000,
        // WAWU receives at least the list price, so the net is the list price.
        netKobo: 100_000,
        communityId: room,
        buyKind: 'pass',
      });
    });

    it('the sale date sets when the creator may be paid: a Friday sale is payable on the Wednesday', async () => {
      const intent = await intentFor(content('android'));
      await prisma.storePurchaseIntent.update({
        where: { id: intent.intentId },
        data: {
          createdAt: new Date('2026-10-20T00:00:00Z'),
          expiresAt: new Date('2026-11-30T00:00:00Z'),
        },
      });
      androidSale('tok-fri', 'wawu.buy.1000', 'GPA.fri', {
        purchasedAt: new Date('2026-10-23T12:00:00Z'),
      });
      await postAndroid('tok-fri', intent.intentId).expect(201);
      const earning = await prisma.storeEarning.findFirstOrThrow({});
      expect(earning.earnedAt.toISOString()).toBe('2026-10-23T12:00:00.000Z');
      expect(earning.availableAt.toISOString()).toBe(
        '2026-10-28T12:00:00.000Z',
      );
    });

    it("refuses a purchase that is not for the intent's product, store, person or time, and gives nothing", async () => {
      const intent = await intentFor(content('android'));
      // Another list price's product.
      androidSale('tok-p2', 'wawu.buy.2000', 'GPA.p2');
      expect(
        codeOf(
          await postAndroid('tok-p2', intent.intentId, 'wawu.buy.2000').expect(
            422,
          ),
        ),
      ).toBe('store_purchase_invalid');
      // The store says it is for another product than the one posted.
      androidSale('tok-p3', 'wawu.buy.500', 'GPA.p3');
      expect(
        codeOf(
          await postAndroid('tok-p3', intent.intentId, 'wawu.buy.1000').expect(
            422,
          ),
        ),
      ).toBe('store_purchase_invalid');
      // The other store.
      iosSale('1000000000002', 'wawu.buy.1000');
      expect(
        codeOf(await postIos('1000000000002', intent.intentId).expect(422)),
      ).toBe('store_purchase_invalid');
      // Another person's account token on the store's record.
      androidSale('tok-theirs', 'wawu.buy.1000', 'GPA.theirs', {
        accountToken: acctOther,
      });
      expect(
        codeOf(await postAndroid('tok-theirs', intent.intentId).expect(409)),
      ).toBe('store_purchase_taken');
      // No account token at all, after the cutover.
      androidSale('tok-none', 'wawu.buy.1000', 'GPA.none', {
        accountToken: null,
      });
      expect(
        codeOf(await postAndroid('tok-none', intent.intentId).expect(422)),
      ).toBe('store_account_token_missing');
      // Another person's intent, and none.
      androidSale('tok-ok', 'wawu.buy.1000', 'GPA.ok');
      expect(
        codeOf(
          await postAndroid(
            'tok-ok',
            intent.intentId,
            'wawu.buy.1000',
            other,
          ).expect(404),
        ),
      ).toBe('store_intent_not_found');
      expect(
        codeOf(await postAndroid('tok-ok', randomUUID()).expect(404)),
      ).toBe('store_intent_not_found');
      expect(codeOf(await postAndroid('tok-ok', undefined).expect(400))).toBe(
        'store_receipt_missing',
      );
      // An intent id that is not an id.
      await buyer
        .post('/store/purchases', {
          platform: 'android',
          productId: 'wawu.buy.1000',
          purchaseToken: 'tok-ok',
          intentId: 'not-a-uuid',
        })
        .expect(400);

      expect(await prisma.storePurchase.count({})).toBe(0);
      expect(await prisma.storeEarning.count({})).toBe(0);
      expect(
        await prisma.purchase.count({
          where: { flutterwaveTxRef: { startsWith: 'store:' } },
        }),
      ).toBe(0);
      const still = await prisma.storePurchaseIntent.findUniqueOrThrow({
        where: { id: intent.intentId },
      });
      expect(still.status).toBe('open');
    });

    it('one intent is one purchase, and one store transaction is given for one intent', async () => {
      const intent = await intentFor(content('android'));
      androidSale('tok-a', 'wawu.buy.1000', 'GPA.a');
      androidSale('tok-b', 'wawu.buy.1000', 'GPA.b');
      await postAndroid('tok-a', intent.intentId).expect(201);
      // A second payment against the same intent.
      expect(
        codeOf(await postAndroid('tok-b', intent.intentId).expect(409)),
      ).toBe('store_intent_used');
      // The first payment named for another intent of the same person.
      const tipIntent = await intentFor(tip('android', 1000));
      expect(
        codeOf(await postAndroid('tok-a', tipIntent.intentId).expect(409)),
      ).toBe('store_purchase_other_intent');
      expect(await prisma.storePurchase.count({})).toBe(1);
      expect(await prisma.storeEarning.count({})).toBe(1);
    });

    it('another person cannot take a transaction that was granted to the buyer', async () => {
      const intent = await intentFor(content('android'));
      androidSale('tok-x', 'wawu.buy.1000', 'GPA.x');
      await postAndroid('tok-x', intent.intentId).expect(201);
      const theirs = await intentFor(content('android'), other);
      expect(
        codeOf(
          await postAndroid(
            'tok-x',
            theirs.intentId,
            'wawu.buy.1000',
            other,
          ).expect(409),
        ),
      ).toBe('store_purchase_taken');
    });

    it('judges the intent at the time of the SALE: a slow post of a timely sale is granted, a sale after the expiry is refused', async () => {
      const intent = await intentFor(content('android'));
      await prisma.storePurchaseIntent.update({
        where: { id: intent.intentId },
        data: {
          createdAt: new Date(Date.now() - 70 * 60_000),
          expiresAt: new Date(Date.now() - 10 * 60_000),
        },
      });
      // Sold 20 minutes ago, before the intent ran out, posted only now.
      androidSale('tok-slow', 'wawu.buy.1000', 'GPA.slow', {
        purchasedAt: new Date(Date.now() - 20 * 60_000),
      });
      // Sold just now, after it ran out.
      androidSale('tok-late', 'wawu.buy.1000', 'GPA.late');
      expect(
        codeOf(await postAndroid('tok-late', intent.intentId).expect(409)),
      ).toBe('store_intent_expired');
      expect(await prisma.storePurchase.count({})).toBe(0);
      expect(
        dataOf<PurchaseView>(
          await postAndroid('tok-slow', intent.intentId).expect(201),
        ).status,
      ).toBe('granted');
      // Posting the granted sale again, long after, is still a replay and not an expiry.
      expect(
        dataOf<PurchaseView>(
          await postAndroid('tok-slow', intent.intentId).expect(201),
        ).alreadyGranted,
      ).toBe(true);
    });

    it('a piece taken down after the intent: the fan is credited the list price, nothing is given or earned, and the answer says so', async () => {
      const intent = await intentFor(content('android'));
      await prisma.contentPiece.update({
        where: { id: piece },
        data: { status: 'removed' },
      });
      androidSale('tok-gone', 'wawu.buy.1000', 'GPA.gone');
      const view = dataOf<PurchaseView>(
        await postAndroid('tok-gone', intent.intentId).expect(201),
      );
      expect(view.status).toBe('credited');
      expect(view.flag).toBe('target_unavailable');
      expect(
        await prisma.purchase.count({
          where: { flutterwaveTxRef: { startsWith: 'store:' } },
        }),
      ).toBe(0);
      expect(await prisma.storeEarning.count({})).toBe(0);
      expect(
        (
          await prisma.storePurchaseIntent.findUniqueOrThrow({
            where: { id: intent.intentId },
          })
        ).status,
      ).toBe('used');
      expect(await prisma.storeCredit.findFirstOrThrow({})).toMatchObject({
        wawuUserId: BUYER,
        amountKobo: 100_000,
        status: 'open',
      });
    });

    it('a pass for a person the host removed meanwhile is credited and gives no days', async () => {
      const intent = await intentFor(pass('android'));
      await prisma.communityMembership.create({
        data: { userWawuId: BUYER, communityId: room, status: 'pending' },
      });
      androidSale('tok-rem', 'wawu.buy.1000', 'GPA.rem');
      const view = dataOf<PurchaseView>(
        await postAndroid('tok-rem', intent.intentId).expect(201),
      );
      expect(view.status).toBe('credited');
      expect(view.flag).toBe('target_unavailable');
      expect(
        await prisma.communityPass.count({ where: { userWawuId: BUYER } }),
      ).toBe(0);
      expect(await prisma.storeEarning.count({})).toBe(0);
      expect(
        await prisma.storeCredit.count({
          where: { wawuUserId: BUYER, status: 'open' },
        }),
      ).toBe(1);
    });

    it('a ladder product with no intent id is refused, and an intent id on any other product is refused', async () => {
      androidSale('tok-n', 'wawu.buy.1000', 'GPA.n');
      expect(codeOf(await postAndroid('tok-n', undefined).expect(400))).toBe(
        'store_receipt_missing',
      );
      const intent = await intentFor(content('android'));
      await prisma.storeProduct.create({
        data: {
          platform: 'android',
          kind: 'pass',
          storeProductId: 'wawu_pass_30_old',
          title: 'Old pass',
          grants: { days: 30 },
          referenceKobo: 200_000,
        },
      });
      try {
        androidSale('tok-old', 'wawu_pass_30_old', 'GPA.old');
        expect(
          codeOf(
            await postAndroid(
              'tok-old',
              intent.intentId,
              'wawu_pass_30_old',
            ).expect(422),
          ),
        ).toBe('store_purchase_invalid');
      } finally {
        await prisma.storeProduct.deleteMany({
          where: { storeProductId: 'wawu_pass_30_old' },
        });
      }
    });
  });

  // ----------------------------------------------- refunds and revocations

  describe('refunds, revocations and reversed refunds', () => {
    async function buyPieceOnApple(txid: string): Promise<PurchaseView> {
      const intent = await intentFor(content('ios'));
      iosSale(txid, 'wawu.buy.1000');
      return dataOf<PurchaseView>(
        await postIos(txid, intent.intentId).expect(201),
      );
    }
    const ownedRow = (id: string) =>
      prisma.purchase.findFirstOrThrow({
        where: { flutterwaveTxRef: `store:${id}` },
      });

    it('a refund before the earning was paid: the unlock is removed and the earning is cancelled; the same notice twice does it once', async () => {
      const view = await buyPieceOnApple('2000000000001');
      expect((await ownedRow(view.id)).status).toBe('completed');
      expect(
        outcomeOf(await appleNote('n-r1', 'REFUND', '2000000000001')),
      ).toBe('taken_back');
      expect((await ownedRow(view.id)).status).toBe('failed');
      expect(await prisma.storeEarning.findFirstOrThrow({})).toMatchObject({
        status: 'cancelled',
        cancelReason: 'refunded_by_store',
      });
      expect(await prisma.earningDeduction.count({})).toBe(0);
      const purchase = await prisma.storePurchase.findUniqueOrThrow({
        where: { id: view.id },
      });
      expect(purchase.status).toBe('refunded');
      expect(purchase.takenBack).toMatchObject({
        earning: { earning: 'cancelled' },
      });
      // The notice again (a new id from Apple, or a redelivery): nothing more happens.
      expect(
        outcomeOf(await appleNote('n-r1', 'REFUND', '2000000000001')),
      ).toBe('duplicate');
      expect(
        outcomeOf(await appleNote('n-r2', 'REFUND', '2000000000001')),
      ).toBe('duplicate');
      expect(await prisma.earningDeduction.count({})).toBe(0);
      // The person can ask to buy it again.
      await ask(buyer, content('ios')).expect(201);
    });

    it('a revocation does the same as a refund', async () => {
      const view = await buyPieceOnApple('2000000000002');
      expect(
        outcomeOf(await appleNote('n-v1', 'REVOKE', '2000000000002')),
      ).toBe('taken_back');
      expect((await ownedRow(view.id)).status).toBe('failed');
      expect(
        (
          await prisma.storePurchase.findUniqueOrThrow({
            where: { id: view.id },
          })
        ).status,
      ).toBe('revoked');
      expect((await prisma.storeEarning.findFirstOrThrow({})).status).toBe(
        'cancelled',
      );
    });

    it("a refund after the earning was paid: a deduction of the creator's 85% comes off their next earnings, once, and the earning is left as paid", async () => {
      const view = await buyPieceOnApple('2000000000003');
      // STORE-PAYOUT (later) is what pays an earning; here it has been paid.
      await prisma.storeEarning.updateMany({
        data: { status: 'paid', paidAt: new Date() },
      });
      expect(
        outcomeOf(await appleNote('n-d1', 'REFUND', '2000000000003')),
      ).toBe('taken_back');
      const deductions = await prisma.earningDeduction.findMany({});
      expect(deductions).toHaveLength(1);
      expect(deductions[0]).toMatchObject({
        payeeWawuUserId: HOST,
        storePurchaseId: view.id,
        passRefundId: null,
        amountKobo: 85_000n,
      });
      expect(deductions[0].provider).toBe('fintava');
      expect((await prisma.storeEarning.findFirstOrThrow({})).status).toBe(
        'paid',
      );
      expect(
        outcomeOf(await appleNote('n-d2', 'REFUND', '2000000000003')),
      ).toBe('duplicate');
      expect(await prisma.earningDeduction.count({})).toBe(1);
      // The database refuses a deduction that names neither or both sources.
      await expect(
        prisma.earningDeduction.create({
          data: { payeeWawuUserId: HOST, amountKobo: 1n },
        }),
      ).rejects.toThrow();
      expect((await ownedRow(view.id)).status).toBe('failed');
    });

    it('a reversed refund puts the unlock and the earning back; the notice twice restores once; a revocation is not reversed by it', async () => {
      const view = await buyPieceOnApple('2000000000004');
      await appleNote('n-b1', 'REFUND', '2000000000004');
      expect((await ownedRow(view.id)).status).toBe('failed');
      expect(
        outcomeOf(await appleNote('n-b2', 'REFUND_REVERSED', '2000000000004')),
      ).toBe('restored');
      expect((await ownedRow(view.id)).status).toBe('completed');
      expect(await prisma.storeEarning.findFirstOrThrow({})).toMatchObject({
        status: 'owed',
        cancelledAt: null,
        cancelReason: null,
      });
      const purchase = await prisma.storePurchase.findUniqueOrThrow({
        where: { id: view.id },
      });
      expect(purchase).toMatchObject({
        status: 'granted',
        endedAt: null,
        endReason: null,
      });
      expect(
        outcomeOf(await appleNote('n-b3', 'REFUND_REVERSED', '2000000000004')),
      ).toBe('duplicate');
      // And it can be refunded again.
      expect(
        outcomeOf(await appleNote('n-b4', 'REFUND', '2000000000004')),
      ).toBe('taken_back');
      expect((await ownedRow(view.id)).status).toBe('failed');
      expect((await prisma.storeEarning.findFirstOrThrow({})).status).toBe(
        'cancelled',
      );
      expect(
        outcomeOf(await appleNote('n-b5', 'REFUND_REVERSED', '2000000000004')),
      ).toBe('restored');
    });

    it('a revocation is not what REFUND_REVERSED reverses', async () => {
      const view = await buyPieceOnApple('2000000000005');
      await appleNote('n-rv1', 'REVOKE', '2000000000005');
      expect(
        outcomeOf(await appleNote('n-rv2', 'REFUND_REVERSED', '2000000000005')),
      ).toBe('duplicate');
      expect((await ownedRow(view.id)).status).toBe('failed');
      expect((await prisma.storeEarning.findFirstOrThrow({})).status).toBe(
        'cancelled',
      );
    });

    it('a reversed refund of a paid earning: the deduction is voided when nothing was taken, and the part already taken is owed back', async () => {
      const first = await buyPieceOnApple('2000000000006');
      await prisma.storeEarning.updateMany({
        data: { status: 'paid', paidAt: new Date() },
      });
      await appleNote('n-p1', 'REFUND', '2000000000006');
      expect(await prisma.earningDeduction.count({})).toBe(1);
      expect(
        outcomeOf(await appleNote('n-p2', 'REFUND_REVERSED', '2000000000006')),
      ).toBe('restored');
      expect(await prisma.earningDeduction.count({})).toBe(0);
      expect((await ownedRow(first.id)).status).toBe('completed');

      // Refunded again and this time part of the deduction was taken by a daily move.
      await appleNote('n-p3', 'REFUND', '2000000000006');
      const deduction = await prisma.earningDeduction.findFirstOrThrow({});
      const move = await prisma.earningMove.create({
        data: {
          payeeWawuUserId: HOST,
          dayKey: '2026-10-27',
          provider: 'fintava',
          merchantAccountNumber: '0000000000',
          amountKobo: 100_000n,
          earnings: 1,
          customerReference: `sb2-${uid()}`,
        },
      });
      await prisma.earningDeductionTake.create({
        data: {
          deductionId: deduction.id,
          moveId: move.id,
          amountKobo: 30_000n,
        },
      });
      expect(
        outcomeOf(await appleNote('n-p4', 'REFUND_REVERSED', '2000000000006')),
      ).toBe('restored');
      expect(
        (
          await prisma.earningDeduction.findUniqueOrThrow({
            where: { id: deduction.id },
          })
        ).amountKobo,
      ).toBe(30_000n);
      const back = await prisma.storeEarning.findFirstOrThrow({
        where: { role: 'restore' },
      });
      expect(back).toMatchObject({
        status: 'owed',
        amountKobo: 30_000n,
        payeeWawuUserId: HOST,
      });
      // A third refund of an earning that was given back in part is for a person.
      await prisma.storeEarning.update({
        where: { id: back.id },
        data: { status: 'paid', paidAt: new Date() },
      });
      await appleNote('n-p5', 'REFUND', '2000000000006');
      expect(
        (
          await prisma.storePurchase.findUniqueOrThrow({
            where: { id: first.id },
          })
        ).flag,
      ).toBe('earning_review');
    });

    it("a tip is refunded: the creator's share goes and the tip stops counting; a reversal brings both back", async () => {
      const intent = await intentFor(tip('ios', 1000));
      iosSale('2000000000007', 'wawu.buy.1000');
      const view = dataOf<PurchaseView>(
        await postIos('2000000000007', intent.intentId).expect(201),
      );
      await appleNote('n-t1', 'REFUND', '2000000000007');
      expect((await ownedRow(view.id)).status).toBe('failed');
      expect((await prisma.storeEarning.findFirstOrThrow({})).status).toBe(
        'cancelled',
      );
      await appleNote('n-t2', 'REFUND_REVERSED', '2000000000007');
      expect((await ownedRow(view.id)).status).toBe('completed');
      expect((await prisma.storeEarning.findFirstOrThrow({})).status).toBe(
        'owed',
      );
    });

    it("a pass is refunded: the days stop now and the host's share is cancelled; a reversal gives the days back", async () => {
      const intent = await intentFor(pass('ios', 1000));
      iosSale('2000000000008', 'wawu.buy.1000');
      const view = dataOf<PurchaseView>(
        await postIos('2000000000008', intent.intentId).expect(201),
      );
      await appleNote('n-s1', 'REFUND', '2000000000008');
      const ended = await prisma.communityPass.findFirstOrThrow({
        where: { userWawuId: BUYER },
      });
      expect(ended.endsAt.getTime()).toBeLessThanOrEqual(Date.now());
      const taken = (
        await prisma.storePurchase.findUniqueOrThrow({ where: { id: view.id } })
      ).takenBack as { daysRemoved: number };
      expect(taken.daysRemoved).toBe(30);
      expect((await prisma.storeEarning.findFirstOrThrow({})).status).toBe(
        'cancelled',
      );
      await appleNote('n-s2', 'REFUND_REVERSED', '2000000000008');
      const rows = await prisma.communityPass.findMany({
        where: { userWawuId: BUYER },
        orderBy: { endsAt: 'desc' },
      });
      expect(rows).toHaveLength(2);
      expect(rows[0].walletPaymentId).toContain(`store:${view.id}:restored:`);
      expect(rows[0].endsAt.getTime()).toBeGreaterThan(
        Date.now() + 29 * 86_400_000,
      );
      // Refunded again: the restored days stop too.
      await appleNote('n-s3', 'REFUND', '2000000000008');
      const after = await prisma.communityPass.findMany({
        where: { userWawuId: BUYER },
      });
      for (const r of after)
        expect(r.endsAt.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it("Google's voided purchase takes a ladder purchase back the same way, and a store switched off still takes refunds", async () => {
      const intent = await intentFor(content('android'));
      androidSale('tok-void', 'wawu.buy.1000', 'GPA.void');
      const view = dataOf<PurchaseView>(
        await postAndroid('tok-void', intent.intentId).expect(201),
      );
      const push = (note: object, messageId: string) =>
        http()
          .post(`${API}/webhooks/google-play`)
          .set('Authorization', `Bearer ${google.pushToken}`)
          .send({
            message: {
              data: Buffer.from(
                JSON.stringify({ packageName: 'africa.wawu.test', ...note }),
              ).toString('base64'),
              messageId,
            },
          });
      await prisma.storePlatformSetting.upsert({
        where: { platform: 'android' },
        create: { platform: 'android', enabled: false },
        update: { enabled: false },
      });
      try {
        const res = await push(
          {
            voidedPurchaseNotification: {
              orderId: 'GPA.void',
              purchaseToken: 'x',
              productType: 2,
              refundType: 1,
            },
          },
          `m-${uid()}`,
        );
        expect(outcomeOf(res)).toBe('taken_back');
      } finally {
        await prisma.storePlatformSetting.deleteMany({
          where: { platform: 'android' },
        });
      }
      expect((await ownedRow(view.id)).status).toBe('failed');
      expect((await prisma.storeEarning.findFirstOrThrow({})).status).toBe(
        'cancelled',
      );
    });

    it('a reversal of a refund of something that is not a ladder purchase is ignored, as before', async () => {
      await prisma.storeProduct.create({
        data: {
          platform: 'ios',
          kind: 'pass',
          storeProductId: 'wawu.pass.30.old',
          title: 'Old pass',
          grants: { days: 30 },
          referenceKobo: 200_000,
        },
      });
      try {
        const product = await prisma.storeProduct.findFirstOrThrow({
          where: { storeProductId: 'wawu.pass.30.old' },
        });
        await prisma.storePurchase.create({
          data: {
            wawuUserId: BUYER,
            platform: 'ios',
            storeTransactionId: '2000000000009',
            productId: product.id,
            storeProductId: product.storeProductId,
            kind: 'pass',
            status: 'refunded',
            environment: 'production',
            grant: {},
            storeFeeBps: 1500,
            purchasedAt: new Date(),
          },
        });
        iosSale('2000000000009', 'wawu.pass.30.old');
        expect(
          outcomeOf(
            await appleNote('n-o1', 'REFUND_REVERSED', '2000000000009'),
          ),
        ).toBe('ignored');
        expect(
          (
            await prisma.storePurchase.findFirstOrThrow({
              where: { storeTransactionId: '2000000000009' },
            })
          ).status,
        ).toBe('refunded');
      } finally {
        await prisma.storePurchase.deleteMany({});
        await prisma.storeProduct.deleteMany({
          where: { storeProductId: 'wawu.pass.30.old' },
        });
      }
    });
  });

  // ------------------------------------------------------------ the creator

  it("a store earning is the creator's to see as earned and waiting, and is not a daily-move earning: the mover has nothing of it", async () => {
    const intent = await intentFor(content('android'));
    androidSale('tok-view', 'wawu.buy.1000', 'GPA.view');
    await postAndroid('tok-view', intent.intentId).expect(201);
    // The mover reads EarningSettlement only, and nothing was written there, so
    // the earning cannot be paid before its day (STORE-PAYOUT pays it).
    expect(
      await prisma.earningSettlement.count({
        where: { payeeWawuUserId: HOST },
      }),
    ).toBe(0);
    const earnings = new EarningsViewService(prisma, {
      name: 'fintava',
    } as never);
    const seen = await earnings.summary(HOST, undefined);
    expect(seen.allTime).toMatchObject({ earnedKobo: 85_000, sales: 1 });
    expect(seen.allTime.streams).toEqual([
      { kind: 'content_unlock', earnedKobo: 85_000, sales: 1 },
    ]);
    expect(seen.waiting).toEqual({ count: 1, amountKobo: 85_000 });
    // Refunded before it was paid, it is not earned.
    const view = await prisma.storePurchase.findFirstOrThrow({});
    const note = await prisma.storeEarning.updateMany({
      data: {
        status: 'cancelled',
        cancelledAt: new Date(),
        cancelReason: 'refunded_by_store',
      },
    });
    expect(note.count).toBe(1);
    expect(view.id).toBeDefined();
    const after = await earnings.summary(HOST, undefined);
    expect(after.allTime.earnedKobo).toBe(0);
    expect(after.waiting).toEqual({ count: 0, amountKobo: 0 });
    // Paid, it is earned and no longer waiting.
    await prisma.storeEarning.updateMany({
      data: {
        status: 'paid',
        paidAt: new Date(),
        cancelledAt: null,
        cancelReason: null,
      },
    });
    const paid = await earnings.summary(HOST, undefined);
    expect(paid.allTime.earnedKobo).toBe(85_000);
    expect(paid.waiting).toEqual({ count: 0, amountKobo: 0 });
  });

  // ===================================================== round 3 (verifier)

  describe("round 3: the buyer's account is deleted, refunds arrive out of order, a credit instead of nothing", () => {
    const T = (minute: number) =>
      new Date(Date.UTC(2026, 9, 27, 12, minute, 0));

    it("H1: a purchase survives the buyer's deletion with the buyer cleared, so a later refund still takes the creator's 85% back", async () => {
      const gone = randomUUID();
      const asGone = as(mintToken(gone));
      const acct = dataOf<{ accountToken: string }>(
        await asGone.get('/store/products?platform=ios').expect(200),
      ).accountToken;
      const intent = await intentFor(content('ios'), asGone);
      iosSale('3000000000001', 'wawu.buy.1000', { accountToken: acct });
      const view = dataOf<PurchaseView>(
        await postIos(
          '3000000000001',
          intent.intentId,
          'wawu.buy.1000',
          asGone,
        ).expect(201),
      );
      await prisma.storeEarning.updateMany({
        data: { status: 'paid', paidAt: new Date() },
      });

      const purge = await new AccountPurgeService(prisma).purge(gone);
      expect(purge.failed).toEqual([]);
      const kept = await prisma.storePurchase.findUniqueOrThrow({
        where: { id: view.id },
      });
      expect(kept).toMatchObject({
        wawuUserId: null,
        currency: null,
        priceMicros: null,
        storeTransactionId: '3000000000001',
        creatorWawuUserId: HOST,
        status: 'granted',
        buyKind: 'content',
      });
      expect(
        await prisma.storeAccountToken.count({ where: { wawuUserId: gone } }),
      ).toBe(0);
      expect(
        await prisma.storePurchaseIntent.count({ where: { wawuUserId: gone } }),
      ).toBe(0);
      expect(
        await prisma.storeEarning.count({
          where: { storePurchaseId: view.id },
        }),
      ).toBe(1);

      // The store pays it back later: the purchase is found and the share comes back.
      expect(
        outcomeOf(await appleNote('n-g1', 'REFUND', '3000000000001')),
      ).toBe('taken_back');
      expect(await prisma.earningDeduction.findFirstOrThrow({})).toMatchObject({
        payeeWawuUserId: HOST,
        storePurchaseId: view.id,
        amountKobo: 85_000n,
      });
      expect(
        (
          await prisma.storePurchase.findUniqueOrThrow({
            where: { id: view.id },
          })
        ).status,
      ).toBe('refunded');
      expect(
        outcomeOf(await appleNote('n-g2', 'REFUND', '3000000000001')),
      ).toBe('duplicate');
      // Nobody else can claim the cleared purchase's transaction.
      expect(await prisma.earningDeduction.count({})).toBe(1);
    });

    it("H1: an unpaid share is cancelled when a deleted buyer's purchase is refunded, and a pass bought by them needs no days taken", async () => {
      const gone = randomUUID();
      const asGone = as(mintToken(gone));
      const acct = dataOf<{ accountToken: string }>(
        await asGone.get('/store/products?platform=ios').expect(200),
      ).accountToken;
      const intent = await intentFor({ ...pass('ios') }, asGone);
      iosSale('3000000000002', 'wawu.buy.1000', { accountToken: acct });
      await postIos(
        '3000000000002',
        intent.intentId,
        'wawu.buy.1000',
        asGone,
      ).expect(201);
      await new AccountPurgeService(prisma).purge(gone);
      expect(
        await prisma.communityPass.count({ where: { userWawuId: gone } }),
      ).toBe(0);
      expect(
        outcomeOf(await appleNote('n-g3', 'REFUND', '3000000000002')),
      ).toBe('taken_back');
      expect((await prisma.storeEarning.findFirstOrThrow({})).status).toBe(
        'cancelled',
      );
      expect(await prisma.earningDeduction.count({})).toBe(0);
    });

    it('M1: a reversal that arrives before its refund ends granted; the notices are ordered by their signed date, in every order', async () => {
      const intentA = await intentFor(content('ios'));
      iosSale('3000000000003', 'wawu.buy.1000');
      const view = dataOf<PurchaseView>(
        await postIos('3000000000003', intentA.intentId).expect(201),
      );
      const row = () =>
        prisma.storePurchase.findUniqueOrThrow({ where: { id: view.id } });
      const unlock = () => ownedRow(view.id);
      // Reversal (signed 12:05) arrives first, then the refund it reverses (signed 12:00).
      expect(
        outcomeOf(
          await appleNote('m1-a', 'REFUND_REVERSED', '3000000000003', {}, T(5)),
        ),
      ).toBe('duplicate');
      expect(
        outcomeOf(await appleNote('m1-b', 'REFUND', '3000000000003', {}, T(0))),
      ).toBe('ignored');
      expect((await row()).status).toBe('granted');
      expect((await unlock()).status).toBe('completed');
      expect((await prisma.storeEarning.findFirstOrThrow({})).status).toBe(
        'owed',
      );
      expect((await row()).lastNoticeAt?.toISOString()).toBe(
        T(5).toISOString(),
      );
      // In order, the full cycle: refund 12:10, reversal 12:20, refund 12:30.
      expect(
        outcomeOf(
          await appleNote('m1-c', 'REFUND', '3000000000003', {}, T(10)),
        ),
      ).toBe('taken_back');
      expect(
        outcomeOf(
          await appleNote(
            'm1-d',
            'REFUND_REVERSED',
            '3000000000003',
            {},
            T(20),
          ),
        ),
      ).toBe('restored');
      expect((await row()).status).toBe('granted');
      expect(
        outcomeOf(
          await appleNote('m1-e', 'REFUND', '3000000000003', {}, T(30)),
        ),
      ).toBe('taken_back');
      expect((await row()).status).toBe('refunded');
      expect((await unlock()).status).toBe('failed');
      // The reversal that was late (12:20) arrives again now: older than the last, it changes nothing.
      expect(
        outcomeOf(
          await appleNote(
            'm1-f',
            'REFUND_REVERSED',
            '3000000000003',
            {},
            T(20),
          ),
        ),
      ).toBe('ignored');
      expect((await row()).status).toBe('refunded');
      expect((await prisma.storeEarning.findFirstOrThrow({})).status).toBe(
        'cancelled',
      );
    });

    it('M1: refund 12:30 arriving before reversal 12:20 and refund 12:10 ends refunded', async () => {
      const intent = await intentFor(content('ios'));
      iosSale('3000000000004', 'wawu.buy.1000');
      const view = dataOf<PurchaseView>(
        await postIos('3000000000004', intent.intentId).expect(201),
      );
      expect(
        outcomeOf(
          await appleNote('m1-g', 'REFUND', '3000000000004', {}, T(30)),
        ),
      ).toBe('taken_back');
      expect(
        outcomeOf(
          await appleNote(
            'm1-h',
            'REFUND_REVERSED',
            '3000000000004',
            {},
            T(20),
          ),
        ),
      ).toBe('ignored');
      expect(
        outcomeOf(
          await appleNote('m1-i', 'REFUND', '3000000000004', {}, T(10)),
        ),
      ).toBe('ignored');
      expect(
        (
          await prisma.storePurchase.findUniqueOrThrow({
            where: { id: view.id },
          })
        ).status,
      ).toBe('refunded');
      expect((await ownedRow(view.id)).status).toBe('failed');
    });

    it('L1: a payment made before the intent was started cannot be re-posted under a fresh intent', async () => {
      const intent = await intentFor(content('android'));
      androidSale('tok-old', 'wawu.buy.1000', 'GPA.old-sale', {
        purchasedAt: new Date(Date.now() - 2 * 3_600_000),
      });
      expect(
        codeOf(await postAndroid('tok-old', intent.intentId).expect(422)),
      ).toBe('store_purchase_invalid');
      // Inside the clock difference it counts.
      androidSale('tok-near', 'wawu.buy.1000', 'GPA.near-sale', {
        purchasedAt: new Date(Date.now() - 2 * 60_000),
      });
      expect(
        dataOf<PurchaseView>(
          await postAndroid('tok-near', intent.intentId).expect(201),
        ).status,
      ).toBe('granted');
    });

    it("L2: a price raised after the intent is granted at the intent's price, flagged price_changed", async () => {
      const intent = await intentFor(content('android'));
      await prisma.contentPiece.update({
        where: { id: piece },
        data: { price: 1500 },
      });
      try {
        androidSale('tok-up', 'wawu.buy.1000', 'GPA.up');
        const view = dataOf<PurchaseView>(
          await postAndroid('tok-up', intent.intentId).expect(201),
        );
        expect(view.status).toBe('granted');
        expect(view.flag).toBe('price_changed');
        expect(await ownedRow(view.id)).toMatchObject({
          amount: 1000,
          status: 'completed',
        });
        expect(await prisma.storeEarning.findFirstOrThrow({})).toMatchObject({
          listPriceKobo: 100_000n,
          amountKobo: 85_000n,
        });
      } finally {
        await prisma.contentPiece.update({
          where: { id: piece },
          data: { price: 1000 },
        });
      }
    });

    it('L3: a sweep deletes intents that were never used, 7 days after they ran out, and nothing else', async () => {
      const mk = (over: Record<string, unknown>) =>
        prisma.storePurchaseIntent.create({
          data: {
            wawuUserId: BUYER,
            platform: 'android',
            kind: 'tip',
            targetId: randomUUID(),
            listPriceNaira: 500,
            listPriceKobo: 50_000,
            productId: randomUUID(),
            storeProductId: 'wawu.buy.500',
            expiresAt: new Date(),
            ...over,
          },
        });
      const day = 86_400_000;
      const old = (n: number) => new Date(Date.now() - n * day);
      const gone1 = await mk({ status: 'open', expiresAt: old(8) });
      const gone2 = await mk({ status: 'expired', expiresAt: old(9) });
      const gone3 = await mk({ status: 'replaced', expiresAt: old(30) });
      const young = await mk({ status: 'expired', expiresAt: old(2) });
      const live = await mk({
        status: 'open',
        expiresAt: new Date(Date.now() + day),
      });
      const used = await mk({
        status: 'used',
        usedAt: old(40),
        expiresAt: old(40),
      });
      const deleted = await moduleRef.get(StoreIntentSweepService).sweep();
      expect(deleted).toBe(3);
      const left = (await prisma.storePurchaseIntent.findMany({}))
        .map((r) => r.id)
        .sort();
      expect(left).toEqual([young.id, live.id, used.id].sort());
      expect(left).not.toContain(gone1.id);
      expect(left).not.toContain(gone2.id);
      expect(left).not.toContain(gone3.id);
    });

    it("L4: the creator's earnings show the day each waiting store share may be paid", async () => {
      const intent = await intentFor(content('android'));
      androidSale('tok-l4', 'wawu.buy.1000', 'GPA.l4');
      await postAndroid('tok-l4', intent.intentId).expect(201);
      const earnings = new EarningsViewService(prisma, {
        name: 'fintava',
      } as never);
      const seen = await earnings.summary(HOST, undefined);
      const row = await prisma.storeEarning.findFirstOrThrow({});
      expect(seen.storeEarnings).toEqual([
        {
          kind: 'content_unlock',
          targetId: piece,
          title: expect.any(String) as string,
          amountKobo: 85_000,
          earnedAt: row.earnedAt.toISOString(),
          availableAt: row.availableAt.toISOString(),
        },
      ]);
      await prisma.storeEarning.updateMany({
        data: { status: 'paid', paidAt: new Date() },
      });
      expect((await earnings.summary(HOST, undefined)).storeEarnings).toEqual(
        [],
      );
    });

    describe('M2: a payment whose target is gone becomes a store credit', () => {
      const credited = async (
        setup: () => Promise<void>,
        kind: 'content' | 'pass' = 'content',
      ) => {
        const intent = await intentFor(
          kind === 'content' ? content('android') : pass('android'),
        );
        await setup();
        const token = `tok-c-${uid()}`;
        androidSale(token, 'wawu.buy.1000', `GPA.c-${uid()}`);
        return dataOf<PurchaseView>(
          await postAndroid(token, intent.intentId).expect(201),
        );
      };

      it('free now, already theirs, or taken down: status credited, the sentence the app shows, a credit of the list price, no grant, no earning', async () => {
        const free = await credited(async () => {
          await prisma.contentPiece.update({
            where: { id: piece },
            data: { accessType: 'free' },
          });
        });
        await prisma.contentPiece.update({
          where: { id: piece },
          data: { accessType: 'paid' },
        });
        expect(free.status).toBe('credited');
        expect(free.credit).toEqual({
          id: expect.any(String) as string,
          amountKobo: 100_000,
          message:
            'This piece is no longer available. You have a ₦1,000 credit to use on Who Made This.',
        });
        expect(free.flag).toBe('target_unavailable');
        await credited(async () => {
          await prisma.purchase.create({
            data: {
              contentId: piece,
              type: 'content',
              buyerWawuId: BUYER,
              creatorWawuId: HOST,
              amount: 1000,
              commissionRate: 0.15,
              flutterwaveTxRef: `store:owned-${uid()}`,
              status: 'completed',
            },
          });
        });
        await prisma.purchase.deleteMany({
          where: { flutterwaveTxRef: { startsWith: 'store:owned-' } },
        });
        await credited(async () => {
          await prisma.contentPiece.update({
            where: { id: piece },
            data: { status: 'removed' },
          });
        });
        expect(
          await prisma.storeCredit.count({
            where: { wawuUserId: BUYER, status: 'open' },
          }),
        ).toBe(3);
        expect(await prisma.storeEarning.count({})).toBe(0);
        expect(
          await prisma.purchase.count({
            where: { flutterwaveTxRef: { startsWith: 'store:' } },
          }),
        ).toBe(0);
        // The credits are the person's to see, and nobody else's.
        const list = dataOf<{ credits: Array<{ amountKobo: number }> }>(
          await buyer.get('/store/credits').expect(200),
        );
        expect(list.credits.map((c) => c.amountKobo)).toEqual([
          100_000, 100_000, 100_000,
        ]);
        expect(
          dataOf<{ credits: unknown[] }>(
            await other.get('/store/credits').expect(200),
          ).credits,
        ).toEqual([]);
      });

      it('a replay of the credited payment answers the same credit, and makes no second one', async () => {
        const intent = await intentFor(content('android'));
        await prisma.contentPiece.update({
          where: { id: piece },
          data: { status: 'removed' },
        });
        androidSale('tok-rp', 'wawu.buy.1000', 'GPA.rp');
        const first = dataOf<PurchaseView>(
          await postAndroid('tok-rp', intent.intentId).expect(201),
        );
        const again = dataOf<PurchaseView>(
          await postAndroid('tok-rp', intent.intentId).expect(201),
        );
        expect(again).toMatchObject({
          id: first.id,
          status: 'credited',
          alreadyGranted: true,
        });
        expect(again.credit).toEqual(first.credit);
        expect(await prisma.storeCredit.count({})).toBe(1);
      });

      it('a pass for a member the host removed is credited, with the pass sentence', async () => {
        const removedPass = await credited(async () => {
          await prisma.communityMembership.create({
            data: { userWawuId: BUYER, communityId: room, status: 'pending' },
          });
        }, 'pass');
        expect(removedPass.credit?.message).toBe(
          'This pass is no longer available. You have a ₦1,000 credit to use on Who Made This.',
        );
      });

      it('pays with a credit: no store sheet, the credit is consumed whole, the grant is at once and the creator earns 85% of the list price', async () => {
        const credit = await prisma.storeCredit.create({
          data: {
            wawuUserId: BUYER,
            amountKobo: 100_000,
            sourcePurchaseId: randomUUID(),
          },
        });
        // A 500 tip with a 1,000 credit: the credit is whole and used up.
        const res = await ask(buyer, {
          ...tip('android', 500),
          payWith: 'credit',
        }).expect(201);
        const body = dataOf<Intent & { purchase: PurchaseView }>(res);
        expect(body.purchase).toMatchObject({
          status: 'granted',
          buyKind: 'tip',
          paidWithCredit: credit.id,
        });
        expect(
          await prisma.storeCredit.findUniqueOrThrow({
            where: { id: credit.id },
          }),
        ).toMatchObject({
          status: 'spent',
          spentPurchaseId: body.purchase.id,
        });
        expect(
          await prisma.storePurchase.findUniqueOrThrow({
            where: { id: body.purchase.id },
          }),
        ).toMatchObject({
          storeTransactionId: `credit:${credit.id}`,
          kind: 'buy',
          referenceKobo: 50_000,
          creatorShareKobo: 42_500,
        });
        expect(await ownedRow(body.purchase.id)).toMatchObject({
          type: 'tip',
          amount: 500,
        });
        expect(await prisma.storeEarning.findFirstOrThrow({})).toMatchObject({
          amountKobo: 42_500n,
          kind: 'tip',
        });
        // Used once: the next ask has nothing to pay with.
        expect(
          codeOf(
            await ask(buyer, {
              ...tip('android', 200),
              payWith: 'credit',
            }).expect(409),
          ),
        ).toBe('store_credit_insufficient');
      });

      it('picks the smallest credit that fits, refuses a price above every credit, and spends nothing on something that is gone', async () => {
        const mkCredit = (amountKobo: number) =>
          prisma.storeCredit.create({
            data: {
              wawuUserId: BUYER,
              amountKobo,
              sourcePurchaseId: randomUUID(),
            },
          });
        const small = await mkCredit(50_000);
        const big = await mkCredit(200_000);
        // A 500 tip uses the 500 credit; a 1,000 piece needs the larger one.
        const tipped = dataOf<Intent & { purchase: PurchaseView }>(
          await ask(buyer, {
            ...tip('android', 500),
            payWith: 'credit',
          }).expect(201),
        );
        expect(tipped.purchase.paidWithCredit).toBe(small.id);
        const bought = dataOf<Intent & { purchase: PurchaseView }>(
          await ask(buyer, {
            ...content('android', 1000),
            payWith: 'credit',
          }).expect(201),
        );
        expect(bought.purchase).toMatchObject({
          status: 'granted',
          paidWithCredit: big.id,
        });
        expect((await ownedRow(bought.purchase.id)).type).toBe('content');
        expect(
          await prisma.storeCredit.count({ where: { status: 'spent' } }),
        ).toBe(2);
        await prisma.storeCredit.deleteMany({});
        await prisma.purchase.deleteMany({
          where: { flutterwaveTxRef: { startsWith: 'store:' } },
        });
        // A credit below the price pays for nothing at that price.
        const lesser = await mkCredit(50_000);
        expect(
          codeOf(
            await ask(buyer, {
              ...pass('android', 1000),
              payWith: 'credit',
            }).expect(409),
          ),
        ).toBe('store_credit_insufficient');
        await prisma.storeCredit.deleteMany({});
        // A credit is never spent on something that is gone.
        const fits = await mkCredit(100_000);
        await prisma.contentPiece.update({
          where: { id: piece },
          data: { status: 'removed' },
        });
        expect(
          codeOf(
            await ask(buyer, {
              ...content('android'),
              payWith: 'credit',
            }).expect(404),
          ),
        ).toBe('store_intent_target_not_found');
        expect(
          (
            await prisma.storeCredit.findUniqueOrThrow({
              where: { id: fits.id },
            })
          ).status,
        ).toBe('open');
        expect(lesser.status).toBe('open');
      });

      it('a store refund voids the credit it made while unspent, a reversal brings it back, and a spent one goes to a person', async () => {
        const intent = await intentFor(content('ios'));
        await prisma.contentPiece.update({
          where: { id: piece },
          data: { status: 'removed' },
        });
        iosSale('3000000000005', 'wawu.buy.1000');
        const view = dataOf<PurchaseView>(
          await postIos('3000000000005', intent.intentId).expect(201),
        );
        expect(view.status).toBe('credited');
        await appleNote('c-1', 'REFUND', '3000000000005', {}, T(1));
        expect(await prisma.storeCredit.findFirstOrThrow({})).toMatchObject({
          status: 'void',
        });
        await appleNote('c-2', 'REFUND_REVERSED', '3000000000005', {}, T(2));
        expect(await prisma.storeCredit.findFirstOrThrow({})).toMatchObject({
          status: 'open',
          voidedAt: null,
        });
        // Spend it, then the store refunds the original.
        await prisma.contentPiece.update({
          where: { id: piece },
          data: { status: 'live' },
        });
        dataOf(
          await ask(buyer, { ...tip('ios', 1000), payWith: 'credit' }).expect(
            201,
          ),
        );
        await appleNote('c-3', 'REFUND', '3000000000005', {}, T(3));
        expect((await prisma.storeCredit.findFirstOrThrow({})).status).toBe(
          'spent',
        );
        expect(
          (
            await prisma.storePurchase.findUniqueOrThrow({
              where: { id: view.id },
            })
          ).flag,
        ).toBe('earning_review');
      });

      it('admin/store/purchases can be filtered by flag', async () => {
        for (const [k, v] of Object.entries({
          ADMIN_JWT_SECRET: 'sb2-admin-access-secret-0123456789abcdef',
          ADMIN_JWT_REFRESH_SECRET: 'sb2-admin-refresh-secret-0123456789abcd',
        }))
          process.env[k] = process.env[k] ?? v;
        const adminId = randomUUID();
        const token = moduleRef.get(AdminTokenService).issuePair(
          await prisma.adminUser.create({
            data: {
              id: adminId,
              email: `sb2-${adminId}@admin.test.wawu.dev`,
              passwordHash: 'x',
              name: 'SB2 finance',
              role: AdminRole.finance,
            },
          }),
        ).accessToken;
        try {
          const intent = await intentFor(content('android'));
          await prisma.contentPiece.update({
            where: { id: piece },
            data: { status: 'removed' },
          });
          androidSale('tok-adm', 'wawu.buy.1000', 'GPA.adm');
          await postAndroid('tok-adm', intent.intentId).expect(201);
          const list = async (qs: string) =>
            dataOf<{
              items: Array<{ flag: string | null; buyKind: string | null }>;
            }>(
              await http()
                .get(`${API}/admin/store/purchases${qs}`)
                .set('Authorization', `Bearer ${token}`)
                .expect(200),
            ).items;
          expect(
            (await list('?flag=target_unavailable')).map((r) => r.flag),
          ).toEqual(['target_unavailable']);
          expect(await list('?flag=member_removed')).toEqual([]);
          expect((await list('')).length).toBe(1);
        } finally {
          await prisma.adminUser.deleteMany({ where: { id: adminId } });
        }
      });
    });
  });
});
