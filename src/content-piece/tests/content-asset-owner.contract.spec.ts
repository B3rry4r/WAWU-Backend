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
import { ContentPieceModule } from '../content-piece.module';

/**
 * SWEEP-APP-5, two rows of ME-04 over HTTP on the real database:
 *
 * - R2-4: `POST /content` and `PATCH /content/:id` took a key of another
 *   person's confirmed file as `previewAsset` or `fullAsset`. A key of ours is
 *   a claim on a file, so only its uploader may make it (400). A link
 *   elsewhere matches no row and still passes.
 * - R4-5: an honest upload slower than the 15 minutes the Hub waits had its
 *   row abandoned and was then refused by create although the file was in the
 *   bucket. Create now settles such a row the way `POST /uploads/confirm`
 *   does; a file that is not there, or that the person released, is refused as
 *   before.
 *
 * The bucket is the one thing faked: S3Client.send answers a HEAD from the set
 * of keys this spec says are there and records deletes, so nothing leaves the
 * machine. Tokens are signed here and checked by a guard with this spec's
 * public key. Every row is this spec's own and is deleted in afterAll.
 */
const OWN = (n: number) =>
  `a5a50000-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** A creator with a running tier, who lists. */
const MAKER = OWN(1);
/** Another creator, whose files MAKER tries to name. */
const OTHER = OWN(2);
const OWNED = [MAKER, OTHER];
const NOT_YOUR_FILE = 'One of these files is not yours. Upload your own.';
const GIVEN_UP =
  'One of these files was released or never arrived. Upload it again.';

describe('A listing names only the person’s own files (SWEEP-APP-5, ME-04 R2-4 and R4-5, contract)', () => {
  let app: INestApplication;
  const server = (): App => app.getHttpServer() as App;
  let prisma: PrismaService;
  let privateKey: string;
  let publicKey: string;
  const envSnapshot: Record<string, string | undefined> = {};
  const STORAGE_ENV: Record<string, string> = {
    STORAGE_ENDPOINT: 'https://bucket.example-storage.dev',
    STORAGE_ACCESS_KEY_ID: 'contract-test-key',
    STORAGE_SECRET_ACCESS_KEY: 'contract-test-secret',
    STORAGE_BUCKET: 'contract-test-bucket',
    STORAGE_REGION: 'auto',
  };
  /** The keys the fake bucket holds: a HEAD on any other key answers 404. */
  let inBucket = new Set<string>();
  /** Every key a HEAD was asked about. */
  let asked: string[] = [];
  let bucketDown = false;

  const bearer = (sub: string) =>
    `Bearer ${jwt.sign(
      { sub, email: `${sub}@test.wawu.dev`, status: 'active' },
      privateKey,
      { algorithm: 'RS256', expiresIn: '15m' },
    )}`;

  class TestWawuAuthGuard implements CanActivate {
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

  /** Reserves one upload the way the app does, and answers its key and link. */
  async function reserve(
    owner: string,
    folder: 'content/full' | 'content/preview',
  ): Promise<{ key: string; fileUrl: string }> {
    const res = await request(server())
      .post('/uploads/presign')
      .set('Authorization', bearer(owner))
      .send({
        folder,
        format: 'pdf',
        contentType: 'application/pdf',
        extension: 'pdf',
        contentLength: 1024 * 1024,
      })
      .expect(200);
    return (res.body as { data: { key: string; fileUrl: string } }).data;
  }

  const listing = (previewAsset: string, fullAsset: string) => ({
    contentType: 'pdf',
    title: 'SWEEP-APP-5 owner spec',
    description: 'A piece that names two uploads',
    category: 'business_entrepreneurship',
    tags: [],
    accessType: 'paid',
    price: 2000,
    previewAsset,
    fullAsset,
  });
  const post = (owner: string, previewAsset: string, fullAsset: string) =>
    request(server())
      .post('/content')
      .set('Authorization', bearer(owner))
      .send(listing(previewAsset, fullAsset));
  const counts = async (owner: string) => ({
    pieces: await prisma.contentPiece.count({
      where: { creatorWawuId: owner },
    }),
    slots:
      (await prisma.creatorState.findUnique({ where: { wawuUserId: owner } }))
        ?.slotsUsed ?? 0,
  });
  const statusOf = async (key: string) =>
    (await prisma.storageObject.findUnique({ where: { key } }))?.status;
  /** Makes a reserved file the way a landed upload is: counted, confirmed. */
  const confirmed = (key: string) =>
    prisma.storageObject.update({
      where: { key },
      data: { status: 'confirmed', confirmedAt: new Date() },
    });
  /** What the 15 minute wait does to an upload that has not landed yet. */
  const givenUpByTheWait = (key: string) =>
    prisma.storageObject.update({
      where: { key },
      data: {
        status: 'abandoned',
        releasedAt: null,
        createdAt: new Date(Date.now() - 20 * 60 * 1000),
      },
    });

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
        const key = command.input.Key as string;
        asked.push(key);
        if (bucketDown) {
          return Promise.reject(
            Object.assign(new Error('bucket unreachable'), {
              $metadata: { httpStatusCode: 500 },
            }),
          );
        }
        if (inBucket.has(key)) return Promise.resolve({});
        return Promise.reject(
          Object.assign(new Error('NotFound'), {
            $metadata: { httpStatusCode: 404 },
          }),
        );
      }
      if (command instanceof DeleteObjectCommand) return Promise.resolve({});
      return Promise.reject(
        new Error('this spec only expects HEAD and delete'),
      );
    }) as never);

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        StorageModule,
        ContentPieceModule,
      ],
    })
      .overrideGuard(WawuAuthGuard)
      .useClass(TestWawuAuthGuard)
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

    await prisma.userProfile.createMany({
      data: OWNED.map((wawuUserId) => ({
        wawuUserId,
        accountType: 'creator' as const,
        creatorVerifiedAt: null,
        creatorVerifiedUntil: null,
        professionalVerifiedAt: null,
        professionalVerifiedUntil: null,
      })),
    });
    await prisma.makerTier.deleteMany({ where: { wawuUserId: { in: OWNED } } });
    await prisma.makerTier.createMany({
      data: OWNED.map((wawuUserId) => ({
        wawuUserId,
        tierId: 'swa5-suite',
        activeFrom: new Date(Date.now() - 86_400_000),
        activeUntil: new Date(Date.now() + 30 * 86_400_000),
        productsIncluded: 30,
        pointsIncluded: 0,
      })),
    });
  });

  beforeEach(() => {
    inBucket = new Set();
    asked = [];
    bucketDown = false;
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await prisma.contentPiece.deleteMany({
      where: { creatorWawuId: { in: OWNED } },
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
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  describe('ME-04 R2-4: another person’s file', () => {
    it('refuses POST /content that names a file of someone else, in either field, and takes no place', async () => {
      const ownPreview = await reserve(MAKER, 'content/preview');
      const ownFull = await reserve(MAKER, 'content/full');
      const theirPreview = await reserve(OTHER, 'content/preview');
      const theirFull = await reserve(OTHER, 'content/full');
      await confirmed(theirPreview.key);
      await confirmed(theirFull.key);
      const before = await counts(MAKER);

      for (const [pv, fl] of [
        [ownPreview.fileUrl, theirFull.fileUrl],
        [theirPreview.fileUrl, ownFull.fileUrl],
        [theirPreview.fileUrl, theirFull.fileUrl],
      ]) {
        const res = await post(MAKER, pv, fl).expect(400);
        expect(res.body).toMatchObject({
          statusCode: 400,
          message: NOT_YOUR_FILE,
        });
      }
      expect(await counts(MAKER)).toEqual(before);
      // The other person's files are untouched by the refusals.
      expect(await statusOf(theirFull.key)).toBe('confirmed');
      expect(await statusOf(theirPreview.key)).toBe('confirmed');
    });

    it('still takes the person’s own files, and a link elsewhere, as before', async () => {
      const ownPreview = await reserve(MAKER, 'content/preview');
      const ownFull = await reserve(MAKER, 'content/full');
      await post(MAKER, ownPreview.fileUrl, ownFull.fileUrl).expect(201);
      // A link that is not one of our keys matches no row and passes.
      const another = await reserve(MAKER, 'content/full');
      await post(
        MAKER,
        'https://cdn.example.com/previews/cover.jpg',
        another.fileUrl,
      ).expect(201);
    });

    it('refuses PATCH /content/:id that names a file of someone else, and leaves the piece as it was', async () => {
      const ownPreview = await reserve(MAKER, 'content/preview');
      const ownFull = await reserve(MAKER, 'content/full');
      const created = await post(MAKER, ownPreview.fileUrl, ownFull.fileUrl)
        .expect(201)
        .then((r) => (r.body as { data: { id: string } }).data);
      const theirFull = await reserve(OTHER, 'content/full');
      await confirmed(theirFull.key);

      const res = await request(server())
        .patch(`/content/${created.id}`)
        .set('Authorization', bearer(MAKER))
        .send({ fullAsset: theirFull.fileUrl })
        .expect(400);
      expect(res.body).toMatchObject({ message: NOT_YOUR_FILE });
      const piece = await prisma.contentPiece.findUnique({
        where: { id: created.id },
        select: { fullAssetUrl: true },
      });
      expect(piece?.fullAssetUrl).toBe(ownFull.fileUrl);

      // Its own file is still accepted on an edit.
      const next = await reserve(MAKER, 'content/full');
      await request(server())
        .patch(`/content/${created.id}`)
        .set('Authorization', bearer(MAKER))
        .send({ fullAsset: next.fileUrl })
        .expect(200);
    });
  });

  describe('ME-04 R4-5: an honest upload slower than the wait', () => {
    it('counts a never-released file that landed after its row was given up, and lists on it', async () => {
      const preview = await reserve(MAKER, 'content/preview');
      const full = await reserve(MAKER, 'content/full');
      await givenUpByTheWait(preview.key);
      await givenUpByTheWait(full.key);
      // Both files are in the bucket: the upload finished after the wait.
      inBucket = new Set([preview.key, full.key]);
      const before = await counts(MAKER);

      await post(MAKER, preview.fileUrl, full.fileUrl).expect(201);

      expect(asked.sort()).toEqual([full.key, preview.key].sort());
      expect(await statusOf(preview.key)).toBe('confirmed');
      expect(await statusOf(full.key)).toBe('confirmed');
      const after = await counts(MAKER);
      expect(after.pieces).toBe(before.pieces + 1);
    });

    it('still refuses a never-released file that is not in the bucket, and keeps it given up', async () => {
      const preview = await reserve(MAKER, 'content/preview');
      const full = await reserve(MAKER, 'content/full');
      await givenUpByTheWait(preview.key);
      await givenUpByTheWait(full.key);
      inBucket = new Set([preview.key]);
      const before = await counts(MAKER);

      const res = await post(MAKER, preview.fileUrl, full.fileUrl).expect(400);
      expect(res.body).toMatchObject({ message: GIVEN_UP });
      expect(await counts(MAKER)).toEqual(before);
      expect(await statusOf(full.key)).toBe('abandoned');
    });

    it('never counts a file the person released, even when it is in the bucket', async () => {
      const preview = await reserve(MAKER, 'content/preview');
      const full = await reserve(MAKER, 'content/full');
      await request(server())
        .post('/uploads/release')
        .set('Authorization', bearer(MAKER))
        .send({ key: full.key })
        .expect(200);
      inBucket = new Set([preview.key, full.key]);
      asked = [];

      const res = await post(MAKER, preview.fileUrl, full.fileUrl).expect(400);
      expect(res.body).toMatchObject({ message: GIVEN_UP });
      expect(asked).not.toContain(full.key);
      expect(await statusOf(full.key)).toBe('abandoned');
    });

    it('counts a late file named by an edit (PATCH /content/:id) before the edit is checked (SWEEP-APP-5 L1)', async () => {
      const ownPreview = await reserve(MAKER, 'content/preview');
      const ownFull = await reserve(MAKER, 'content/full');
      const created = await post(MAKER, ownPreview.fileUrl, ownFull.fileUrl)
        .expect(201)
        .then((r) => (r.body as { data: { id: string } }).data);
      // The replacement upload finished after the wait: its row was given up, the file is in the bucket.
      const next = await reserve(MAKER, 'content/full');
      await givenUpByTheWait(next.key);
      inBucket = new Set([next.key]);
      asked = [];

      await request(server())
        .patch(`/content/${created.id}`)
        .set('Authorization', bearer(MAKER))
        .send({ fullAsset: next.fileUrl })
        .expect(200);

      expect(asked).toEqual([next.key]);
      expect(await statusOf(next.key)).toBe('confirmed');
      const piece = await prisma.contentPiece.findUnique({
        where: { id: created.id },
        select: { fullAssetUrl: true },
      });
      expect(piece?.fullAssetUrl).toBe(next.fileUrl);
    });

    it('counts a late file named when a draft is published (POST /product-drafts/:id/publish) before the draft is checked (SWEEP-APP-5 L1)', async () => {
      const draft = await request(server())
        .post('/product-drafts')
        .set('Authorization', bearer(MAKER))
        .send({
          title: 'SWEEP-APP-5 draft spec',
          contentType: 'pdf',
          description: 'A draft that names two uploads when it is published',
          category: 'business_entrepreneurship',
          accessType: 'paid',
          price: 2000,
        })
        .expect(201)
        .then((r) => (r.body as { data: { id: string } }).data);
      const preview = await reserve(MAKER, 'content/preview');
      const full = await reserve(MAKER, 'content/full');
      await givenUpByTheWait(preview.key);
      await givenUpByTheWait(full.key);
      inBucket = new Set([preview.key, full.key]);
      asked = [];
      const before = await counts(MAKER);

      await request(server())
        .post(`/product-drafts/${draft.id}/publish`)
        .set('Authorization', bearer(MAKER))
        .send({ previewAsset: preview.fileUrl, fullAsset: full.fileUrl })
        .expect(201);

      expect(asked.sort()).toEqual([full.key, preview.key].sort());
      expect(await statusOf(preview.key)).toBe('confirmed');
      expect(await statusOf(full.key)).toBe('confirmed');
      expect((await counts(MAKER)).pieces).toBe(before.pieces + 1);
    });

    it('answers as it always did when the bucket cannot be asked, and a retry then works', async () => {
      const preview = await reserve(MAKER, 'content/preview');
      const full = await reserve(MAKER, 'content/full');
      await givenUpByTheWait(preview.key);
      await givenUpByTheWait(full.key);
      inBucket = new Set([preview.key, full.key]);
      bucketDown = true;

      const res = await post(MAKER, preview.fileUrl, full.fileUrl).expect(400);
      expect(res.body).toMatchObject({ message: GIVEN_UP });

      bucketDown = false;
      await post(MAKER, preview.fileUrl, full.fileUrl).expect(201);
    });
  });
});
