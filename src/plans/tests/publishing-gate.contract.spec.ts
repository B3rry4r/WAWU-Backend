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
import { PRODUCT_DRAFTS_MAX } from '../../content-piece/product-draft.service';
import { CreatorStateModule } from '../../creator-state/creator-state.module';
import { StorageModule } from '../../storage/storage.module';
import { TICK_UPLOADS } from '../../common/creator-allowance';
import { PLANS_CONFIG, type PlansConfig } from '../plans-config';
import { PlansModule } from '../plans.module';
import type { MyTierView, PlansView } from '../plans-view.type';

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
    body(await get(id, '/me/tier').expect(200)).data;
  const plansFor = async (id: string): Promise<PlansView> =>
    body(await get(id, '/plans').expect(200)).data;

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
      expect(
        body(res).reason.tiers.map((t: any) => [
          t.id,
          t.priceMinor,
          t.products,
        ]),
      ).toEqual(plan.tiers.map((t) => [t.id, t.priceMinor, t.products]));
      expect(body(res).reason.tiers.map((t: any) => t.preselected)).toEqual(
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
      expect(body(res).reason.tiers.map((t: any) => t.priceMinor)).toEqual(
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
      expect(body(res).reason.tiers.map((t: any) => t.id)).toEqual(
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

    it('cannot be sent past the limit by two publishes at once', async () => {
      const id = await creator();
      await giveTier(id, 0);
      const first = config.tiers[0].products;
      for (let n = 1; n < first; n += 1) await publish(id).expect(201);
      const results = await Promise.all([1, 2, 3, 4].map(() => publish(id)));
      const codes = results.map((r) => r.status).sort();
      expect(codes).toEqual([201, 402, 402, 402]);
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
});
