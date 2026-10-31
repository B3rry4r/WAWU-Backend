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
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthGuard } from '../../common/guards/wawu-auth.guard';
import { StorageModule } from '../../storage/storage.module';
import { StorageService } from '../../storage/storage.service';
import { ContentPieceModule } from '../content-piece.module';
import { SearchResponseModule } from '../../search-response/search-response.module';
import { OptionalWawuAuthGuard } from '../../search-response/guards/optional-wawu-auth.guard';
import { MeModule } from '../../me/me.module';
import { UnlockWalletService } from '../wallet/unlock-wallet.service';
import { eraseFiles } from '../../account-purge/purge-files';
import { FILE_KINDS } from '../../account-purge/purge-files';

/**
 * CONTENT-COVER (R-114, owner, 30 Oct 2026): a piece can carry an optional cover picture of its own, so a video, an
 * audio clip or a pdf shows a picture in the feed, search, My content, Purchases, Saved, the pay sheet and the rest.
 * Over HTTP on the real database; the bucket is the one thing faked (HEAD from a set of keys, deletes recorded).
 *
 *  - a creator adds a cover to a video; the piece page, feed, search, My content, Purchases, Saved and the quote show it
 *  - the routes the web calls keep every byte of their answer unless the request is the app's (`X-Wawu-Client: app`)
 *  - replacing a cover deletes the old file; taking it off deletes it too
 *  - a png over 5 MB and a gif are refused; another person cannot set a cover; a made-up key is refused
 *  - account deletion removes covers (the purge map), except those of pieces kept for buyers
 */
const OWN = (n: number) =>
  `c07e0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const MAKER = OWN(1);
const OTHER = OWN(2);
const BUYER = OWN(3);
const OWNED = [MAKER, OTHER, BUYER];
const APP = { 'X-Wawu-Client': 'app' };

describe('A piece carries an optional cover picture (CONTENT-COVER, R-114, contract)', () => {
  let app: INestApplication;
  const server = (): App => app.getHttpServer() as App;
  let prisma: PrismaService;
  let storage: StorageService;
  let privateKey: string;
  let publicKey: string;
  const envSnapshot: Record<string, string | undefined> = {};
  const STORAGE_ENV: Record<string, string> = {
    STORAGE_ENDPOINT: 'https://bucket.example-storage.dev',
    STORAGE_ACCESS_KEY_ID: 'cover-test-key',
    STORAGE_SECRET_ACCESS_KEY: 'cover-test-secret',
    STORAGE_BUCKET: 'cover-test-bucket',
    STORAGE_REGION: 'auto',
  };
  let inBucket = new Set<string>();
  let deleted: string[] = [];

  const bearer = (sub: string) =>
    `Bearer ${jwt.sign(
      { sub, email: `${sub}@test.wawu.dev`, status: 'active' },
      privateKey,
      { algorithm: 'RS256', expiresIn: '15m' },
    )}`;

  class TestAuthGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
      const req = context.switchToHttp().getRequest<{
        headers: Record<string, string | undefined>;
        user?: unknown;
      }>();
      const header = req.headers['authorization'];
      if (!header?.startsWith('Bearer ')) throw new UnauthorizedException();
      try {
        req.user = jwt.verify(header.slice('Bearer '.length), publicKey, {
          algorithms: ['RS256'],
        });
        return true;
      } catch {
        throw new UnauthorizedException();
      }
    }
  }

  type Folder = 'content/cover' | 'content/preview' | 'content/full';
  async function reserve(
    owner: string,
    folder: Folder,
    contentType: string,
    contentLength = 200_000,
  ) {
    const res = await request(server())
      .post('/uploads/presign')
      .set('Authorization', bearer(owner))
      .send({ folder, contentType, extension: 'x', contentLength });
    return res;
  }
  async function landed(owner: string, folder: Folder, contentType: string) {
    const res = await reserve(owner, folder, contentType).then((r) => {
      expect(r.status).toBe(200);
      return (r.body as { data: { key: string; fileUrl: string } }).data;
    });
    inBucket.add(res.key);
    await prisma.storageObject.update({
      where: { key: res.key },
      data: { status: 'confirmed', confirmedAt: new Date() },
    });
    return res;
  }
  const listing = (extra: Record<string, unknown>, fileUrls: string[]) => ({
    contentType: 'video',
    title: 'CONTENT-COVER spec clip',
    description: 'A video with its own cover picture',
    category: 'business_entrepreneurship',
    tags: [],
    accessType: 'paid',
    price: 2000,
    previewAsset: fileUrls[0],
    fullAsset: fileUrls[1],
    ...extra,
  });
  async function newVideo(extra: Record<string, unknown> = {}) {
    const prev = await landed(MAKER, 'content/preview', 'video/mp4');
    const full = await landed(MAKER, 'content/full', 'video/mp4');
    return request(server())
      .post('/content')
      .set('Authorization', bearer(MAKER))
      .set(APP)
      .send(listing(extra, [prev.fileUrl, full.fileUrl]));
  }
  /** A new video that is accepted (201). */
  async function created201(extra: Record<string, unknown> = {}) {
    const res = await newVideo(extra);
    expect(res.status).toBe(201);
    return res;
  }
  type Piece = { id: string; coverUrl?: string | null; coverKey?: string };
  const data = <T>(res: request.Response) => (res.body as { data: T }).data;
  const goLive = (id: string) =>
    prisma.contentPiece.update({ where: { id }, data: { status: 'live' } });

  beforeAll(async () => {
    for (const [key, value] of Object.entries(STORAGE_ENV)) {
      envSnapshot[key] = process.env[key];
      process.env[key] = value;
    }
    const keyPair = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    privateKey = keyPair.privateKey;
    publicKey = keyPair.publicKey;

    jest.spyOn(S3Client.prototype, 'send').mockImplementation(((
      command: unknown,
    ) => {
      if (command instanceof HeadObjectCommand) {
        if (inBucket.has(command.input.Key as string))
          return Promise.resolve({});
        return Promise.reject(
          Object.assign(new Error('NotFound'), {
            $metadata: { httpStatusCode: 404 },
          }),
        );
      }
      if (command instanceof DeleteObjectCommand) {
        deleted.push(command.input.Key as string);
        inBucket.delete(command.input.Key as string);
        return Promise.resolve({});
      }
      return Promise.reject(new Error('only HEAD and delete are expected'));
    }) as never);

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        StorageModule,
        ContentPieceModule,
        SearchResponseModule,
        MeModule,
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
          const h = req.headers['authorization'];
          if (h?.startsWith('Bearer '))
            req.user = jwt.verify(h.slice(7), publicKey, {
              algorithms: ['RS256'],
            });
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
    storage = moduleRef.get(StorageService);

    await prisma.userProfile.createMany({
      data: OWNED.map((wawuUserId) => ({
        wawuUserId,
        accountType: 'creator' as const,
        handle: `cover${wawuUserId.slice(-2)}`,
      })),
      skipDuplicates: true,
    });
    await prisma.makerTier.createMany({
      data: [MAKER, OTHER].map((wawuUserId) => ({
        wawuUserId,
        tierId: 'swa5-suite',
        activeFrom: new Date(Date.now() - 86_400_000),
        activeUntil: new Date(Date.now() + 30 * 86_400_000),
        productsIncluded: 30,
        pointsIncluded: 0,
      })),
    });
  }, 60_000);

  beforeEach(() => {
    inBucket = new Set();
    deleted = [];
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await prisma.purchase.deleteMany({ where: { buyerWawuId: BUYER } });
    await prisma.savedItem.deleteMany({ where: { userWawuId: BUYER } });
    await prisma.contentPiece.deleteMany({
      where: { creatorWawuId: { in: OWNED } },
    });
    await prisma.storageObject.deleteMany({
      where: { wawuUserId: { in: OWNED } },
    });
    await prisma.creatorState.deleteMany({
      where: { wawuUserId: { in: OWNED } },
    });
    await prisma.accountDeletion.deleteMany({
      where: { wawuUserId: { in: OWNED } },
    });
    await prisma.makerTier.deleteMany({ where: { wawuUserId: { in: OWNED } } });
    await prisma.userProfile.deleteMany({
      where: { wawuUserId: { in: OWNED } },
    });
    await app.close();
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('a creator adds a cover to a video and every view shows it', async () => {
    const cover = await landed(MAKER, 'content/cover', 'image/png');
    const created = await created201({ coverAsset: cover.key });
    const piece = data<Piece>(created);
    expect(piece.coverUrl).toContain(cover.key);
    // The key itself is never served.
    expect(JSON.stringify(created.body)).not.toContain('"coverKey"');
    await goLive(piece.id);

    // The piece page, for the owner.
    const own = await request(server())
      .get(`/content/${piece.id}`)
      .set('Authorization', bearer(MAKER))
      .set(APP)
      .expect(200);
    expect(data<Piece>(own).coverUrl).toContain(cover.key);

    // The piece page, for a buyer who has not paid and for one who has: the picture is public like the preview.
    const before = await request(server())
      .get(`/content/${piece.id}`)
      .set('Authorization', bearer(BUYER))
      .set(APP)
      .expect(200);
    expect(data<Piece>(before).coverUrl).toContain(cover.key);
    await prisma.purchase.create({
      data: {
        contentId: piece.id,
        type: 'content',
        buyerWawuId: BUYER,
        creatorWawuId: MAKER,
        amount: 2000,
        commissionRate: 0.15,
        flutterwaveTxRef: `cover-${piece.id}`,
        flutterwaveTxId: null,
        status: 'completed',
        note: null,
      },
    });
    const bought = await request(server())
      .get(`/content/${piece.id}`)
      .set('Authorization', bearer(BUYER))
      .set(APP)
      .expect(200);
    expect(data<Piece>(bought).coverUrl).toContain(cover.key);

    // The web's request (no header) is answered as before: no coverUrl, no coverKey.
    const web = await request(server())
      .get(`/content/${piece.id}`)
      .set('Authorization', bearer(BUYER))
      .expect(200);
    expect(Object.keys(data<object>(web))).not.toContain('coverUrl');
    expect(Object.keys(data<object>(web))).not.toContain('coverKey');

    // The feed.
    const feed = await request(server())
      .get('/feed')
      .set('Authorization', bearer(BUYER))
      .set(APP)
      .expect(200);
    const fed = (feed.body as { data: Piece[] }).data.find(
      (i) => i.id === piece.id,
    );
    expect(fed?.coverUrl).toContain(cover.key);

    // Search, Content tab.
    const hit = await request(server())
      .get('/search')
      .query({ q: 'CONTENT-COVER spec', tab: 'content' })
      .set('Authorization', bearer(BUYER))
      .set(APP)
      .expect(200);
    const found = data<{ content: Piece[] }>(hit).content.find(
      (i) => i.id === piece.id,
    );
    expect(found?.coverUrl).toContain(cover.key);
    const webHit = await request(server())
      .get('/search')
      .query({ q: 'CONTENT-COVER spec', tab: 'content' })
      .expect(200);
    const webFound = data<{ content: object[] }>(webHit).content[0];
    expect(Object.keys(webFound)).not.toContain('coverUrl');
    expect(Object.keys(webFound)).not.toContain('coverKey');

    // My content.
    const mine = await request(server())
      .get('/content/mine/library')
      .set('Authorization', bearer(MAKER))
      .expect(200);
    expect(
      (mine.body as { data: Piece[] }).data.find((i) => i.id === piece.id)
        ?.coverUrl,
    ).toContain(cover.key);

    // Purchases and Saved.
    const purchases = await request(server())
      .get('/me/purchases')
      .set('Authorization', bearer(BUYER))
      .expect(200);
    const row = data<{ items: { content: Piece }[] }>(purchases).items.find(
      (i) => i.content.id === piece.id,
    );
    expect(row?.content.coverUrl).toContain(cover.key);
    await request(server())
      .post(`/content/${piece.id}/save`)
      .set('Authorization', bearer(BUYER))
      .expect((r) => expect(r.status).toBeLessThan(300));
    const saved = await request(server())
      .get('/me/saved')
      .set('Authorization', bearer(BUYER))
      .expect(200);
    const savedRow = data<{ items: { content?: Piece }[] }>(saved).items.find(
      (i) => i.content?.id === piece.id,
    );
    expect(savedRow?.content?.coverUrl).toContain(cover.key);

    // The pay sheet's quote carries it (the payment service is stubbed: the cover is the Hub's own read).
    const quote = await new UnlockWalletService(
      prisma,
      {
        quote: () =>
          Promise.resolve({ title: 'x', payee: null, priceKobo: 200000 }),
      } as never,
      null as never,
      null as never,
      null as never,
      null as never,
      storage,
      null as never,
      null as never,
      null as never,
    ).quote({} as never, piece.id);
    expect(quote.coverUrl).toContain(cover.key);
  }, 60_000);

  it('a piece without a cover answers coverUrl null, and nothing else changes', async () => {
    const created = await created201();
    expect(data<Piece>(created).coverUrl).toBeNull();
    const mine = await request(server())
      .get(`/content/mine/library/${data<Piece>(created).id}`)
      .set('Authorization', bearer(MAKER))
      .expect(200);
    expect(data<Piece>(mine).coverUrl).toBeNull();
  });

  it('replacing a cover deletes the old file; taking it off deletes it too', async () => {
    const first = await landed(MAKER, 'content/cover', 'image/jpeg');
    const piece = data<Piece>(await created201({ coverAsset: first.fileUrl }));
    const second = await landed(MAKER, 'content/cover', 'image/webp');
    const replaced = await request(server())
      .patch(`/content/${piece.id}`)
      .set('Authorization', bearer(MAKER))
      .send({ coverAsset: second.key })
      .expect(200);
    expect(data<Piece>(replaced).coverUrl).toContain(second.key);
    expect(deleted).toContain(first.key);
    expect(
      (await prisma.storageObject.findUnique({ where: { key: first.key } }))
        ?.status,
    ).toBe('abandoned');

    const removed = await request(server())
      .patch(`/content/${piece.id}`)
      .set('Authorization', bearer(MAKER))
      .send({ coverAsset: null })
      .expect(200);
    expect(data<Piece>(removed).coverUrl).toBeNull();
    expect(deleted).toContain(second.key);
    const row = await prisma.contentPiece.findUnique({
      where: { id: piece.id },
    });
    expect(row?.coverKey).toBeNull();
  });

  it('four replaces at once leave exactly one cover, no orphan file, and storage counts one', async () => {
    const first = await landed(MAKER, 'content/cover', 'image/jpeg');
    const piece = data<Piece>(await created201({ coverAsset: first.fileUrl }));
    const base = (await storage.usageFor(MAKER)).usedBytes;
    const racers = [];
    for (let i = 0; i < 4; i++)
      racers.push(await landed(MAKER, 'content/cover', 'image/webp'));
    const answers = await Promise.all(
      racers.map((r) =>
        request(server())
          .patch(`/content/${piece.id}`)
          .set('Authorization', bearer(MAKER))
          .send({ coverAsset: r.key }),
      ),
    );
    answers.forEach((a) => expect([200, 429]).toContain(a.status));
    // A refused racer (429 storage_busy) never named its cover: that upload is still the person's own, unlisted.
    const named = [
      first,
      ...racers.filter((_, i) => answers[i].status === 200),
    ];
    const kept = (
      await prisma.contentPiece.findUniqueOrThrow({ where: { id: piece.id } })
    ).coverKey;
    expect(named.map((n) => n.key)).toContain(kept);
    for (const n of named.filter((c) => c.key !== kept)) {
      expect(deleted).toContain(n.key);
      expect(inBucket.has(n.key)).toBe(false);
    }
    expect(inBucket.has(kept as string)).toBe(true);
    const unlisted = racers.length + 1 - named.length;
    // The cover that was there at the start was counted in `base`; what is held now is the kept one and the unlisted.
    expect((await storage.usageFor(MAKER)).usedBytes - base).toBe(
      200_000 * unlisted,
    );
  });

  it('a rejected piece keeps its cover for the resend', async () => {
    const cover = await landed(MAKER, 'content/cover', 'image/png');
    const piece = data<Piece>(await created201({ coverAsset: cover.key }));
    await prisma.contentPiece.update({
      where: { id: piece.id },
      data: { status: 'rejected' },
    });
    const mine = await request(server())
      .get(`/content/mine/library/${piece.id}`)
      .set('Authorization', bearer(MAKER))
      .expect(200);
    expect(data<Piece>(mine).coverUrl).toContain(cover.key);
    expect(deleted).not.toContain(cover.key);
  });

  it('refuses a png over the limit, a gif, another person’s cover and a made-up key', async () => {
    const big = await reserve(MAKER, 'content/cover', 'image/png', 6_000_000);
    expect(big.status).toBe(413);
    const gif = await reserve(MAKER, 'content/cover', 'image/gif');
    expect(gif.status).toBe(400);
    const okSize = await reserve(
      MAKER,
      'content/cover',
      'image/png',
      5 * 1024 * 1024,
    );
    expect(okSize.status).toBe(200);

    const theirs = await landed(OTHER, 'content/cover', 'image/png');
    const res = await newVideo({ coverAsset: theirs.key });
    expect(res.status).toBe(400);
    const madeUp = `content/cover/${MAKER}/${crypto.randomUUID()}.png`;
    expect((await newVideo({ coverAsset: madeUp })).status).toBe(400);
    expect(
      (await newVideo({ coverAsset: 'https://evil.example/x.png' })).status,
    ).toBe(400);
    // A preview file is not a cover.
    const prev = await landed(MAKER, 'content/preview', 'video/mp4');
    expect((await newVideo({ coverAsset: prev.key })).status).toBe(400);
    // Another person cannot set it on MAKER's piece either.
    const own = data<Piece>(await created201());
    const mineCover = await landed(OTHER, 'content/cover', 'image/png');
    await request(server())
      .patch(`/content/${own.id}`)
      .set('Authorization', bearer(OTHER))
      .send({ coverAsset: mineCover.key })
      .expect(403);
  });

  it('a course’s cover shows in the “from the course” row on the app’s request, and the same page answers the web’s request as before', async () => {
    const courseCover = await landed(MAKER, 'content/cover', 'image/png');
    const course = await prisma.contentPiece.create({
      data: {
        slug: `cover-course-${crypto.randomUUID()}`,
        creatorWawuId: MAKER,
        contentType: 'course',
        title: 'CONTENT-COVER spec course',
        description: 'A course with its own cover picture',
        category: 'business_entrepreneurship',
        accessType: 'paid',
        price: 8000,
        previewAssetUrl: 'https://cdn.example.com/p.jpg',
        fullAssetUrl: 'https://cdn.example.com/f.mp4',
        coverKey: courseCover.key,
        status: 'live',
      },
    });
    const made = data<Piece>(await created201({ parentCourseId: course.id }));
    await goLive(made.id);
    type Seen = { parentCourse: { id: string; coverUrl?: string | null } };
    const app = await request(server())
      .get(`/content/${made.id}/detail`)
      .set('Authorization', bearer(MAKER))
      .set(APP)
      .expect(200);
    expect(data<Seen>(app).parentCourse.id).toBe(course.id);
    expect(data<Seen>(app).parentCourse.coverUrl).toContain(courseCover.key);
    const web = await request(server())
      .get(`/content/${made.id}/detail`)
      .set('Authorization', bearer(MAKER))
      .expect(200);
    expect(Object.keys(data<Seen>(web).parentCourse)).not.toContain('coverUrl');
  });

  it('a cover is counted in the person’s storage like any upload', async () => {
    const before = await storage.usageFor(MAKER);
    await landed(MAKER, 'content/cover', 'image/png');
    const after = await storage.usageFor(MAKER);
    expect(after.usedBytes - before.usedBytes).toBe(200_000);
  });

  it('account deletion removes covers, except those kept for buyers', async () => {
    expect(FILE_KINDS['content/cover'].decision).toBe('DELETE');
    const p = OTHER;
    const mk = async (n: string) => {
      const key = `content/cover/${p}/${n}.png`;
      await prisma.storageObject.create({
        data: {
          wawuUserId: p,
          key,
          bytes: 1000,
          contentType: 'image/png',
          folder: 'content/cover',
          status: 'confirmed',
        },
      });
      return key;
    };
    const gone = await mk(crypto.randomUUID());
    const kept = await mk(crypto.randomUUID());
    await prisma.accountDeletion.create({
      data: {
        wawuUserId: p,
        status: 'purging',
        scheduledAt: new Date(Date.now() - 31 * 86_400_000),
        purgeAfter: new Date(Date.now() - 60_000),
        identityMarkedAt: new Date(),
      },
    });
    const removed: string[] = [];
    const remover = {
      isConfigured: true,
      removeMany: (keys: readonly string[]) => {
        removed.push(...keys);
        return Promise.resolve({ gone: [...keys], left: [], stopped: false });
      },
    };
    await eraseFiles(prisma, remover as never, {
      wawuUserId: p,
      soldKeys: [kept],
      identityKeys: [],
    });
    expect(removed).toContain(gone);
    expect(removed).not.toContain(kept);
    expect(
      await prisma.storageObject.findUnique({ where: { key: gone } }),
    ).toBeNull();
    expect(
      await prisma.storageObject.findUnique({ where: { key: kept } }),
    ).not.toBeNull();
  });
});
