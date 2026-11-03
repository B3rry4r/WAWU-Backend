import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthGuard } from '../../common/guards/wawu-auth.guard';
import { StorageModule } from '../../storage/storage.module';
import { ContentPieceModule } from '../content-piece.module';
import { PreviewCutService } from '../preview-cut.service';
import { SearchResponseModule } from '../../search-response/search-response.module';
import { OptionalWawuAuthGuard } from '../../search-response/guards/optional-wawu-auth.guard';
import { AdminContentReviewModule } from '../../admin/content-review/admin-content-review.module';
import { AdminContentReviewService } from '../../admin/content-review/admin-content-review.service';
import { AdminRole, AdminUserStatus } from '../../../generated/prisma/enums';
import type { AdminUserView } from '../../admin/auth/admin-user-view.type';
import { releaseHeldPieces } from '../wallet-hold';

/**
 * WEB-HOLD (R-126, owner, 3 Nov 2026): "for now we want to just collect contents". A piece made by the new web upload flow
 * (`X-Wawu-Client: site`) is reviewed as usual; approved, it goes live only when its creator has an open wallet, else it waits
 * (status stays `pending`, `waitingFor: "wallet"`) and goes live when the wallet is recorded. The app's pieces and today's web's
 * are never held. Over HTTP on the real database; the bucket is the one thing faked (HEAD from a set of keys).
 */
const OWN = (n: number) =>
  `e1d00000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SITE_MAKER = OWN(1);
const SITE_MAKER_2 = OWN(2);
const APP_MAKER = OWN(3);
const OLD_MAKER = OWN(4);
const NO_TIER = OWN(5);
const READER = OWN(6);
const OWNED = [SITE_MAKER, SITE_MAKER_2, APP_MAKER, OLD_MAKER, NO_TIER, READER];
const SITE = { 'X-Wawu-Client': 'site' };
const APP = { 'X-Wawu-Client': 'app' };
const ADMIN: AdminUserView = {
  id: crypto.randomUUID(),
  email: 'web-hold@admin.test.wawu.dev',
  name: 'Web Hold',
  role: AdminRole.superadmin,
  status: AdminUserStatus.active,
  lastLoginAt: null,
  createdAt: new Date(),
};

describe('A piece from the new web flow waits for its creator wallet (WEB-HOLD, R-126, contract)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  const server = (): App => app.getHttpServer() as App;
  let prisma: PrismaService;
  let review: AdminContentReviewService;
  let publicKey: string;
  let privateKey: string;
  const inBucket = new Set<string>();
  const envSnapshot: Record<string, string | undefined> = {};
  const ENV: Record<string, string> = {
    ADMIN_JWT_SECRET: 'web-hold-access-secret-0123456789',
    ADMIN_JWT_REFRESH_SECRET: 'web-hold-refresh-secret-0123456789',
    STORAGE_ENDPOINT: 'https://bucket.example-storage.dev',
    STORAGE_ACCESS_KEY_ID: 'web-hold-key',
    STORAGE_SECRET_ACCESS_KEY: 'web-hold-secret',
    STORAGE_BUCKET: 'web-hold-bucket',
    STORAGE_REGION: 'auto',
  };

  const bearer = (sub: string) =>
    `Bearer ${jwt.sign(
      { sub, email: `${sub}@test.wawu.dev`, status: 'active' },
      privateKey,
      { algorithm: 'RS256', expiresIn: '15m' },
    )}`;
  const verify = (h: string | undefined): unknown =>
    jwt.verify((h ?? '').slice(7), publicKey, { algorithms: ['RS256'] });

  class TestAuthGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
      const req = context.switchToHttp().getRequest<{
        headers: Record<string, string | undefined>;
        user?: unknown;
      }>();
      if (!req.headers['authorization']?.startsWith('Bearer '))
        throw new UnauthorizedException();
      try {
        req.user = verify(req.headers['authorization']);
        return true;
      } catch {
        throw new UnauthorizedException();
      }
    }
  }

  const data = <T>(res: request.Response) => (res.body as { data: T }).data;
  type Piece = { id: string; status: string; waitingFor?: string | null };

  async function landed(owner: string, folder: string, contentType: string) {
    const res = await request(server())
      .post('/uploads/presign')
      .set('Authorization', bearer(owner))
      .send({ folder, contentType, extension: 'x', contentLength: 200_000 });
    expect(res.status).toBe(200);
    const file = data<{ key: string; fileUrl: string }>(res);
    inBucket.add(file.key);
    await prisma.storageObject.update({
      where: { key: file.key },
      data: { status: 'confirmed', confirmedAt: new Date() },
    });
    return file;
  }

  /** A free piece publishes with only its one file (its preview is the file itself). */
  async function publishFree(
    owner: string,
    headers: Record<string, string>,
    title: string,
  ) {
    const full = await landed(owner, 'content/full', 'video/mp4');
    return request(server())
      .post('/content')
      .set('Authorization', bearer(owner))
      .set(headers)
      .send({
        contentType: 'video',
        title,
        description: 'WEB-HOLD spec',
        category: 'business_entrepreneurship',
        tags: [],
        accessType: 'free',
        price: 0,
        fullAsset: full.fileUrl,
      });
  }

  async function publishPaid(
    owner: string,
    headers: Record<string, string>,
    price: number,
    withPreview: boolean,
  ) {
    const full = await landed(owner, 'content/full', 'video/mp4');
    const prev = withPreview
      ? await landed(owner, 'content/preview', 'video/mp4')
      : null;
    return request(server())
      .post('/content')
      .set('Authorization', bearer(owner))
      .set(headers)
      .send({
        contentType: 'video',
        title: `WEB-HOLD paid ${price}`,
        description: 'WEB-HOLD spec',
        category: 'business_entrepreneurship',
        tags: [],
        accessType: 'paid',
        price,
        fullAsset: full.fileUrl,
        ...(prev ? { previewAsset: prev.fileUrl } : {}),
      });
  }

  const status = (id: string) =>
    prisma.contentPiece.findUniqueOrThrow({ where: { id } });
  const openWallet = (wawuUserId: string) =>
    prisma.$transaction(async (tx) => {
      await tx.fintavaWallet.create({
        data: {
          wawuUserId,
          customerId: `cust-${wawuUserId}`,
          walletId: `wal-${wawuUserId}`,
          accountNumber: `99${wawuUserId.slice(-8).replace(/\D/g, '0')}`.slice(
            0,
            10,
          ),
          provider: 'nuvion',
        },
      });
      return releaseHeldPieces(tx, wawuUserId);
    });
  /** Where a stranger could see the piece: the feed, the piece page and search. */
  async function publiclyVisible(id: string, title: string) {
    const feed = await request(server())
      .get('/content?perPage=50')
      .set('Authorization', bearer(READER));
    const page = await request(server())
      .get(`/content/${id}`)
      .set('Authorization', bearer(READER));
    const search = await request(server())
      .get(`/search?q=${encodeURIComponent('WEB-HOLD')}`)
      .set('Authorization', bearer(READER));
    const inFeed = JSON.stringify(feed.body).includes(id);
    const inSearch = JSON.stringify(search.body).includes(title);
    return { inFeed, page: page.status, inSearch };
  }

  beforeAll(async () => {
    for (const [k, v] of Object.entries(ENV)) {
      envSnapshot[k] = process.env[k];
      process.env[k] = v;
    }
    const kp = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    privateKey = kp.privateKey;
    publicKey = kp.publicKey;
    jest.spyOn(S3Client.prototype, 'send').mockImplementation(((
      command: unknown,
    ) => {
      if (
        command instanceof HeadObjectCommand &&
        inBucket.has(command.input.Key as string)
      )
        return Promise.resolve({});
      return Promise.reject(
        Object.assign(new Error('NotFound'), {
          $metadata: { httpStatusCode: 404 },
        }),
      );
    }) as never);

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
        StorageModule,
        ContentPieceModule,
        SearchResponseModule,
        AdminContentReviewModule,
      ],
    })
      .overrideGuard(WawuAuthGuard)
      .useClass(TestAuthGuard)
      .overrideGuard(OptionalWawuAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          const req = ctx.switchToHttp().getRequest<{
            headers: Record<string, string | undefined>;
            user?: unknown;
          }>();
          if (req.headers['authorization']?.startsWith('Bearer '))
            req.user = verify(req.headers['authorization']);
          return true;
        },
      })
      .compile();
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
    review = moduleRef.get(AdminContentReviewService);

    await prisma.userProfile.createMany({
      data: OWNED.map((wawuUserId) => ({
        wawuUserId,
        accountType: 'creator' as const,
        handle: `whold${wawuUserId.slice(-2)}`,
      })),
      skipDuplicates: true,
    });
    await prisma.makerTier.createMany({
      data: OWNED.filter((u) => u !== NO_TIER && u !== READER).map(
        (wawuUserId) => ({
          wawuUserId,
          tierId: 'swa5-suite',
          activeFrom: new Date(Date.now() - 86_400_000),
          activeUntil: new Date(Date.now() + 30 * 86_400_000),
          productsIncluded: 30,
          pointsIncluded: 0,
        }),
      ),
    });
  }, 60_000);

  afterAll(async () => {
    jest.restoreAllMocks();
    const pieces = await prisma.contentPiece.findMany({
      where: { creatorWawuId: { in: OWNED } },
      select: { id: true },
    });
    await prisma.adminContentReview.deleteMany({
      where: { contentId: { in: pieces.map((p) => p.id) } },
    });
    await prisma.contentPiece.deleteMany({
      where: { creatorWawuId: { in: OWNED } },
    });
    await prisma.fintavaWallet.deleteMany({
      where: { wawuUserId: { in: OWNED } },
    });
    await prisma.storageObject.deleteMany({
      where: { wawuUserId: { in: OWNED } },
    });
    await prisma.creatorState.deleteMany({
      where: { wawuUserId: { in: OWNED } },
    });
    await prisma.makerTier.deleteMany({ where: { wawuUserId: { in: OWNED } } });
    await prisma.userProfile.deleteMany({
      where: { wawuUserId: { in: OWNED } },
    });
    await app.close();
    for (const [k, v] of Object.entries(envSnapshot)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('approved with no wallet: held, in no public read, visible to its owner with waitingFor; then the wallet opens and every held piece goes live once', async () => {
    const a = data<Piece>(
      await publishFree(SITE_MAKER, SITE, 'WEB-HOLD one').then((r) => {
        expect(r.status).toBe(201);
        return r;
      }),
    );
    const b = data<Piece>(
      await publishFree(SITE_MAKER, SITE, 'WEB-HOLD two').then((r) => {
        expect(r.status).toBe(201);
        return r;
      }),
    );
    expect((await status(a.id)).uploadedVia).toBe('site');

    // A reviewer approves the first: no wallet, so it is held, not live.
    const decided = await review.approve(a.id, ADMIN);
    expect(decided.content.status).toBe('pending');
    expect(decided.review.newStatus).toBe('pending');
    const row = await status(a.id);
    expect(row.status).toBe('pending');
    expect(row.heldForWalletAt).not.toBeNull();
    // Approving it again changes nothing and says why.
    await expect(review.approve(a.id, ADMIN)).rejects.toThrow(
      /waiting for its creator to open their wallet/,
    );

    // Not in the queue; in the held list.
    const queue = await review.queue({
      page: 1,
      perPage: 100,
      sort: 'oldest',
    } as never);
    expect(queue.items.map((i) => i.id)).not.toContain(a.id);
    expect(queue.items.map((i) => i.id)).toContain(b.id);
    const held = await review.queue({
      page: 1,
      perPage: 100,
      sort: 'oldest',
      held: 'only',
    } as never);
    expect(held.items.map((i) => i.id)).toEqual([a.id]);

    // Public reads: nothing.
    expect(await publiclyVisible(a.id, 'WEB-HOLD one')).toEqual({
      inFeed: false,
      page: 404,
      inSearch: false,
    });

    // The owner sees it with waitingFor on both reads; the unreviewed one has none.
    const lib = data<Piece[]>(
      await request(server())
        .get('/content/mine/library')
        .set('Authorization', bearer(SITE_MAKER))
        .expect(200),
    );
    expect(lib.find((p) => p.id === a.id)).toMatchObject({
      status: 'pending',
      waitingFor: 'wallet',
    });
    expect(lib.find((p) => p.id === b.id)).toMatchObject({
      status: 'pending',
      waitingFor: null,
    });
    const mine = data<Piece[]>(
      await request(server())
        .get('/content/mine')
        .set('Authorization', bearer(SITE_MAKER))
        .expect(200),
    );
    expect(mine.find((p) => p.id === a.id)?.waitingFor).toBe('wallet');
    expect('waitingFor' in (mine.find((p) => p.id === b.id) as Piece)).toBe(
      false,
    );

    // The second is approved too (held), then the wallet opens: both live at once.
    await review.approve(b.id, ADMIN);
    expect(await openWallet(SITE_MAKER)).toBe(2);
    expect((await status(a.id)).status).toBe('live');
    expect((await status(b.id)).status).toBe('live');
    expect((await status(a.id)).heldForWalletAt).toBeNull();
    // Idempotent: a repeated event and two at the same moment release nothing more.
    await prisma.$transaction((tx) =>
      expect(releaseHeldPieces(tx, SITE_MAKER)).resolves.toBe(0),
    );
    const again = await Promise.all([
      prisma.$transaction((tx) => releaseHeldPieces(tx, SITE_MAKER)),
      prisma.$transaction((tx) => releaseHeldPieces(tx, SITE_MAKER)),
    ]);
    expect(again).toEqual([0, 0]);
    expect((await publiclyVisible(a.id, 'WEB-HOLD one')).page).toBe(200);
    const after = data<Piece[]>(
      await request(server())
        .get('/content/mine/library')
        .set('Authorization', bearer(SITE_MAKER)),
    );
    expect(after.find((p) => p.id === a.id)).toMatchObject({
      status: 'live',
      waitingFor: null,
    });
  });

  it('approval and the wallet opening at the same moment never leave a piece held', async () => {
    const p = data<Piece>(
      await publishFree(SITE_MAKER_2, SITE, 'WEB-HOLD race').then((r) => {
        expect(r.status).toBe(201);
        return r;
      }),
    );
    await Promise.all([
      review.approve(p.id, ADMIN),
      new Promise((res) => setTimeout(res, 5)).then(() =>
        openWallet(SITE_MAKER_2),
      ),
    ]);
    expect((await status(p.id)).status).toBe('live');
    expect((await status(p.id)).heldForWalletAt).toBeNull();
  });

  it('a rejection or an edit of a held piece behaves as for any piece', async () => {
    const who = OLD_MAKER;
    const p = data<Piece>(
      await publishFree(who, SITE, 'WEB-HOLD edit').then((r) => {
        expect(r.status).toBe(201);
        return r;
      }),
    );
    await review.approve(p.id, ADMIN);
    expect((await status(p.id)).heldForWalletAt).not.toBeNull();
    await request(server())
      .patch(`/content/${p.id}`)
      .set('Authorization', bearer(who))
      .send({ title: 'WEB-HOLD edited' })
      .expect(200);
    expect((await status(p.id)).heldForWalletAt).toBeNull();
    // Back in the queue; approve (held again), then reject: the hold clears.
    await review.approve(p.id, ADMIN);
    const rejected = await review.reject(
      p.id,
      { reason: 'Not suitable' },
      ADMIN,
    );
    expect(rejected.content.status).toBe('rejected');
    expect((await status(p.id)).heldForWalletAt).toBeNull();
    // Opening the wallet later does not revive it.
    await openWallet(who);
    expect((await status(p.id)).status).toBe('rejected');
  });

  it('app and no-marker pieces approved with no wallet go live as today', async () => {
    const viaApp = data<Piece>(
      await publishFree(APP_MAKER, APP, 'WEB-HOLD app').then((r) => {
        expect(r.status).toBe(201);
        return r;
      }),
    );
    const viaOldWeb = data<Piece>(
      await publishFree(APP_MAKER, {}, 'WEB-HOLD old web').then((r) => {
        expect(r.status).toBe(201);
        return r;
      }),
    );
    expect((await status(viaApp.id)).uploadedVia).toBeNull();
    expect((await status(viaOldWeb.id)).uploadedVia).toBeNull();
    for (const p of [viaApp, viaOldWeb]) {
      const out = await review.approve(p.id, ADMIN);
      expect(out.content.status).toBe('live');
      expect((await status(p.id)).heldForWalletAt).toBeNull();
    }
    expect((await publiclyVisible(viaApp.id, 'WEB-HOLD app')).page).toBe(200);
  });

  it('the price list binds the new marker and the app, not a request with no marker', async () => {
    const offList = 1234;
    const refused = await publishPaid(APP_MAKER, SITE, offList, true);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(refused.body)).toMatch(/price/i);
    const appRefused = await publishPaid(APP_MAKER, APP, offList, true);
    expect(appRefused.status).toBe(refused.status);
    expect(JSON.stringify(appRefused.body)).toBe(JSON.stringify(refused.body));
    const oldWeb = await publishPaid(APP_MAKER, {}, offList, true);
    expect(oldWeb.status).toBe(201);
    const onList = await publishPaid(APP_MAKER, SITE, 2000, true);
    expect(onList.status).toBe(201);
  });

  it('the marker needs no preview upload: the Hub is asked to cut it; without the marker a paid piece still needs one', async () => {
    const previews = moduleRef.get(PreviewCutService, { strict: false });
    const prev = await landed(SITE_MAKER, 'content/preview', 'video/mp4');
    const spy = jest
      .spyOn(previews, 'resolve')
      .mockResolvedValueOnce({ previewAsset: prev.fileUrl, made: null });
    const made = await publishPaid(SITE_MAKER, SITE, 2000, false);
    expect(made.status).toBe(201);
    expect(spy.mock.calls[0][1]).toMatchObject({ previewFromFile: true });
    spy.mockRestore();
    const plain = await publishPaid(SITE_MAKER, {}, 2000, false);
    expect(plain.status).toBe(400);
    expect(JSON.stringify(plain.body)).toMatch(/preview/i);
  });

  it('a person with no tier gets the same refusal from the marker as without it', async () => {
    const presign = (headers: Record<string, string>) =>
      request(server())
        .post('/uploads/presign')
        .set('Authorization', bearer(NO_TIER))
        .set(headers)
        .send({
          folder: 'content/full',
          contentType: 'video/mp4',
          extension: 'x',
          contentLength: 200_000,
        });
    const withMarker = await presign(SITE);
    const without = await presign({});
    expect(withMarker.status).toBe(402);
    expect(JSON.stringify(withMarker.body)).toContain('tier_required');
    expect(without.status).toBe(402);
    expect(JSON.stringify(withMarker.body)).toBe(JSON.stringify(without.body));
  });

  it('places follow the person tier: at the limit the marker is refused like the app', async () => {
    const full = await landed(OLD_MAKER, 'content/full', 'video/mp4');
    const full2 = await landed(OLD_MAKER, 'content/full', 'video/mp4');
    await prisma.creatorState.upsert({
      where: { wawuUserId: OLD_MAKER },
      create: { wawuUserId: OLD_MAKER, slotsUsed: 99 },
      update: { slotsUsed: 99 },
    });
    const send = (headers: Record<string, string>, fullAsset: string) =>
      request(server())
        .post('/content')
        .set('Authorization', bearer(OLD_MAKER))
        .set(headers)
        .send({
          contentType: 'video',
          title: 'WEB-HOLD full',
          description: 'WEB-HOLD spec',
          category: 'business_entrepreneurship',
          tags: [],
          accessType: 'free',
          price: 0,
          fullAsset,
        });
    const viaSite = await send(SITE, full.fileUrl);
    const viaApp = await send(APP, full2.fileUrl);
    expect(viaSite.status).toBe(402);
    expect(JSON.stringify(viaSite.body)).toContain('product_limit_reached');
    expect(viaApp.status).toBe(402);
    expect(viaSite.status).toBe(viaApp.status);
  });
});
