/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import * as jwt from 'jsonwebtoken';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { WawuIdClient } from '../../common/auth/wawu-id.client';
import { WawuJwtStrategy } from '../../common/auth/wawu-jwt.strategy';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ContentPieceModule } from '../../content-piece/content-piece.module';
import { ContentPieceService } from '../../content-piece/content-piece.service';
import { PRODUCT_DRAFTS_MAX } from '../../content-piece/product-draft.service';
import { CreatorStateModule } from '../../creator-state/creator-state.module';
import { StorageModule } from '../../storage/storage.module';
import { STORAGE_LOCK_WAITERS_PER_PERSON } from '../../storage/storage-lock';
import { TICK_UPLOADS } from '../../common/creator-allowance';
import { PLANS_CONFIG, type PlansConfig } from '../plans-config';
import { PlansModule } from '../plans.module';
import type { MyTierView, PlansView, PlanTierView } from '../plans-view.type';
import { PublishingGate } from '../publishing-gate.service';

/**
 * TIER-02 over HTTP, on the real database and the real modules: "Publishing,
 * or uploading any file, needs an active tier, and published products never
 * exceed the tier's products plus any extra products bought" (R-43).
 *
 * Tokens are real RS256 tokens checked against the stand-in WAWU ID's JWKS
 * (WAWU_ID_JWKS_URL), minted with its key so each person's phone and country
 * can be chosen, as plans.contract.spec.ts does. Every person is this spec's
 * own, a fresh id, and is removed in afterAll. Tiers are seeded as MakerTier
 * rows (the purchase path is TIER-03's); every figure compared with is read
 * from the config.
 */

const DAY = 86_400_000;
const NIGERIAN = '+2348031234567';
const ABROAD = '+447700900123';

function mintToken(sub: string, phone: string, country: string): string {
  const privateKey = readFileSync(
    join(__dirname, '../../../mock-wawu-id/private.pem'),
    'utf8',
  );
  return jwt.sign(
    {
      sub,
      email: `gate-${sub}@test.wawu.dev`,
      phone,
      firstName: 'Gate',
      lastName: 'Tester',
      country,
      verificationTier: 'basic',
      trustScore: 0,
      status: 'active',
    },
    privateKey,
    { algorithm: 'RS256', keyid: 'mock-wawu-id-key-1', expiresIn: '15m' },
  );
}

type Envelope = {
  statusCode: number;
  message: string;
  data: any;
  reason?: any;
};
const body = (r: Response): Envelope => r.body as Envelope;
/** The tier offers a refusal carried, as the plan's own type. */
const tiersOf = (r: Response): PlanTierView[] =>
  (body(r).reason as { tiers: PlanTierView[] }).tiers;

const STORAGE_ENV: Record<string, string> = {
  STORAGE_ENDPOINT: 'https://bucket.example-storage.dev',
  STORAGE_ACCESS_KEY_ID: 'gate-test-key',
  STORAGE_SECRET_ACCESS_KEY: 'gate-test-secret',
  STORAGE_BUCKET: 'gate-test-bucket',
  STORAGE_REGION: 'auto',
};

describe('Publishing needs a tier (TIER-02) over HTTP', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let config: PlansConfig;
  const envSnapshot: Record<string, string | undefined> = {};
  const people: string[] = [];
  const phones = new Map<string, [string, string]>();
  let seq = 0;

  /** A fresh creator account that has done nothing yet. */
  async function creator(
    phone = NIGERIAN,
    country = 'Nigeria',
  ): Promise<string> {
    const id = randomUUID();
    people.push(id);
    phones.set(id, [phone, country]);
    await prisma.userProfile.create({
      data: { wawuUserId: id, accountType: 'creator' },
    });
    return id;
  }
  async function plainUser(): Promise<string> {
    const id = randomUUID();
    people.push(id);
    phones.set(id, [NIGERIAN, 'Nigeria']);
    await prisma.userProfile.create({
      data: { wawuUserId: id, accountType: 'user' },
    });
    return id;
  }
  const auth = (id: string) => {
    const [phone, country] = phones.get(id) ?? [NIGERIAN, 'Nigeria'];
    return `Bearer ${mintToken(id, phone, country)}`;
  };
  const http = () => request(app.getHttpServer());
  const get = (id: string, path: string) =>
    http().get(`/api/hub${path}`).set('Authorization', auth(id));
  const post = (id: string, path: string, send?: object) =>
    http().post(`/api/hub${path}`).set('Authorization', auth(id)).send(send);
  const patch = (id: string, path: string, send: object) =>
    http().patch(`/api/hub${path}`).set('Authorization', auth(id)).send(send);
  const del = (id: string, path: string) =>
    http().delete(`/api/hub${path}`).set('Authorization', auth(id));

  const pieceBody = (over: Record<string, unknown> = {}) => {
    seq += 1;
    return {
      contentType: 'video',
      title: `Gate piece ${seq}`,
      description: 'A piece the publishing gate spec makes.',
      category: 'business_entrepreneurship',
      specializations: [],
      accessType: 'paid',
      price: 1500,
      previewAsset: `https://cdn.example.com/p-${seq}.jpg`,
      fullAsset: `https://cdn.example.com/f-${seq}.mp4`,
      ...over,
    };
  };
  const publish = (id: string, over?: Record<string, unknown>) =>
    post(id, '/content', pieceBody(over));
  const presign = (id: string, folder = 'content/preview') =>
    post(id, '/uploads/presign', {
      folder,
      contentType: 'image/png',
      extension: 'png',
      contentLength: 1000,
    });
  const myTier = async (id: string): Promise<MyTierView> =>
    body(await get(id, '/me/tier').expect(200)).data as MyTierView;
  const plansFor = async (id: string): Promise<PlansView> =>
    body(await get(id, '/plans').expect(200)).data as PlansView;

  /** A tier row as the purchase path will write it: index 0 is the cheapest. */
  async function giveTier(
    id: string,
    tierIndex: number,
    opts: { endsInDays?: number; extra?: number } = {},
  ): Promise<void> {
    const t = config.tiers[tierIndex];
    const until = Date.now() + (opts.endsInDays ?? 20) * DAY;
    await prisma.makerTier.upsert({
      where: { wawuUserId: id },
      create: {
        wawuUserId: id,
        tierId: t.id,
        // The period must run forwards (a check in the table), also for a tier
        // that ended yesterday.
        activeFrom: new Date(until - t.days * DAY),
        activeUntil: new Date(until),
        productsIncluded: t.products,
        extraProducts: opts.extra ?? 0,
        pointsIncluded: t.bonusPoints,
        voiceIntroIncluded: false,
      },
      update: {
        activeUntil: new Date(until),
        extraProducts: opts.extra ?? 0,
      },
    });
  }
  async function giveTick(id: string, endsInDays: number | null) {
    await prisma.userProfile.update({
      where: { wawuUserId: id },
      data: {
        creatorVerifiedAt: new Date(Date.now() - 400 * DAY),
        creatorVerifiedUntil:
          endsInDays === null ? null : new Date(Date.now() + endsInDays * DAY),
      },
    });
  }
  /** The professional (green) tick alone, which counts as a tick like the creator one. */
  async function giveProfessionalTick(id: string, endsInDays: number | null) {
    await prisma.userProfile.update({
      where: { wawuUserId: id },
      data: {
        professionalVerifiedAt: new Date(Date.now() - 400 * DAY),
        professionalVerifiedUntil:
          endsInDays === null ? null : new Date(Date.now() + endsInDays * DAY),
      },
    });
  }
  /** A piece in a given state, written straight to the table (the way an admin or an old publish leaves one). */
  async function seedPiece(
    id: string,
    status: 'pending' | 'live' | 'rejected' | 'removed',
    counts = status === 'pending' || status === 'live',
  ) {
    seq += 1;
    const row = await prisma.contentPiece.create({
      data: {
        slug: `gate-${Date.now()}-${seq}`,
        creatorWawuId: id,
        contentType: 'video',
        title: `Gate seeded ${seq}`,
        description: 'Seeded',
        category: 'business_entrepreneurship',
        accessType: 'paid',
        price: 1500,
        previewAssetUrl: 'https://cdn.example.com/p.jpg',
        fullAssetUrl: 'https://cdn.example.com/f.mp4',
        status,
      },
    });
    if (counts)
      await prisma.creatorState.upsert({
        where: { wawuUserId: id },
        create: { wawuUserId: id, slotsUsed: 1 },
        update: { slotsUsed: { increment: 1 } },
      });
    return row;
  }

  beforeAll(async () => {
    for (const [k, v] of Object.entries(STORAGE_ENV)) {
      envSnapshot[k] = process.env[k];
      process.env[k] = v;
    }
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PassportModule.register({ defaultStrategy: 'wawu-jwt' }),
        PrismaModule,
        PlansModule,
        StorageModule,
        ContentPieceModule,
        CreatorStateModule,
      ],
      providers: [WawuJwtStrategy, WawuIdClient],
    }).compile();
    app = moduleRef.createNestApplication<INestApplication<App>>({
      logger: false,
    });
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
    prisma = app.get(PrismaService);
    config = app.get<PlansConfig>(PLANS_CONFIG);
  }, 60_000);

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    const where = { wawuUserId: { in: people } };
    const mine = await prisma.contentPiece.findMany({
      where: { creatorWawuId: { in: people } },
      select: { id: true },
    });
    await prisma.contentDetail.deleteMany({
      where: { contentId: { in: mine.map((m) => m.id) } },
    });
    await prisma.contentPiece.deleteMany({
      where: { creatorWawuId: { in: people } },
    });
    await prisma.productDraft.deleteMany({ where });
    await prisma.storageObject.deleteMany({ where });
    await prisma.makerTier.deleteMany({ where });
    await prisma.creatorState.deleteMany({ where });
    await prisma.personBilling.deleteMany({ where });
    await prisma.userProfile.deleteMany({ where });
    await app?.close();
    for (const [k, v] of Object.entries(envSnapshot)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  // ── 1. A new person drafts free; publishing and files need a tier ─────────

  describe('a new person', () => {
    it('can save a draft with no file, free, and is not asked for a tier', async () => {
      const id = await creator();
      const res = await post(id, '/product-drafts', {
        title: 'My first product',
      }).expect(201);
      expect(body(res).data).toMatchObject({
        title: 'My first product',
        contentType: null,
        accessType: null,
        price: null,
        missing: ['contentType', 'description', 'category', 'accessType'],
      });
      const list = body(await get(id, '/product-drafts').expect(200)).data;
      expect(list).toHaveLength(1);
      // A draft is not a product: nothing is used.
      expect((await myTier(id)).productsUsed).toBe(0);
    });

    it('is told tier_required, with the tier offers from GET /plans, when they publish', async () => {
      const id = await creator();
      const res = await publish(id).expect(402);
      const plan = await plansFor(id);
      expect(body(res)).toMatchObject({
        statusCode: 402,
        data: null,
        message: expect.any(String),
        reason: {
          code: 'tier_required',
          tierState: 'none',
          productsUsed: 0,
          productsAllowed: 0,
          currency: 'NGN',
          extraProducts: null,
        },
      });
      expect(body(res).reason.message).toBe(body(res).message);
      // The offers ARE GET /plans' tiers: same ids, same order, same prices.
      expect(tiersOf(res).map((t) => [t.id, t.priceMinor, t.products])).toEqual(
        plan.tiers.map((t) => [t.id, t.priceMinor, t.products]),
      );
      expect(tiersOf(res).map((t) => t.preselected)).toEqual(
        plan.tiers.map((t) => t.preselected),
      );
    });

    it('is told tier_required when they upload a file for a product', async () => {
      const id = await creator();
      for (const folder of ['content/preview', 'content/full']) {
        const res = await presign(id, folder).expect(402);
        expect(body(res).reason).toMatchObject({
          code: 'tier_required',
          currency: 'NGN',
        });
        expect(body(res).reason.tiers.length).toBe(config.tiers.length);
      }
      // Nothing was signed or recorded.
      expect(
        await prisma.storageObject.count({ where: { wawuUserId: id } }),
      ).toBe(0);
    });

    it('still uploads what is not a product: a picture, an identity document, a cover', async () => {
      // Without these nobody could open a wallet to buy a tier.
      const id = await creator();
      for (const [folder, type] of [
        ['avatars', 'image/png'],
        ['profile/cover', 'image/png'],
        ['kyc/id-document', 'application/pdf'],
        ['professional/document', 'application/pdf'],
        ['event/banner', 'image/png'],
      ] as const) {
        await post(id, '/uploads/presign', {
          folder,
          contentType: type,
          extension: type === 'application/pdf' ? 'pdf' : 'png',
          contentLength: 1000,
        }).expect(200);
      }
    });

    it('sees the offers in dollars, and only dollars, when billed abroad', async () => {
      const id = await creator(ABROAD, 'United Kingdom');
      const res = await publish(id).expect(402);
      const plan = await plansFor(id);
      expect(plan.currency).toBe('USD');
      expect(body(res).reason.currency).toBe('USD');
      expect(tiersOf(res).map((t) => t.priceMinor)).toEqual(
        plan.tiers.map((t) => t.priceMinor),
      );
      // One currency in the whole answer.
      expect(JSON.stringify(body(res))).not.toMatch(/NGN|kobo/);
    });

    it('can edit the details of what is waiting without a tier, but not send a file', async () => {
      // A piece an earlier publish left behind (before tiers).
      const id = await creator();
      const piece = await seedPiece(id, 'pending');
      await patch(id, `/content/${piece.id}`, {
        title: 'A better title',
      }).expect(200);
      const res = await patch(id, `/content/${piece.id}`, {
        fullAsset: 'https://cdn.example.com/new.mp4',
      }).expect(402);
      expect(body(res).reason.code).toBe('tier_required');
    });

    it('cannot send a turned-down piece again without a tier', async () => {
      const id = await creator();
      const piece = await seedPiece(id, 'rejected');
      const res = await post(id, `/content/${piece.id}/resubmit`).expect(402);
      expect(body(res).reason.code).toBe('tier_required');
    });
  });

  // ── 2. The tier's products and the extras bought ──────────────────────────

  describe('a person on the first tier', () => {
    it('publishes its products, and the next is product_limit_reached with the two ways on', async () => {
      const id = await creator();
      await giveTier(id, 0);
      const first = config.tiers[0];
      for (let n = 1; n <= first.products; n += 1)
        await publish(id).expect(201);
      expect((await myTier(id)).productsUsed).toBe(first.products);

      const res = await publish(id).expect(402);
      const plan = await plansFor(id);
      expect(body(res).reason).toMatchObject({
        code: 'product_limit_reached',
        tierState: 'active',
        productsUsed: first.products,
        productsAllowed: first.products,
        currency: 'NGN',
        // Way one: extra products, at the config price.
        extraProducts: {
          count: config.extraProducts.count,
          priceMinor: plan.extraProducts.priceMinor,
        },
      });
      // Way two: a tier that allows more.
      expect(tiersOf(res).map((t) => t.id)).toEqual(
        plan.tiers.filter((t) => t.products > first.products).map((t) => t.id),
      );
      expect(body(res).reason.tiers.length).toBeGreaterThan(0);
      // Nothing was published past the limit.
      expect(
        await prisma.contentPiece.count({ where: { creatorWawuId: id } }),
      ).toBe(first.products);
    });

    it('meets the same wall when they try to upload a file for a new product', async () => {
      const id = await creator();
      await giveTier(id, 0);
      for (let n = 1; n <= config.tiers[0].products; n += 1)
        await publish(id).expect(201);
      const res = await presign(id).expect(402);
      expect(body(res).reason.code).toBe('product_limit_reached');
      // But a document or a picture is not a product.
      await presign(id, 'avatars').expect(200);
    });

    it('publishes the extra products bought: with 5 more, the 4th to the 8th go through', async () => {
      const id = await creator();
      const first = config.tiers[0];
      const extra = config.extraProducts.count;
      await giveTier(id, 0, { extra });
      const allowed = first.products + extra;
      for (let n = 1; n <= allowed; n += 1) await publish(id).expect(201);
      const res = await publish(id).expect(402);
      expect(body(res).reason).toMatchObject({
        code: 'product_limit_reached',
        productsUsed: allowed,
        productsAllowed: allowed,
      });
      const tier = await myTier(id);
      expect(tier).toMatchObject({
        productsAllowed: allowed,
        productsUsed: allowed,
        extraProducts: extra,
      });
    });

    // One person's publishes take their storage turn one at a time: one runs,
    // STORAGE_LOCK_WAITERS_PER_PERSON wait in memory, and one more at that
    // moment is refused at once with 429 storage_busy (storage-lock.ts, ME-04
    // round 6). So the most that can be sent together and never meet that
    // refusal is the waiters plus the one running. Four sent together got a
    // 429 for the fourth on every burst once the Hub was warm (measured: 147 of
    // 150 bursts; after twelve parallel requests as a warm-up, every one). It
    // passed only while the Hub was cold, and failed on CI whenever it was
    // not (FIX-45). This sends what the queue admits, so the answer does not
    // depend on timing. The crowd past that is the next case.
    it('cannot be sent past the limit by two publishes at once', async () => {
      const id = await creator();
      await giveTier(id, 0);
      const first = config.tiers[0].products;
      for (let n = 1; n < first; n += 1) await publish(id).expect(201);
      const together = STORAGE_LOCK_WAITERS_PER_PERSON + 1;
      // Fewer than two at once would not race at all (waiters set to 0).
      expect(together).toBeGreaterThan(1);
      const results = await Promise.all(
        Array.from({ length: together }, () => publish(id)),
      );
      const codes = results.map((r) => r.status).sort();
      expect(codes).toEqual([201, ...Array<number>(together - 1).fill(402)]);
      expect((await myTier(id)).productsUsed).toBe(first);
    });

    it('a crowd of publishes at once for the last place makes one piece, and the rest are told the limit or to wait', async () => {
      const id = await creator();
      await giveTier(id, 0);
      const first = config.tiers[0].products;
      for (let n = 1; n < first; n += 1) await publish(id).expect(201);
      const crowd = 3 * (STORAGE_LOCK_WAITERS_PER_PERSON + 1);
      const results = await Promise.all(
        Array.from({ length: crowd }, () => publish(id)),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      for (const r of results.filter((x) => x.status !== 201)) {
        expect([402, 429]).toContain(r.status);
        expect(body(r).reason.code).toBe(
          r.status === 402 ? 'product_limit_reached' : 'storage_busy',
        );
      }
      expect((await myTier(id)).productsUsed).toBe(first);
    });

    it('offers no tier that is not an upgrade when they hold the top one', async () => {
      const id = await creator();
      const top = config.tiers.length - 1;
      await giveTier(id, top);
      for (let n = 1; n <= config.tiers[top].products; n += 1)
        await publish(id).expect(201);
      const res = await publish(id).expect(402);
      expect(body(res).reason.tiers).toEqual([]);
      expect(body(res).reason.extraProducts).not.toBeNull();
    });
  });

  // ── 3. Drafts do not count; unpublishing frees a place ────────────────────

  describe('the count', () => {
    it('does not count a draft, and counts it once it is published', async () => {
      const id = await creator();
      await giveTier(id, 0);
      for (let n = 0; n < 3; n += 1)
        await post(id, '/product-drafts', { title: `Draft ${n}` }).expect(201);
      expect((await myTier(id)).productsUsed).toBe(0);
      // Three drafts did not use up three places.
      for (let n = 1; n <= config.tiers[0].products; n += 1)
        await publish(id).expect(201);
      expect((await myTier(id)).productsUsed).toBe(config.tiers[0].products);
    });

    it('publishing a draft takes a place, deletes the draft, and goes once', async () => {
      const id = await creator();
      await giveTier(id, 0);
      const draft = body(
        await post(id, '/product-drafts', {
          title: 'Ready soon',
          contentType: 'video',
          description: 'Almost done',
          category: 'business_entrepreneurship',
          accessType: 'paid',
          price: 2500,
        }).expect(201),
      ).data;
      expect(draft.missing).toEqual([]);
      const files = {
        previewAsset: 'https://cdn.example.com/dp.jpg',
        fullAsset: 'https://cdn.example.com/df.mp4',
      };
      const res = await post(
        id,
        `/product-drafts/${draft.id}/publish`,
        files,
      ).expect(201);
      expect(body(res).data).toMatchObject({
        title: 'Ready soon',
        status: 'pending',
        accessType: 'paid',
        price: 2500,
      });
      expect((await myTier(id)).productsUsed).toBe(1);
      await get(id, `/product-drafts/${draft.id}`).expect(404);
      // A second tap finds nothing to publish: no second piece.
      await post(id, `/product-drafts/${draft.id}/publish`, files).expect(404);
      expect(
        await prisma.contentPiece.count({ where: { creatorWawuId: id } }),
      ).toBe(1);
    });

    it('two taps on Publish at the same moment publish the draft once', async () => {
      const id = await creator();
      await giveTier(id, 0);
      const draft = body(
        await post(id, '/product-drafts', {
          title: 'Tapped twice',
          contentType: 'video',
          description: 'd',
          category: 'business_entrepreneurship',
          accessType: 'paid',
          price: 1200,
        }).expect(201),
      ).data;
      const files = {
        previewAsset: 'https://cdn.example.com/t.jpg',
        fullAsset: 'https://cdn.example.com/t.mp4',
      };
      const taps = await Promise.all(
        [1, 2, 3].map(() =>
          post(id, `/product-drafts/${draft.id}/publish`, files),
        ),
      );
      expect(taps.filter((t) => t.status === 201)).toHaveLength(1);
      // The others find the draft gone: a refusal, never a second piece.
      for (const t of taps.filter((x) => x.status !== 201))
        expect([404, 409]).toContain(t.status);
      expect(
        await prisma.contentPiece.count({ where: { creatorWawuId: id } }),
      ).toBe(1);
      expect((await myTier(id)).productsUsed).toBe(1);
    });

    it('a draft that is published with no tier gets tier_required and stays a draft', async () => {
      const id = await creator();
      const draft = body(
        await post(id, '/product-drafts', {
          title: 'Waiting for a tier',
          contentType: 'pdf',
          description: 'd',
          category: 'business_entrepreneurship',
          accessType: 'free',
        }).expect(201),
      ).data;
      const res = await post(id, `/product-drafts/${draft.id}/publish`, {
        previewAsset: 'https://cdn.example.com/a.jpg',
        fullAsset: 'https://cdn.example.com/a.pdf',
      }).expect(402);
      expect(body(res).reason.code).toBe('tier_required');
      expect(body(res).reason.tiers.length).toBe(config.tiers.length);
      await get(id, `/product-drafts/${draft.id}`).expect(200);
      // Once they have a tier it goes, free and priced at nothing.
      await giveTier(id, 0);
      const ok = await post(id, `/product-drafts/${draft.id}/publish`, {
        previewAsset: 'https://cdn.example.com/a.jpg',
        fullAsset: 'https://cdn.example.com/a.pdf',
      }).expect(201);
      expect(body(ok).data).toMatchObject({ accessType: 'free', price: 0 });
    });

    it('a draft at the limit gets product_limit_reached and is not lost', async () => {
      const id = await creator();
      await giveTier(id, 0);
      for (let n = 1; n <= config.tiers[0].products; n += 1)
        await publish(id).expect(201);
      const draft = body(
        await post(id, '/product-drafts', {
          title: 'One too many',
          contentType: 'image',
          description: 'd',
          category: 'business_entrepreneurship',
          accessType: 'free',
        }).expect(201),
      ).data;
      const files = {
        previewAsset: 'https://cdn.example.com/b.jpg',
        fullAsset: 'https://cdn.example.com/b2.jpg',
      };
      const res = await post(
        id,
        `/product-drafts/${draft.id}/publish`,
        files,
      ).expect(402);
      expect(body(res).reason.code).toBe('product_limit_reached');
      await get(id, `/product-drafts/${draft.id}`).expect(200);
    });

    it('removing a published product frees its place for the next', async () => {
      const id = await creator();
      await giveTier(id, 0);
      const ids: string[] = [];
      for (let n = 1; n <= config.tiers[0].products; n += 1)
        ids.push(body(await publish(id).expect(201)).data.id);
      await publish(id).expect(402);
      await del(id, `/content/${ids[0]}`).expect(204);
      expect((await myTier(id)).productsUsed).toBe(
        config.tiers[0].products - 1,
      );
      await publish(id).expect(201);
      await publish(id).expect(402);
    });

    it('a piece that was turned down gives its place back, and takes one again when sent', async () => {
      const id = await creator();
      await giveTier(id, 0);
      const rejected = await seedPiece(id, 'rejected');
      for (let n = 1; n <= config.tiers[0].products; n += 1)
        await publish(id).expect(201);
      // Full: sending the turned-down piece again is a new place.
      const res = await post(id, `/content/${rejected.id}/resubmit`).expect(
        402,
      );
      expect(body(res).reason.code).toBe('product_limit_reached');
      const first = await prisma.contentPiece.findFirst({
        where: { creatorWawuId: id, status: 'pending' },
      });
      await del(id, `/content/${first!.id}`).expect(204);
      const ok = await post(id, `/content/${rejected.id}/resubmit`).expect(200);
      expect(body(ok).data.status).toBe('pending');
    });

    it('an incomplete draft says what it still needs once the tier is settled', async () => {
      const id = await creator();
      await giveTier(id, 0);
      const draft = body(
        await post(id, '/product-drafts', { title: 'Half done' }).expect(201),
      ).data;
      const res = await post(id, `/product-drafts/${draft.id}/publish`, {
        previewAsset: 'https://cdn.example.com/c.jpg',
        fullAsset: 'https://cdn.example.com/c.mp4',
      }).expect(400);
      expect(body(res).reason).toMatchObject({
        code: 'draft_incomplete',
        missing: ['contentType', 'description', 'category', 'accessType'],
      });
      expect(body(res).message).toMatch(/Finish your draft first/);
      expect(body(res).message).not.toContain('—');
    });
  });

  // ── 4. A tier that ends ───────────────────────────────────────────────────

  describe('after a tier ends', () => {
    it('keeps every published product visible to buyers, and refuses new publishing and files', async () => {
      const id = await creator();
      const buyer = await plainUser();
      const live = await seedPiece(id, 'live');
      const waiting = await seedPiece(id, 'pending');
      await giveTier(id, 0, { endsInDays: -1 });
      // Buyers still see the live piece, signed in and signed out.
      await get(buyer, `/content/${live.id}`).expect(200);
      await http().get(`/api/hub/content/public/${live.id}`).expect(200);
      // The tier is over: new publishing and files answer tier_required.
      const res = await publish(id).expect(402);
      expect(body(res).reason).toMatchObject({
        code: 'tier_required',
        tierState: 'ended',
      });
      expect(body(res).message).toMatch(/ended/i);
      await presign(id).expect(402);
      await patch(id, `/content/${waiting.id}`, {
        previewAsset: 'https://cdn.example.com/x.jpg',
      }).expect(402);
      // Nothing was unpublished.
      expect(
        await prisma.contentPiece.count({
          where: { creatorWawuId: id, status: { in: ['live', 'pending'] } },
        }),
      ).toBe(2);
      expect((await myTier(id)).state).toBe('ended');
    });

    it('lets them publish again, up to their products, once the tier is renewed', async () => {
      const id = await creator();
      await seedPiece(id, 'live');
      await giveTier(id, 0, { endsInDays: -1 });
      await publish(id).expect(402);
      await giveTier(id, 0, { endsInDays: 30 });
      for (let n = 2; n <= config.tiers[0].products; n += 1)
        await publish(id).expect(201);
      await publish(id).expect(402);
    });

    it('keeps publishing in the last days, while the tier is ending', async () => {
      const id = await creator();
      await giveTier(id, 0, { endsInDays: 2 });
      expect((await myTier(id)).state).toBe('ending');
      await publish(id).expect(201);
    });
  });

  // ── 5. People who paid for a verification tick before tiers ───────────────

  describe('a person with a paid tick', () => {
    it('keeps publishing as before while the tick lasts, and is shown the same 25', async () => {
      const id = await creator();
      await giveTick(id, 30);
      for (let n = 1; n <= 6; n += 1) await publish(id).expect(201);
      const state = body(await get(id, '/creator/state').expect(200)).data;
      expect(state).toMatchObject({ slotsUsed: 6, slotsTotal: TICK_UPLOADS });
      const allowance = body(
        await get(id, '/uploads/allowance').expect(200),
      ).data;
      expect(allowance.uploads).toMatchObject({
        used: 6,
        allowed: TICK_UPLOADS,
        remaining: TICK_UPLOADS - 6,
      });
      await presign(id).expect(200);
    });

    it('is stopped at the tick-era cap with product_limit_reached', async () => {
      const id = await creator();
      await giveTick(id, null);
      await prisma.creatorState.create({
        data: { wawuUserId: id, slotsUsed: TICK_UPLOADS },
      });
      const res = await publish(id).expect(402);
      expect(body(res).reason).toMatchObject({
        code: 'product_limit_reached',
        productsUsed: TICK_UPLOADS,
        productsAllowed: TICK_UPLOADS,
      });
      // A tier cannot add a product to 25, so none is offered.
      expect(body(res).reason.tiers).toEqual([]);
      expect(body(res).reason.extraProducts).toBeNull();
    });

    it('gets tier_required once the tick ends', async () => {
      const id = await creator();
      await giveTick(id, 30);
      await publish(id).expect(201);
      await prisma.userProfile.update({
        where: { wawuUserId: id },
        data: { creatorVerifiedUntil: new Date(Date.now() - 1000) },
      });
      const res = await publish(id).expect(402);
      expect(body(res).reason).toMatchObject({
        code: 'tier_required',
        // What they published stays, and still counts.
        productsUsed: 1,
        productsAllowed: 0,
      });
      await presign(id).expect(402);
      const state = body(await get(id, '/creator/state').expect(200)).data;
      expect(state).toMatchObject({ slotsUsed: 1, slotsTotal: 0 });
    });

    it('holding a tier and a tick allows the larger of the two', async () => {
      const id = await creator();
      await giveTier(id, 0);
      await giveTick(id, 30);
      const state = body(await get(id, '/creator/state').expect(200)).data;
      expect(state.slotsTotal).toBe(TICK_UPLOADS);
    });
  });

  // ── 6. The app's and the website's calls get the same answers ─────────────

  describe('both clients', () => {
    it('the website presign and publish bodies and the app ones get the same answer for the same person', async () => {
      const id = await creator();
      // The website sends its presign without a trailing field the app adds,
      // and its publish with an empty `specializations` and a category: both
      // reach the same two routes, so the same gate.
      const web = {
        folder: 'content/full',
        contentType: 'video/mp4',
        extension: 'mp4',
        contentLength: 5000,
      };
      const app_ = {
        ...web,
        folder: 'content/preview',
        contentType: 'image/png',
        extension: 'png',
      };
      const a = await post(id, '/uploads/presign', web);
      const b = await post(id, '/uploads/presign', app_);
      expect([a.status, b.status]).toEqual([402, 402]);
      expect(body(a).reason.code).toBe(body(b).reason.code);
      const c = await publish(id, { specializations: ['video_editing'] });
      expect(c.status).toBe(402);
      expect(body(c).reason.tiers).toEqual(body(a).reason.tiers);
      await giveTier(id, 0);
      expect((await post(id, '/uploads/presign', web)).status).toBe(200);
      expect((await post(id, '/uploads/presign', app_)).status).toBe(200);
      expect(
        (await publish(id, { specializations: ['video_editing'] })).status,
      ).toBe(201);
    });
  });

  // ── Drafts: who may, and what they hold ───────────────────────────────────

  describe('the drafts', () => {
    it('are for creator accounts, and each person sees only their own', async () => {
      const reader = await plainUser();
      await post(reader, '/product-drafts', { title: 'x' }).expect(403);
      const a = await creator();
      const b = await creator();
      const draft = body(
        await post(a, '/product-drafts', { title: 'Mine' }).expect(201),
      ).data;
      await get(b, `/product-drafts/${draft.id}`).expect(404);
      await patch(b, `/product-drafts/${draft.id}`, { title: 'Stolen' }).expect(
        404,
      );
      await del(b, `/product-drafts/${draft.id}`).expect(404);
      await post(b, `/product-drafts/${draft.id}/publish`, {
        previewAsset: 'https://cdn.example.com/a.jpg',
        fullAsset: 'https://cdn.example.com/a.mp4',
      }).expect(404);
      expect(body(await get(b, '/product-drafts').expect(200)).data).toEqual(
        [],
      );
      // And an unsigned request is turned away.
      await http().get('/api/hub/product-drafts').expect(401);
    });

    it('need a real title: a blank one is turned away, not stored', async () => {
      const id = await creator();
      await post(id, '/product-drafts', { title: '   ' }).expect(400);
      await post(id, '/product-drafts', {}).expect(400);
      const d = body(
        await post(id, '/product-drafts', { title: ' Padded ' }).expect(201),
      ).data;
      // Stored without the padding; and a blank title cannot be written later.
      expect(d.title).toBe('Padded');
      await patch(id, `/product-drafts/${d.id}`, { title: '  ' }).expect(400);
      expect(
        body(await get(id, '/product-drafts').expect(200)).data,
      ).toHaveLength(1);
    });

    it('can be filled in later, and removed', async () => {
      const id = await creator();
      const d = body(
        await post(id, '/product-drafts', { title: 'Later' }).expect(201),
      ).data;
      const filled = body(
        await patch(id, `/product-drafts/${d.id}`, {
          contentType: 'pdf',
          description: 'Now it has words',
          category: 'business_entrepreneurship',
          accessType: 'paid',
          price: 1000,
          tags: ['a', 'b'],
        }).expect(200),
      ).data;
      expect(filled).toMatchObject({
        missing: [],
        price: 1000,
        tags: ['a', 'b'],
      });
      await patch(id, `/product-drafts/${d.id}`, {}).expect(400);
      await del(id, `/product-drafts/${d.id}`).expect(204);
      await get(id, `/product-drafts/${d.id}`).expect(404);
    });

    it('stop at a limit that keeps a free account from filling the table', async () => {
      const id = await creator();
      await prisma.productDraft.createMany({
        data: Array.from({ length: PRODUCT_DRAFTS_MAX }, (_, n) => ({
          wawuUserId: id,
          title: `Filler ${n}`,
        })),
      });
      const res = await post(id, '/product-drafts', {
        title: 'One more',
      }).expect(409);
      expect(body(res).reason).toMatchObject({
        code: 'draft_limit_reached',
        draftsAllowed: PRODUCT_DRAFTS_MAX,
      });
      expect(body(res).message).not.toContain('—');
    });
  });

  // ── 8. Round 2: the places stay true under repeats and races ──────────────

  describe('removing a piece gives its place back once (round 2, D1)', () => {
    it('six DELETEs of one piece sent together free one place, and the rest answer as a repeat does', async () => {
      const id = await creator();
      await giveTier(id, 0);
      const ids: string[] = [];
      for (let n = 1; n <= config.tiers[0].products; n += 1)
        ids.push(body(await publish(id).expect(201)).data.id);
      const taps = await Promise.all(
        Array.from({ length: 6 }, () => del(id, `/content/${ids[1]}`)),
      );
      expect(taps.filter((t) => t.status === 204)).toHaveLength(1);
      expect(taps.filter((t) => t.status === 404)).toHaveLength(5);
      // One place came back, not six: the next publish takes it and the one
      // after is refused at the tier's products, never above them.
      expect((await myTier(id)).productsUsed).toBe(
        config.tiers[0].products - 1,
      );
      await publish(id).expect(201);
      await publish(id).expect(402);
      expect(
        await prisma.contentPiece.count({
          where: { creatorWawuId: id, status: { not: 'removed' } },
        }),
      ).toBe(config.tiers[0].products);
      // A repeat later is the 404 it always was.
      await del(id, `/content/${ids[1]}`).expect(404);
    });

    it('a piece turned down already gave its place back: removing it returns nothing more', async () => {
      const id = await creator();
      await giveTier(id, 0);
      await publish(id).expect(201);
      const rejected = await seedPiece(id, 'rejected');
      await del(id, `/content/${rejected.id}`).expect(204);
      expect((await myTier(id)).productsUsed).toBe(1);
      const removed = await prisma.contentPiece.findUnique({
        where: { id: rejected.id },
      });
      expect(removed?.status).toBe('removed');
    });

    it('a DELETE that read the piece before an admin turned it down returns the place once, not twice', async () => {
      const id = await creator();
      await giveTier(id, 0);
      const piece = body(await publish(id).expect(201)).data;
      await publish(id).expect(201);
      expect((await myTier(id)).productsUsed).toBe(2);

      // The admin's reject, as AdminContentReviewService writes it: a
      // conditional flip of a pending piece and the place back, in one
      // transaction.
      const adminRejects = async () => {
        await prisma.$transaction(async (tx) => {
          const flipped = await tx.contentPiece.updateMany({
            where: { id: piece.id, status: 'pending' },
            data: { status: 'rejected' },
          });
          expect(flipped.count).toBe(1);
          await tx.creatorState.updateMany({
            where: { wawuUserId: id, slotsUsed: { gt: 0 } },
            data: { slotsUsed: { decrement: 1 } },
          });
        });
      };
      // Make the interleaving happen on purpose: the delete's first read of
      // the piece answers `pending`, and the admin's decision lands right
      // after it, before the delete writes anything.
      type Delegate = Record<string, (...args: unknown[]) => Promise<unknown>>;
      const realTransaction = prisma.$transaction.bind(prisma) as unknown as (
        fn: (tx: object) => Promise<unknown>,
      ) => Promise<unknown>;
      let rejected = false;
      const afterFirstRead = (tx: object): object =>
        new Proxy(tx, {
          get(target, prop) {
            const value: unknown = Reflect.get(target, prop);
            if (prop !== 'contentPiece') return value;
            return new Proxy(value as Delegate, {
              get(delegate, method: string) {
                const call = delegate[method];
                if (method !== 'findUnique') return call;
                return async (...args: unknown[]) => {
                  const row = await call.apply(delegate, args);
                  if (!rejected) {
                    rejected = true;
                    await adminRejects();
                  }
                  return row;
                };
              },
            });
          },
        });
      jest
        .spyOn(prisma, '$transaction')
        .mockImplementationOnce((fn: (tx: object) => Promise<unknown>) =>
          realTransaction((tx) => fn(afterFirstRead(tx))),
        );

      const service = app.get(ContentPieceService, { strict: false });
      await service.delete(piece.id, id);
      expect(rejected).toBe(true);

      // The reject gave the place back; the delete found the piece turned
      // down and gave nothing more.
      expect((await myTier(id)).productsUsed).toBe(1);
      const after = await prisma.contentPiece.findUnique({
        where: { id: piece.id },
      });
      expect(after?.status).toBe('removed');
    });
  });

  describe('a first publish is never refused for having no counter yet (round 2, D2)', () => {
    it('two first publishes sent together both go, twelve times over', async () => {
      const outcomes: string[] = [];
      for (let run = 0; run < 12; run += 1) {
        const id = await creator();
        await giveTier(id, 1);
        // No CreatorState row yet: the first publish makes it.
        const sent = await Promise.all([publish(id), publish(id)]);
        outcomes.push(sent.map((r) => r.status).join('/'));
        expect((await myTier(id)).productsUsed).toBe(2);
      }
      expect(outcomes).toEqual(Array.from({ length: 12 }, () => '201/201'));
    });

    it('a turned-down piece sent again by a person with no counter row goes too', async () => {
      const id = await creator();
      await giveTier(id, 0);
      const rejected = await seedPiece(id, 'rejected');
      expect(
        await prisma.creatorState.count({ where: { wawuUserId: id } }),
      ).toBe(0);
      await post(id, `/content/${rejected.id}/resubmit`).expect(200);
      expect((await myTier(id)).productsUsed).toBe(1);
    });
  });

  describe('the draft limit holds under a crowd (round 2, D3)', () => {
    it('thirty drafts sent together leave exactly the limit', async () => {
      const id = await creator();
      const sent = await Promise.all(
        Array.from({ length: PRODUCT_DRAFTS_MAX + 10 }, (_, n) =>
          post(id, '/product-drafts', { title: `Crowd ${n}` }),
        ),
      );
      expect(sent.filter((r) => r.status === 201)).toHaveLength(
        PRODUCT_DRAFTS_MAX,
      );
      expect(sent.filter((r) => r.status === 409)).toHaveLength(10);
      expect(
        await prisma.productDraft.count({ where: { wawuUserId: id } }),
      ).toBe(PRODUCT_DRAFTS_MAX);
      // Every kept draft is listed: none is hidden past the page.
      expect(
        body(await get(id, '/product-drafts').expect(200)).data,
      ).toHaveLength(PRODUCT_DRAFTS_MAX);
    });

    it('ten drafts sent together with one place left take that place and no other', async () => {
      const id = await creator();
      await prisma.productDraft.createMany({
        data: Array.from({ length: PRODUCT_DRAFTS_MAX - 1 }, (_, n) => ({
          wawuUserId: id,
          title: `Filler ${n}`,
        })),
      });
      const sent = await Promise.all(
        Array.from({ length: 10 }, (_, n) =>
          post(id, '/product-drafts', { title: `Last ${n}` }),
        ),
      );
      expect(sent.filter((r) => r.status === 201)).toHaveLength(1);
      expect(sent.filter((r) => r.status === 409)).toHaveLength(9);
      expect(
        await prisma.productDraft.count({ where: { wawuUserId: id } }),
      ).toBe(PRODUCT_DRAFTS_MAX);
    });

    it("another person's full set of drafts does not stop this person's first", async () => {
      const full = await creator();
      await prisma.productDraft.createMany({
        data: Array.from({ length: PRODUCT_DRAFTS_MAX }, (_, n) => ({
          wawuUserId: full,
          title: `Filler ${n}`,
        })),
      });
      const other = await creator();
      await post(other, '/product-drafts', { title: 'My first' }).expect(201);
    });
  });

  describe('the limit sentence names only the ways on the answer carries (round 2, D4)', () => {
    it('a tick holder at the tick-era cap is told the limit and nothing to buy', async () => {
      const id = await creator();
      await giveTick(id, null);
      await prisma.creatorState.create({
        data: { wawuUserId: id, slotsUsed: TICK_UPLOADS },
      });
      const res = await publish(id).expect(402);
      expect(body(res).reason.tiers).toEqual([]);
      expect(body(res).reason.extraProducts).toBeNull();
      expect(body(res).message).toBe(
        `You've used all ${TICK_UPLOADS} of your product places.`,
      );
      expect(body(res).reason.message).toBe(body(res).message);
      expect(body(res).message).not.toContain('—');
      expect(body(res).message).not.toMatch(/tier/i);
    });

    it('a person who can still move up and add products is told both', async () => {
      const id = await creator();
      await giveTier(id, 0);
      for (let n = 1; n <= config.tiers[0].products; n += 1)
        await publish(id).expect(201);
      const res = await publish(id).expect(402);
      expect(body(res).message).toBe(
        `You have used ${config.tiers[0].products} of ${config.tiers[0].products} products. Add more products or move up a tier to publish another.`,
      );
    });

    it('a person on the top tier, who can only add products, is told only that', async () => {
      const id = await creator();
      const top = config.tiers.length - 1;
      await giveTier(id, top);
      for (let n = 1; n <= config.tiers[top].products; n += 1)
        await publish(id).expect(201);
      const res = await publish(id).expect(402);
      expect(body(res).reason.tiers).toEqual([]);
      expect(body(res).message).toBe(
        `You have used ${config.tiers[top].products} of ${config.tiers[top].products} products. Add more products to publish another.`,
      );
    });
  });

  // ── 8b. Round 3: a person above their allowance ──────────────────────────

  describe('a person with more published than their plan allows (round 3, D6)', () => {
    it('the tick ended with 25 up and Verify was bought: both numbers, nothing offered, "remove some"', async () => {
      const id = await creator();
      // The tick ran out yesterday; the person then bought the smallest tier.
      await giveTick(id, -1);
      await giveTier(id, 0);
      await prisma.creatorState.create({
        data: { wawuUserId: id, slotsUsed: TICK_UPLOADS },
      });
      expect(await myTier(id)).toMatchObject({
        productsUsed: TICK_UPLOADS,
        productsAllowed: config.tiers[0].products,
      });

      const res = await publish(id).expect(402);
      expect(body(res).reason).toMatchObject({
        code: 'product_limit_reached',
        productsUsed: TICK_UPLOADS,
        productsAllowed: config.tiers[0].products,
        tiers: [],
        extraProducts: null,
      });
      expect(body(res).message).toBe(
        `You have ${TICK_UPLOADS} products and your plan allows ${config.tiers[0].products}. To publish another, remove some.`,
      );
      expect(body(res).reason.message).toBe(body(res).message);
      expect(body(res).message).not.toMatch(/[—–]/);
      expect(body(res).message).not.toMatch(/tier|used 25 of/i);

      // The same sentence from the other entrances that need a free place.
      const presigned = await presign(id, 'content/full').expect(402);
      expect(body(presigned).message).toBe(body(res).message);
      expect(body(presigned).reason.tiers).toEqual([]);
    });

    it('offers only what would let another product go up, and says "add more places" while one does', async () => {
      const id = await creator();
      await giveTier(id, 0);
      // Enough published that the smallest pack still falls short, and only
      // the top tier is big enough.
      const used = config.tiers[0].products + config.extraProducts.count + 1;
      await prisma.creatorState.create({
        data: { wawuUserId: id, slotsUsed: used },
      });
      const bigEnough = config.tiers.filter((t) => t.products > used);
      expect(bigEnough.length).toBeGreaterThan(0);
      expect(bigEnough.length).toBeLessThan(config.tiers.length - 1);

      const res = await publish(id).expect(402);
      expect(tiersOf(res).map((t) => t.id)).toEqual(bigEnough.map((t) => t.id));
      expect(body(res).reason.extraProducts).toBeNull();
      expect(body(res).message).toBe(
        `You have ${used} products and your plan allows ${config.tiers[0].products}. To publish another, remove some or add more places.`,
      );

      // One product fewer than the pack lifts the tier to: the pack counts.
      await prisma.creatorState.update({
        where: { wawuUserId: id },
        data: { slotsUsed: config.tiers[0].products + 1 },
      });
      const near = await publish(id).expect(402);
      expect(body(near).reason.extraProducts).toEqual({
        count: config.extraProducts.count,
        priceMinor: expect.any(Number),
      });
      expect(tiersOf(near).map((t) => t.id)).toEqual(
        config.tiers
          .filter((t) => t.products > config.tiers[0].products + 1)
          .map((t) => t.id),
      );
    });

    it('"remove some" is true: removing enough pieces lets the next one go up', async () => {
      const id = await creator();
      await giveTier(id, 0);
      const over = config.tiers[0].products + 2;
      const pieces = [];
      for (let n = 0; n < over; n += 1)
        pieces.push(await seedPiece(id, 'live'));
      await publish(id).expect(402);
      // Down to one below the allowance: a removed piece gives its place back.
      for (let n = 0; n < over - config.tiers[0].products + 1; n += 1)
        await del(id, `/content/${pieces[n].id}`).expect(204);
      expect((await myTier(id)).productsUsed).toBe(
        config.tiers[0].products - 1,
      );
      await publish(id).expect(201);
    });
  });

  describe('tier_required offers only tiers that would let the person publish (round 4, D7)', () => {
    /** A person whose tick ended with `used` products still up and who holds no tier. */
    async function afterTick(used: number): Promise<string> {
      const id = await creator();
      await giveTick(id, -1);
      if (used > 0)
        await prisma.creatorState.create({
          data: { wawuUserId: id, slotsUsed: used },
        });
      return id;
    }
    /** The biggest tier's products (read once the config is loaded). */
    const topOf = () => Math.max(...config.tiers.map((t) => t.products));

    it('lists only the tiers that leave a place over what is up, and every one it lists lets the next publish through', async () => {
      const top = topOf();
      // 0 up, the size of each tier, and one more than the biggest tier: the
      // verifier's 9-up and 25-up cases are the middle and the end of this.
      const cases = [0, ...config.tiers.map((t) => t.products), top + 2];
      for (const used of [...new Set(cases)]) {
        const id = await afterTick(used);
        const res = await publish(id).expect(402);
        const offered = config.tiers
          .filter((t) => t.products > used)
          .map((t) => t.id);
        expect(body(res).reason.code).toBe('tier_required');
        expect(tiersOf(res).map((t) => t.id)).toEqual(offered);
        expect(body(res).reason.extraProducts).toBeNull();
        expect(body(res).reason.productsUsed).toBe(used);
        expect(body(res).reason.message).toBe(body(res).message);
        expect(body(res).message).not.toMatch(/[—–]/);
        if (offered.length === 0)
          expect(body(res).message).toBe(
            `You have ${used} ${used === 1 ? 'product' : 'products'} up and no plan has room for another. Remove some to publish.`,
          );
        else expect(body(res).message).toMatch(/need a tier/);
        // The same answer from the file entrances.
        const presigned = await presign(id, 'content/full').expect(402);
        expect(tiersOf(presigned).map((t) => t.id)).toEqual(offered);
        expect(body(presigned).message).toBe(body(res).message);

        // Buy each tier in turn: the next publish goes through exactly when
        // the tier was on offer, so nothing offered is refused again and
        // nothing left out would have worked.
        for (let i = 0; i < config.tiers.length; i += 1) {
          await prisma.makerTier.deleteMany({ where: { wawuUserId: id } });
          await giveTier(id, i);
          const next = await publish(id);
          expect([config.tiers[i].id, next.status]).toEqual([
            config.tiers[i].id,
            offered.includes(config.tiers[i].id) ? 201 : 402,
          ]);
          // Put the counter back for the next tier (a 201 took a place).
          await prisma.creatorState.upsert({
            where: { wawuUserId: id },
            create: { wawuUserId: id, slotsUsed: used },
            update: { slotsUsed: used },
          });
        }
      }
    });

    it("a person with nothing up is still offered every tier, in the plan's order", async () => {
      const id = await creator();
      const res = await publish(id).expect(402);
      expect(tiersOf(res).map((t) => t.id)).toEqual(
        config.tiers.map((t) => t.id),
      );
    });

    it('an ended tier with products up is told so, and told to remove some when no tier fits', async () => {
      const top = topOf();
      const id = await creator();
      await giveTier(id, 0, { endsInDays: -1 });
      await prisma.creatorState.create({
        data: { wawuUserId: id, slotsUsed: top + 2 },
      });
      const res = await publish(id).expect(402);
      expect(body(res).reason).toMatchObject({
        code: 'tier_required',
        tierState: 'ended',
        tiers: [],
        extraProducts: null,
      });
      expect(body(res).message).toBe(
        `Your tier has ended. You have ${top + 2} products up and no plan has room for another. Remove some to publish.`,
      );
    });

    it('"remove some" is true: removing enough pieces brings a tier back on offer', async () => {
      const top = topOf();
      const id = await creator();
      await giveTick(id, -1);
      const pieces = [];
      for (let n = 0; n < top + 2; n += 1)
        pieces.push(await seedPiece(id, 'live'));
      const before = await publish(id).expect(402);
      expect(tiersOf(before)).toEqual([]);
      // Down to one below the biggest tier: it is on offer again.
      for (let n = 0; n < 3; n += 1)
        await del(id, `/content/${pieces[n].id}`).expect(204);
      const after = await publish(id).expect(402);
      expect(tiersOf(after).map((t) => t.id)).toEqual(
        config.tiers.filter((t) => t.products > top - 1).map((t) => t.id),
      );
    });
  });

  describe('an ended tier is told to renew it only when renewing would let the person publish (round 5, D8)', () => {
    /**
     * A person whose tier `tierIndex` has ended, with `used` products still
     * up (the verifier's case: Verify ended, 5 up).
     */
    async function afterTierEnded(
      tierIndex: number,
      used: number,
    ): Promise<string> {
      const id = await creator();
      await giveTier(id, tierIndex, { endsInDays: -1 });
      if (used > 0)
        await prisma.creatorState.create({
          data: { wawuUserId: id, slotsUsed: used },
        });
      return id;
    }

    it("the verifier's case: an ended Verify with 5 up is not told to renew it, and is told what would work", async () => {
      const verify = config.tiers[0];
      const used = verify.products + 2;
      const id = await afterTierEnded(0, used);
      const res = await publish(id).expect(402);
      // Plus and Founding leave a place; Verify, renewed, would not.
      expect(tiersOf(res).map((t) => t.id)).toEqual(
        config.tiers.filter((t) => t.products > used).map((t) => t.id),
      );
      expect(tiersOf(res).map((t) => t.id)).not.toContain(verify.id);
      expect(body(res).message).toBe(
        `Your ${verify.name} plan has ended. You have ${used} products up, and a bigger plan has room for them.`,
      );
      expect(body(res).message).not.toMatch(/renew/i);
      expect(body(res).reason.message).toBe(body(res).message);
      // Doing what the old sentence said (renewing Verify) would have been
      // refused; a tier on offer lets the next publish through.
      await prisma.makerTier.deleteMany({ where: { wawuUserId: id } });
      await giveTier(id, 0, { endsInDays: 20 });
      await publish(id).expect(402);
      await prisma.makerTier.deleteMany({ where: { wawuUserId: id } });
      await giveTier(id, 1, { endsInDays: 20 });
      await publish(id).expect(201);
    });

    it('T14: a tier the config does not name that has ended is told plainly at the route: no name, "another plan", and its id is never said', async () => {
      // A row for a tier the plans file no longer names (a retired tier). It
      // cannot be renewed (the grant throws for it), so it is never told to
      // renew, and the sentence has no name to say.
      const id = await creator();
      const until = Date.now() - DAY;
      await prisma.makerTier.create({
        data: {
          wawuUserId: id,
          tierId: 'retired-tier',
          activeFrom: new Date(until - 30 * DAY),
          activeUntil: new Date(until),
          productsIncluded: config.tiers[0].products,
          extraProducts: 0,
          pointsIncluded: 0,
          voiceIntroIncluded: false,
        },
      });
      const used = config.tiers[0].products + 1;
      await prisma.creatorState.create({
        data: { wawuUserId: id, slotsUsed: used },
      });
      const res = await publish(id).expect(402);
      expect(body(res).reason).toMatchObject({
        code: 'tier_required',
        tierState: 'ended',
      });
      expect(tiersOf(res).map((t) => t.id)).toEqual(
        config.tiers.filter((t) => t.products > used).map((t) => t.id),
      );
      expect(body(res).message).toBe(
        `Your plan has ended. You have ${used} products up, and another plan has room for them.`,
      );
      expect(body(res).message).not.toContain('retired-tier');
      expect(body(res).message).not.toMatch(/renew/i);
      expect(body(res).reason.message).toBe(body(res).message);
    });

    it('"Renew it" is said exactly when the ended tier is on offer, and renewing it then lets the next publish through', async () => {
      const top = Math.max(...config.tiers.map((t) => t.products));
      const sizes = [0, ...config.tiers.map((t) => t.products), top + 2];
      for (const used of [...new Set(sizes)])
        for (let i = 0; i < config.tiers.length; i += 1) {
          const ended = config.tiers[i];
          const id = await afterTierEnded(i, used);
          const res = await publish(id).expect(402);
          const offered = config.tiers
            .filter((t) => t.products > used)
            .map((t) => t.id);
          const renewable = offered.includes(ended.id);
          const where = `${ended.id} ended, ${used} up`;
          expect([where, tiersOf(res).map((t) => t.id)]).toEqual([
            where,
            offered,
          ]);
          expect([where, /Renew it/.test(body(res).message)]).toEqual([
            where,
            renewable,
          ]);
          expect(body(res).message).not.toMatch(/[—–]/);
          expect(body(res).reason.message).toBe(body(res).message);
          // The file entrance answers in the same words.
          expect(
            body(await presign(id, 'content/full').expect(402)).message,
          ).toBe(body(res).message);
          if (offered.length > 0 && !renewable)
            expect(body(res).message).toBe(
              `Your ${ended.name} plan has ended. You have ${used} ${used === 1 ? 'product' : 'products'} up, and a bigger plan has room for ${used === 1 ? 'it' : 'them'}.`,
            );
          // Do what the sentence says: renewing the ended tier lets the next
          // publish through exactly when it said to renew it.
          await giveTier(id, i, { endsInDays: 20 });
          const renewed = await publish(id);
          expect([where, renewed.status]).toEqual([
            where,
            renewable ? 201 : 402,
          ]);
        }
    });
  });

  describe('the extras bought reach the offers over HTTP (round 4, T10)', () => {
    it('Verify with the pack bought, all its places used: the tiers that count with the extras, and the pack, are offered', async () => {
      const id = await creator();
      const extra = config.extraProducts.count;
      await giveTier(id, 0, { extra });
      const used = config.tiers[0].products + extra;
      await prisma.creatorState.create({
        data: { wawuUserId: id, slotsUsed: used },
      });
      const res = await publish(id).expect(402);
      // A tier counts with the extras carried over: its products plus the
      // extras must beat what is up. Without the extras only the biggest tier
      // would be left, so this fails if the allowance drops them.
      const expected = config.tiers
        .filter((t) => t.products + extra > used)
        .map((t) => t.id);
      expect(expected.length).toBeGreaterThan(
        config.tiers.filter((t) => t.products > used).length,
      );
      expect(tiersOf(res).map((t) => t.id)).toEqual(expected);
      expect(body(res).reason.extraProducts).not.toBeNull();
      expect(body(res).reason).toMatchObject({
        code: 'product_limit_reached',
        productsUsed: used,
        productsAllowed: used,
      });
    });
  });

  // ── 9. Round 2: the cases the verifier's mutants found untested ───────────

  describe('what the verifier found untested (round 2, T1 to T5)', () => {
    it('T1: a professional tick alone keeps publishing, and shows the same 25', async () => {
      const id = await creator();
      await giveProfessionalTick(id, 30);
      await publish(id).expect(201);
      const state = body(await get(id, '/creator/state').expect(200)).data;
      expect(state).toMatchObject({ slotsUsed: 1, slotsTotal: TICK_UPLOADS });
      // And it stops when that tick ends, like the creator one.
      await prisma.userProfile.update({
        where: { wawuUserId: id },
        data: { professionalVerifiedUntil: new Date(Date.now() - 1000) },
      });
      const res = await publish(id).expect(402);
      expect(body(res).reason.code).toBe('tier_required');
    });

    it('T2: two turned-down pieces sent again together at 2 of 3 take one place between them', async () => {
      const id = await creator();
      await giveTier(id, 0);
      await publish(id).expect(201);
      await publish(id).expect(201);
      const a = await seedPiece(id, 'rejected');
      const b = await seedPiece(id, 'rejected');
      const sent = await Promise.all([
        post(id, `/content/${a.id}/resubmit`),
        post(id, `/content/${b.id}/resubmit`),
      ]);
      expect(sent.map((r) => r.status).sort()).toEqual([200, 402]);
      const lost = sent.find((r) => r.status === 402)!;
      expect(body(lost).reason.code).toBe('product_limit_reached');
      expect((await myTier(id)).productsUsed).toBe(config.tiers[0].products);
      // The one that lost is still turned down, and not half sent.
      expect(
        await prisma.contentPiece.count({
          where: { creatorWawuId: id, status: 'rejected' },
        }),
      ).toBe(1);
    });

    it('T2: a resend and a publish together at 2 of 3 take one place between them', async () => {
      const id = await creator();
      await giveTier(id, 0);
      await publish(id).expect(201);
      await publish(id).expect(201);
      const rejected = await seedPiece(id, 'rejected');
      const sent = await Promise.all([
        post(id, `/content/${rejected.id}/resubmit`),
        publish(id),
      ]);
      expect(sent.filter((r) => r.status === 402)).toHaveLength(1);
      expect((await myTier(id)).productsUsed).toBe(config.tiers[0].products);
    });

    it('T2: six taps on Send again for one turned-down piece take one place', async () => {
      const id = await creator();
      await giveTier(id, 0);
      await publish(id).expect(201);
      await publish(id).expect(201);
      const rejected = await seedPiece(id, 'rejected');
      const sent = await Promise.all(
        Array.from({ length: 6 }, () =>
          post(id, `/content/${rejected.id}/resubmit`),
        ),
      );
      // The piece goes once. A tap that read it as turned down just before
      // the first one committed and asks for room just after it can be told
      // the limit (it is now full); no tap is told anything else.
      expect(sent.some((r) => r.status === 200)).toBe(true);
      for (const r of sent.filter((x) => x.status !== 200)) {
        expect(r.status).toBe(402);
        expect(body(r).reason.code).toBe('product_limit_reached');
      }
      expect((await myTier(id)).productsUsed).toBe(config.tiers[0].products);
      const after = await prisma.contentPiece.findUnique({
        where: { id: rejected.id },
      });
      expect(after?.status).toBe('pending');
    });

    it('T3: at the limit, a piece that is waiting can still have its file swapped', async () => {
      const id = await creator();
      await giveTier(id, 0);
      const ids: string[] = [];
      for (let n = 1; n <= config.tiers[0].products; n += 1)
        ids.push(body(await publish(id).expect(201)).data.id);
      await publish(id).expect(402);
      // The piece already has its place: an edit needs a way to publish,
      // not a free place.
      await patch(id, `/content/${ids[0]}`, {
        fullAsset: 'https://cdn.example.com/swapped.mp4',
      }).expect(200);
      expect((await myTier(id)).productsUsed).toBe(config.tiers[0].products);
    });

    it('T4: with no tier, an unfinished draft is told tier_required, not what it lacks', async () => {
      const id = await creator();
      const draft = body(
        await post(id, '/product-drafts', { title: 'Half done' }).expect(201),
      ).data;
      expect(draft.missing.length).toBeGreaterThan(0);
      const res = await post(id, `/product-drafts/${draft.id}/publish`, {
        previewAsset: 'https://cdn.example.com/h.jpg',
        fullAsset: 'https://cdn.example.com/h.mp4',
      }).expect(402);
      expect(body(res).reason.code).toBe('tier_required');
    });

    it('T5: a free draft publishes at nothing, whatever price it still carries', async () => {
      const id = await creator();
      await giveTier(id, 0);
      const draft = body(
        await post(id, '/product-drafts', {
          title: 'Changed my mind',
          contentType: 'pdf',
          description: 'Was priced, now free',
          category: 'business_entrepreneurship',
          accessType: 'paid',
          price: 900,
        }).expect(201),
      ).data;
      await patch(id, `/product-drafts/${draft.id}`, {
        accessType: 'free',
      }).expect(200);
      const stored = await prisma.productDraft.findUnique({
        where: { id: draft.id },
      });
      expect(stored?.price).toBe(900);
      const res = await post(id, `/product-drafts/${draft.id}/publish`, {
        previewAsset: 'https://cdn.example.com/free.jpg',
        fullAsset: 'https://cdn.example.com/free.pdf',
      }).expect(201);
      expect(body(res).data).toMatchObject({ accessType: 'free', price: 0 });
    });

    it('T5: a publish that loses its place because the tier ended meanwhile is told tier_required', async () => {
      const id = await creator();
      await giveTier(id, 0);
      await publish(id).expect(201);
      await publish(id).expect(201);
      // The gate looks and finds room (2 of 3, running). Then, before the
      // claim, another publish takes the last place and the tier ends.
      const gate = app.get(PublishingGate, { strict: false });
      const looked = gate.assertRoomForProduct.bind(gate);
      jest
        .spyOn(gate, 'assertRoomForProduct')
        .mockImplementationOnce(async (who: string) => {
          const allowance = await looked(who);
          await prisma.creatorState.update({
            where: { wawuUserId: id },
            data: { slotsUsed: config.tiers[0].products },
          });
          await prisma.makerTier.update({
            where: { wawuUserId: id },
            data: {
              activeFrom: new Date(Date.now() - config.tiers[0].days * DAY),
              activeUntil: new Date(Date.now() - 1000),
            },
          });
          return allowance;
        });
      const res = await publish(id).expect(402);
      expect(body(res).reason).toMatchObject({
        code: 'tier_required',
        tierState: 'ended',
      });
    });
  });
});
