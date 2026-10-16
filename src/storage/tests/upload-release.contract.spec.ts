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
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
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
 * ME-04 round 2 over HTTP, on the real database: a file taken out of an
 * unfinished draft gives its space back (POST /uploads/release).
 *
 * The verifier's repro: one 5 MB full file kept, then three 2 MB previews each
 * picked and removed. Before this route the allowance still counted 11 MB.
 *
 * The bucket is the one thing faked: S3Client.send is replaced so a delete is
 * recorded (or made to fail) and nothing leaves the machine. Tokens are signed
 * here and checked by a guard that uses this spec's public key, as
 * upload-allowance.contract.spec.ts does. Every row is this spec's own and is
 * deleted in afterAll.
 */
const MB = 1024 * 1024;
const OWN = (n: number) =>
  `e0400000-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** A creator with no tick, who uploads and releases. */
const MAKER = OWN(1);
/** Another account, who tries to release MAKER's files. */
const OTHER = OWN(2);
const OWNED = [MAKER, OTHER];

describe('Releasing an upload (ME-04 round 2, contract)', () => {
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
  /** The keys the bucket was asked to delete, in order. */
  let deleted: string[] = [];
  /** Set to make the next delete fail the way an unreachable bucket does. */
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
    bytes: number,
  ): Promise<{ key: string; fileUrl: string }> {
    const res = await request(server())
      .post('/uploads/presign')
      .set('Authorization', bearer(owner))
      .send({
        folder,
        format: 'pdf',
        contentType: 'application/pdf',
        extension: 'pdf',
        contentLength: bytes,
      })
      .expect(200);
    return (res.body as { data: { key: string; fileUrl: string } }).data;
  }

  const release = (owner: string, key: unknown) =>
    request(server())
      .post('/uploads/release')
      .set('Authorization', bearer(owner))
      .send({ key });

  async function usedBytes(owner: string): Promise<number> {
    const res = await request(server())
      .get('/uploads/allowance')
      .set('Authorization', bearer(owner))
      .expect(200);
    return (res.body as { data: { storage: { usedBytes: number } } }).data
      .storage.usedBytes;
  }

  const statusOf = async (key: string) =>
    (await prisma.storageObject.findUnique({ where: { key } }))?.status;

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
      if (command instanceof DeleteObjectCommand) {
        if (bucketDown) {
          return Promise.reject(
            Object.assign(new Error('bucket unreachable'), {
              $metadata: { httpStatusCode: 500 },
            }),
          );
        }
        deleted.push(command.input.Key as string);
        return Promise.resolve({});
      }
      return Promise.reject(new Error('this spec only expects deletes'));
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
      data: [MAKER, OTHER].map((wawuUserId) => ({
        wawuUserId,
        accountType: 'creator' as const,
        creatorVerifiedAt: null,
        creatorVerifiedUntil: null,
        professionalVerifiedAt: null,
        professionalVerifiedUntil: null,
      })),
    });
  });

  beforeEach(() => {
    deleted = [];
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
    await prisma.userProfile.deleteMany({
      where: { wawuUserId: { in: OWNED } },
    });
    await app.close();
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('refuses a caller with no token, a broken one, or no key', async () => {
    await request(server())
      .post('/uploads/release')
      .send({ key: 'x' })
      .expect(401);
    await request(server())
      .post('/uploads/release')
      .set('Authorization', 'Bearer not-a-token')
      .send({ key: 'x' })
      .expect(401);
    await release(MAKER, undefined).expect(400);
    await release(MAKER, 12).expect(400);
    await release(MAKER, '').expect(400);
  });

  it('the verifier repro: three previews picked and removed leave only the kept full file counted', async () => {
    const kept = await reserve(MAKER, 'content/full', 5 * MB);
    expect(await usedBytes(MAKER)).toBe(5 * MB);

    const picks = [];
    for (let i = 0; i < 3; i += 1) {
      picks.push(await reserve(MAKER, 'content/preview', 2 * MB));
    }
    expect(await usedBytes(MAKER)).toBe(11 * MB);

    for (const pick of picks) {
      const res = await release(MAKER, pick.key).expect(200);
      expect(res.body).toEqual({
        statusCode: 200,
        message: 'OK',
        data: { released: true },
      });
    }

    expect(await usedBytes(MAKER)).toBe(5 * MB);
    expect(deleted).toEqual(picks.map((p) => p.key));
    expect(await statusOf(kept.key)).toBe('pending');
    for (const pick of picks)
      expect(await statusOf(pick.key)).toBe('abandoned');
  });

  it('answers the same 200 when the same key is released again, and does not count it back', async () => {
    const before = await usedBytes(MAKER);
    const pick = await reserve(MAKER, 'content/preview', 3 * MB);
    expect(await usedBytes(MAKER)).toBe(before + 3 * MB);

    const first = await release(MAKER, pick.key).expect(200);
    const second = await release(MAKER, pick.key).expect(200);
    expect(second.body).toEqual(first.body);
    expect(await usedBytes(MAKER)).toBe(before);
    expect(await statusOf(pick.key)).toBe('abandoned');
  });

  it('refuses another person’s key exactly as it refuses a key that never existed', async () => {
    const mine = await reserve(MAKER, 'content/preview', 1 * MB);
    const before = await usedBytes(MAKER);
    deleted = [];

    const theirs = await release(OTHER, mine.key).expect(404);
    const unknown = await release(
      OTHER,
      `content/preview/${OTHER}/00000000-0000-4000-8000-000000000000.pdf`,
    ).expect(404);
    expect(theirs.body).toEqual(unknown.body);
    expect(theirs.body).toEqual({
      statusCode: 404,
      message: 'That upload was not found.',
      data: null,
    });

    expect(deleted).toEqual([]);
    expect(await statusOf(mine.key)).toBe('pending');
    expect(await usedBytes(MAKER)).toBe(before);
  });

  it('does not release a file from a folder that is not creator content', async () => {
    const key = `avatars/${MAKER}/00000000-0000-4000-8000-0000000000aa.png`;
    await prisma.storageObject.create({
      data: {
        wawuUserId: MAKER,
        key,
        bytes: 1000,
        contentType: 'image/png',
        folder: 'avatars',
        status: 'confirmed',
        confirmedAt: new Date(),
      },
    });
    await release(MAKER, key).expect(404);
    expect(deleted).toEqual([]);
    expect(await statusOf(key)).toBe('confirmed');
  });

  it('refuses a file a listing already uses, and leaves it stored and counted', async () => {
    const full = await reserve(MAKER, 'content/full', 4 * MB);
    const preview = await reserve(MAKER, 'content/preview', 1 * MB);
    const before = await usedBytes(MAKER);
    await request(server())
      .post('/content')
      .set('Authorization', bearer(MAKER))
      .send({
        contentType: 'pdf',
        title: 'ME-04 release spec',
        description: 'A piece that claims two uploads',
        category: 'business_entrepreneurship',
        tags: [],
        accessType: 'paid',
        price: 2000,
        previewAsset: preview.fileUrl,
        fullAsset: full.fileUrl,
      })
      .expect(201);
    deleted = [];

    for (const claimed of [full.key, preview.key]) {
      const res = await release(MAKER, claimed).expect(409);
      expect(res.body).toEqual({
        statusCode: 409,
        message: 'That file is already part of a listing.',
        data: null,
        reason: { code: 'upload_claimed' },
      });
    }
    expect(deleted).toEqual([]);
    expect(await statusOf(full.key)).toBe('pending');
    expect(await statusOf(preview.key)).toBe('pending');
    expect(await usedBytes(MAKER)).toBe(before);
  });

  it('refuses a photo-set frame a listing already uses', async () => {
    const frame = await reserve(MAKER, 'content/full', 1 * MB);
    const piece = await prisma.contentPiece.create({
      data: {
        slug: 'me04-release-frame',
        creatorWawuId: MAKER,
        contentType: 'image',
        title: 'Frames',
        description: 'Fixture',
        category: 'business_entrepreneurship',
        accessType: 'free',
        price: 0,
        previewAssetUrl: 'https://cdn.example.com/p.jpg',
        status: 'pending',
        frames: { create: [{ position: 0, url: frame.fileUrl }] },
      },
    });
    await release(MAKER, frame.key).expect(409);
    await prisma.contentPiece.delete({ where: { id: piece.id } });
    expect(deleted).toEqual([]);
  });

  it('keeps the space counted, and answers 503, when the bucket cannot be reached; a retry then works', async () => {
    const before = await usedBytes(MAKER);
    const pick = await reserve(MAKER, 'content/preview', 2 * MB);

    bucketDown = true;
    const down = await release(MAKER, pick.key).expect(503);
    expect((down.body as { message: string }).message).toBe(
      'Could not remove that file right now. Try again in a moment.',
    );
    expect(await statusOf(pick.key)).toBe('pending');
    expect(await usedBytes(MAKER)).toBe(before + 2 * MB);

    bucketDown = false;
    await release(MAKER, pick.key).expect(200);
    expect(await usedBytes(MAKER)).toBe(before);
  });
});
