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
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthGuard } from '../../common/guards/wawu-auth.guard';
import { ContentPieceModule } from '../../content-piece/content-piece.module';
import { StorageModule } from '../storage.module';

/**
 * ME-17 over HTTP, on the real database: R-7's storage (1 GB free, 10 GB with
 * a tick), R-8's free pieces and, since TIER-02 (R-43), the publishing gate
 * that replaced R-7's upload counts (a running tier, or a tick that has not
 * ended; the people who hold neither can publish nothing), through
 *   GET  /uploads/allowance   (new)
 *   GET  /uploads/usage
 *   POST /uploads/presign
 *   POST /content
 *
 * Tokens are signed here and checked by a guard that verifies them with this
 * spec's public key, as creator-state.contract.spec.ts does and for the same
 * reason (jwks-rsa cannot load under ts-jest here). Every row is this spec's
 * own, under ids nothing else uses, and is deleted in afterAll.
 */
const GB = 1024 ** 3;
const OWN = (n: number) =>
  `d1700000-0000-4000-8000-${String(n).padStart(12, '0')}`;
/**
 * No tier, no tick, 5 pieces and 1.5 GB stored from before tiers: the person
 * TIER-02 leaves with everything they published and nothing to add to it.
 */
const OVER_FREE = OWN(1);
/** Creator tick until 2099, 5 pieces. */
const TICKED = OWN(2);
/** Creator account that has published nothing: no CreatorState row. */
const NEW_CREATOR = OWN(3);
/** Plain (non-creator) account. */
const PLAIN = OWN(4);
/**
 * A running tier of 10 products, more than 10 GB stored: above R-7's storage
 * limit. One row holds at most 2 GB (the column is an INTEGER), so it is six
 * files of 1.8 GB.
 */
const OVER_TIER = OWN(5);
const OVER_TIER_FILE = Math.floor(1.8 * GB);
const OVER_TIER_USED = 6 * OVER_TIER_FILE;
const OWNED = [OVER_FREE, TICKED, NEW_CREATOR, PLAIN, OVER_TIER];
const PIECE_ID = (owner: number, n: number) =>
  `d1700000-0000-4000-9000-${String(owner * 100 + n).padStart(12, '0')}`;

describe('Upload allowance (ME-17, contract)', () => {
  let app: INestApplication;
  const server = (): App => app.getHttpServer() as App;
  const dataOf = (res: { body: unknown }) =>
    (res.body as { data: unknown }).data;
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

  const piece = (accessType: 'free' | 'paid') => ({
    contentType: 'video',
    title: 'ME-17 contract piece',
    description: 'Allowance check',
    category: 'business_entrepreneurship',
    tags: [],
    accessType,
    price: accessType === 'paid' ? 2000 : 0,
    previewAsset: 'https://cdn.example.com/preview.jpg',
    fullAsset: 'https://cdn.example.com/full.mp4',
  });

  async function seedPieces(owner: string, ownerNo: number, count: number) {
    for (let n = 1; n <= count; n += 1) {
      await prisma.contentPiece.create({
        data: {
          id: PIECE_ID(ownerNo, n),
          slug: `me17-contract-${ownerNo}-${n}`,
          creatorWawuId: owner,
          contentType: 'video',
          title: `Piece ${n}`,
          description: 'Fixture',
          category: 'business_entrepreneurship',
          accessType: n % 2 ? 'paid' : 'free',
          price: n % 2 ? 1500 : 0,
          previewAssetUrl: 'https://cdn.example.com/p.jpg',
          fullAssetUrl: 'https://cdn.example.com/f.mp4',
          status: 'live',
        },
      });
    }
  }

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

    const noTick = {
      creatorVerifiedAt: null,
      creatorVerifiedUntil: null,
      professionalVerifiedAt: null,
      professionalVerifiedUntil: null,
    };
    await prisma.userProfile.createMany({
      data: [
        { wawuUserId: OVER_FREE, accountType: 'creator', ...noTick },
        {
          wawuUserId: TICKED,
          accountType: 'creator',
          ...noTick,
          creatorVerifiedAt: new Date('2026-01-01T00:00:00Z'),
          creatorVerifiedUntil: new Date('2099-01-01T00:00:00Z'),
        },
        { wawuUserId: NEW_CREATOR, accountType: 'creator', ...noTick },
        { wawuUserId: PLAIN, accountType: 'user', ...noTick },
        { wawuUserId: OVER_TIER, accountType: 'creator', ...noTick },
      ],
    });
    await prisma.makerTier.create({
      data: {
        wawuUserId: OVER_TIER,
        tierId: 'me17-suite',
        activeFrom: new Date(Date.now() - 86_400_000),
        activeUntil: new Date(Date.now() + 30 * 86_400_000),
        productsIncluded: 10,
        pointsIncluded: 0,
      },
    });
    await prisma.creatorState.createMany({
      data: [
        { wawuUserId: OVER_FREE, slotsUsed: 5 },
        { wawuUserId: TICKED, slotsUsed: 5 },
        { wawuUserId: OVER_TIER, slotsUsed: 0 },
      ],
    });
    await seedPieces(OVER_FREE, 1, 5);
    await seedPieces(TICKED, 2, 5);
    await prisma.storageObject.create({
      data: {
        wawuUserId: OVER_FREE,
        key: `content/full/${OVER_FREE}/kept.mp4`,
        bytes: 1.5 * GB,
        contentType: 'video/mp4',
        folder: 'content/full',
        status: 'confirmed',
        confirmedAt: new Date('2026-09-01T00:00:00Z'),
      },
    });
    await prisma.storageObject.createMany({
      data: [1, 2, 3, 4, 5, 6].map((n) => ({
        wawuUserId: OVER_TIER,
        key: `content/full/${OVER_TIER}/kept-${n}.mp4`,
        bytes: OVER_TIER_FILE,
        contentType: 'video/mp4',
        folder: 'content/full',
        status: 'confirmed' as const,
        confirmedAt: new Date('2026-09-01T00:00:00Z'),
      })),
    });
  });

  afterAll(async () => {
    await prisma.contentPiece.deleteMany({
      where: { creatorWawuId: { in: OWNED } },
    });
    await prisma.storageObject.deleteMany({
      where: { wawuUserId: { in: OWNED } },
    });
    await prisma.creatorState.deleteMany({
      where: { wawuUserId: { in: OWNED } },
    });
    await prisma.makerTier.deleteMany({
      where: { wawuUserId: { in: OWNED } },
    });
    await prisma.userProfile.deleteMany({
      where: { wawuUserId: { in: OWNED } },
    });
    await app.close();
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  describe('GET /uploads/allowance', () => {
    it('refuses a caller with no token, or a broken one', async () => {
      await request(server()).get('/uploads/allowance').expect(401);
      await request(server())
        .get('/uploads/allowance')
        .set('Authorization', 'Bearer not-a-token')
        .expect(401);
    });

    it('a creator with neither a tier nor a tick sees 0 uploads and 1 GB, what they used, and what a tick gives', async () => {
      const res = await request(server())
        .get('/uploads/allowance')
        .set('Authorization', bearer(OVER_FREE))
        .expect(200);
      expect(res.body).toEqual({
        statusCode: 200,
        message: 'OK',
        data: {
          tickHeld: false,
          uploads: { used: 5, allowed: 0, remaining: 0 },
          storage: {
            usedBytes: 1.5 * GB,
            limitBytes: 1 * GB,
            remainingBytes: 0,
          },
          free: { uploads: 0, storageBytes: 1 * GB },
          withTick: { uploads: 25, storageBytes: 10 * GB },
        },
      });
    });

    it('a creator on a running tier sees its products and the 10 GB', async () => {
      const res = await request(server())
        .get('/uploads/allowance')
        .set('Authorization', bearer(OVER_TIER))
        .expect(200);
      expect(dataOf(res)).toMatchObject({
        tickHeld: false,
        uploads: { used: 0, allowed: 10, remaining: 10 },
        storage: {
          usedBytes: OVER_TIER_USED,
          limitBytes: 10 * GB,
          remainingBytes: 0,
        },
      });
    });

    it('a creator with a tick sees 25 uploads and 10 GB', async () => {
      const res = await request(server())
        .get('/uploads/allowance')
        .set('Authorization', bearer(TICKED))
        .expect(200);
      expect(dataOf(res)).toMatchObject({
        tickHeld: true,
        uploads: { used: 5, allowed: 25, remaining: 20 },
        storage: { usedBytes: 0, limitBytes: 10 * GB, remainingBytes: 10 * GB },
      });
    });

    it('a plain account is answered too, with 0 uploads used', async () => {
      const res = await request(server())
        .get('/uploads/allowance')
        .set('Authorization', bearer(PLAIN))
        .expect(200);
      expect(dataOf(res)).toMatchObject({
        tickHeld: false,
        uploads: { used: 0, allowed: 0, remaining: 0 },
      });
    });
  });

  describe('POST /content', () => {
    it('a creator with neither a tier nor a tick cannot upload a 6th, free or paid, and is told to pick a tier', async () => {
      for (const kind of ['paid', 'free'] as const) {
        const res = await request(server())
          .post('/content')
          .set('Authorization', bearer(OVER_FREE))
          .send(piece(kind))
          .expect(402);
        expect(res.body).toMatchObject({
          statusCode: 402,
          message:
            'Publishing and uploading files need a tier. Pick one to carry on. Drafts stay free.',
          data: null,
          reason: {
            code: 'tier_required',
            tierState: 'none',
            productsUsed: 5,
            productsAllowed: 0,
          },
        });
      }
    });

    it('a creator with a tick can upload a 6th piece', async () => {
      await request(server())
        .post('/content')
        .set('Authorization', bearer(TICKED))
        .send(piece('paid'))
        .expect(201);
      const state = await prisma.creatorState.findUnique({
        where: { wawuUserId: TICKED },
      });
      expect(state?.slotsUsed).toBe(6);
    });

    it('a new creator on a tier can publish a free piece as their first upload, and it counts', async () => {
      await prisma.makerTier.create({
        data: {
          wawuUserId: NEW_CREATOR,
          tierId: 'me17-suite',
          activeFrom: new Date(Date.now() - 86_400_000),
          activeUntil: new Date(Date.now() + 30 * 86_400_000),
          productsIncluded: 3,
          pointsIncluded: 0,
        },
      });
      const res = await request(server())
        .post('/content')
        .set('Authorization', bearer(NEW_CREATOR))
        .send(piece('free'))
        .expect(201);
      expect(dataOf(res)).toMatchObject({ accessType: 'free', price: 0 });
      const allowance = await request(server())
        .get('/uploads/allowance')
        .set('Authorization', bearer(NEW_CREATOR))
        .expect(200);
      expect((dataOf(allowance) as { uploads: unknown }).uploads).toEqual({
        used: 1,
        allowed: 3,
        remaining: 2,
      });
    });
  });

  describe('POST /uploads/presign', () => {
    it('a creator on a tier above its 10 GB is refused a new file, with the limit in the answer', async () => {
      const res = await request(server())
        .post('/uploads/presign')
        .set('Authorization', bearer(OVER_TIER))
        .send({
          folder: 'content/full',
          contentType: 'video/mp4',
          extension: 'mp4',
          contentLength: 1000,
        })
        .expect(413);
      expect(res.body).toEqual({
        statusCode: 413,
        message:
          'This file needs 1000 bytes, but only 0 bytes of your 10GB storage is free.',
        data: null,
        reason: {
          code: 'storage_limit_reached',
          neededBytes: 1000,
          usedBytes: OVER_TIER_USED,
          limitBytes: 10 * GB,
          tickHeld: false,
          storageBytesWithTick: 10 * GB,
        },
      });
    });

    it('a creator with neither a tier nor a tick, above 1 GB of content, can still upload a KYC document and an avatar, but gets tier_required for new content', async () => {
      const presign = (folder: string, contentType: string) =>
        request(server())
          .post('/uploads/presign')
          .set('Authorization', bearer(OVER_FREE))
          .send({ folder, contentType, extension: 'x', contentLength: 1000 });
      await presign('kyc/id-document', 'application/pdf').expect(200);
      await presign('avatars', 'image/jpeg').expect(200);
      const refused = await presign('content/preview', 'image/jpeg').expect(
        402,
      );
      expect((refused.body as { reason: { code: string } }).reason.code).toBe(
        'tier_required',
      );
      // The identity document and the avatar are not content: the numbers the
      // screens read are unchanged by them.
      const usage = await request(server())
        .get('/uploads/usage')
        .set('Authorization', bearer(OVER_FREE))
        .expect(200);
      expect(dataOf(usage)).toEqual({
        usedBytes: 1.5 * GB,
        limitBytes: 1 * GB,
        remainingBytes: 0,
      });
    });

    it('a creator with a tick that has not ended can store a file past 1 GB', async () => {
      // One file is at most 512 MB (MAX_UPLOAD_BYTES), so 1 GB is two of
      // them and the third file is the one past it.
      for (const bytes of [512 * 1024 * 1024, 512 * 1024 * 1024, 1000]) {
        await request(server())
          .post('/uploads/presign')
          .set('Authorization', bearer(TICKED))
          .send({
            folder: 'content/full',
            contentType: 'video/mp4',
            extension: 'mp4',
            contentLength: bytes,
          })
          .expect(200);
      }
      const usage = await request(server())
        .get('/uploads/usage')
        .set('Authorization', bearer(TICKED))
        .expect(200);
      expect(dataOf(usage)).toEqual({
        usedBytes: 1 * GB + 1000,
        limitBytes: 10 * GB,
        remainingBytes: 9 * GB - 1000,
      });
    });
  });

  it('a creator above the new limits keeps every piece and every file', async () => {
    // Runs after the refusals above: they changed nothing.
    const pieces = await prisma.contentPiece.findMany({
      where: { creatorWawuId: OVER_FREE },
      orderBy: { id: 'asc' },
      select: { id: true, status: true },
    });
    expect(pieces).toEqual(
      [1, 2, 3, 4, 5].map((n) => ({ id: PIECE_ID(1, n), status: 'live' })),
    );
    const files = await prisma.storageObject.findMany({
      where: { wawuUserId: OVER_FREE },
      select: { bytes: true, status: true },
    });
    // The 1.5 GB content file is untouched; the only other rows are the KYC
    // document and avatar reservations made above.
    expect(files).toContainEqual({ bytes: 1.5 * GB, status: 'confirmed' });
    expect(files.filter((f) => f.bytes !== 1.5 * GB)).toEqual([
      { bytes: 1000, status: 'pending' },
      { bytes: 1000, status: 'pending' },
    ]);
    const state = await prisma.creatorState.findUnique({
      where: { wawuUserId: OVER_FREE },
    });
    expect(state?.slotsUsed).toBe(5);
    const mine = await request(server())
      .get('/content/mine')
      .set('Authorization', bearer(OVER_FREE))
      .expect(200);
    expect(dataOf(mine)).toHaveLength(5);
  });
});
