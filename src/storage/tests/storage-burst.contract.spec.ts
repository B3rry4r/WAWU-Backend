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
import { PrismaPg } from '@prisma/adapter-pg';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PrismaClient } from '../../../generated/prisma/client';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthGuard } from '../../common/guards/wawu-auth.guard';
import { ContentPieceModule } from '../../content-piece/content-piece.module';
import { PublishingAllowanceService } from '../../plans/publishing-allowance.service';
import { PublishingGate } from '../../plans/publishing-gate.service';
import { StorageModule } from '../storage.module';
import { inPersonsTurn, requestsWaitingFor } from '../storage-lock';

/**
 * ME-04 round 6, over HTTP on the real database and a pool of ONE connection.
 *
 * Round 5's verifier: one person's burst (twenty confirms and ten creates
 * together) took every pooled connection and froze the Hub for a minute, for
 * everybody. Two causes:
 *
 * 1. A step inside the person's locked transaction read through the Hub's
 *    global client (the refusal of a create that lost the last place; the
 *    allowance of a late file coming back), which needs a SECOND connection
 *    while the transaction holds the first. On a pool of one that can never
 *    be served, so it fails here in seconds instead of needing a burst.
 * 2. Requests waiting for the person's lock held a connection each. Now they
 *    wait in memory (storage-lock.ts `inPersonsTurn`): two may, the rest are
 *    refused 429 `storage_busy` with a Retry-After.
 *
 * The bucket is the one thing faked (S3Client.send). Every row is this spec's
 * own and is deleted in afterAll.
 */
const MB = 1024 * 1024;
const OWN = (n: number) =>
  `e0600000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const MAKER = OWN(1);
const OTHER = OWN(2);
const OWNED = [MAKER, OTHER];

describe('One person’s burst (ME-04 round 6, contract)', () => {
  let app: INestApplication;
  const server = (): App => app.getHttpServer() as App;
  let prisma: PrismaService;
  let allowance: PublishingAllowanceService;
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

  async function reserve(
    owner: string,
    folder: 'content/full' | 'content/preview',
    bytes = MB,
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

  const release = (owner: string, key: string) =>
    request(server())
      .post('/uploads/release')
      .set('Authorization', bearer(owner))
      .send({ key });

  const confirm = (owner: string, key: string) =>
    request(server())
      .post('/uploads/confirm')
      .set('Authorization', bearer(owner))
      .send({ key });

  const statusOf = async (key: string) =>
    (await prisma.storageObject.findUnique({ where: { key } }))?.status;

  /** Polls until `ready` holds (the queue is a few milliseconds from filling). */
  async function until(ready: () => boolean): Promise<void> {
    for (let i = 0; i < 300 && !ready(); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(ready()).toBe(true);
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

    jest
      .spyOn(S3Client.prototype, 'send')
      .mockImplementation(((command: unknown) =>
        command instanceof HeadObjectCommand
          ? Promise.resolve({})
          : Promise.resolve({})) as never);

    // ONE connection for the whole Hub: anything that needs a second one while
    // a transaction is open can never be served.
    const oneConnection = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: process.env.DATABASE_URL,
        max: 1,
      }),
    });

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
      .overrideProvider(PrismaService)
      .useValue(oneConnection)
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
    allowance = moduleRef.get(PublishingAllowanceService, { strict: false });

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
    await prisma.makerTier.deleteMany({
      where: { wawuUserId: { in: OWNED } },
    });
    await prisma.makerTier.createMany({
      data: OWNED.map((wawuUserId) => ({
        wawuUserId,
        tierId: 'me04-suite',
        activeFrom: new Date(Date.now() - 86_400_000),
        activeUntil: new Date(Date.now() + 30 * 86_400_000),
        productsIncluded: 1,
        pointsIncluded: 0,
      })),
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest
      .spyOn(S3Client.prototype, 'send')
      .mockImplementation((() => Promise.resolve({})) as never);
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
    await prisma.makerTier.deleteMany({
      where: { wawuUserId: { in: OWNED } },
    });
    await prisma.userProfile.deleteMany({
      where: { wawuUserId: { in: OWNED } },
    });
    await app.close();
    await prisma.$disconnect();
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('a create that loses the last place is refused 402 without needing a second connection', async () => {
    const preview = await reserve(MAKER, 'content/preview');
    const full = await reserve(MAKER, 'content/full');
    // The place is taken after the pre-check read it free: the claim inside
    // the transaction loses, which is the step that read through the global
    // client.
    await prisma.creatorState.upsert({
      where: { wawuUserId: MAKER },
      create: { wawuUserId: MAKER, slotsUsed: 1 },
      update: { slotsUsed: 1 },
    });
    const real = await allowance.of(MAKER);
    expect(real.productsUsed).toBe(1);
    jest
      .spyOn(PublishingGate.prototype, 'assertRoomForProduct')
      .mockResolvedValue({ ...real, productsUsed: 0 });

    const t0 = Date.now();
    const res = await request(server())
      .post('/content')
      .set('Authorization', bearer(MAKER))
      .send({
        contentType: 'pdf',
        title: 'ME-04 round 6',
        description: 'A piece that loses the last place',
        category: 'business_entrepreneurship',
        tags: [],
        accessType: 'paid',
        price: 2000,
        previewAsset: preview.fileUrl,
        fullAsset: full.fileUrl,
      });
    expect(res.status).toBe(402);
    expect((res.body as { reason?: { code?: string } }).reason?.code).toBe(
      'product_limit_reached',
    );
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(
      await prisma.contentPiece.count({
        where: { creatorWawuId: MAKER },
      }),
    ).toBe(0);
    const state = await prisma.creatorState.findUniqueOrThrow({
      where: { wawuUserId: MAKER },
    });
    expect(state.slotsUsed).toBe(1);
  }, 30_000);

  it('a late file coming back is counted again without needing a second connection', async () => {
    const late = await reserve(OTHER, 'content/full');
    // Given up by the settling pass, not released by the person.
    await prisma.storageObject.update({
      where: { key: late.key },
      data: { status: 'abandoned' },
    });
    const t0 = Date.now();
    const res = await confirm(OTHER, late.key);
    expect(res.status).toBe(200);
    expect((res.body as { data: { status: string } }).data.status).toBe(
      'confirmed',
    );
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(await statusOf(late.key)).toBe('confirmed');
  }, 30_000);

  it('two requests of a person wait their turn, the third is refused 429 with a Retry-After and nothing changes', async () => {
    // The first test left this person at their one place.
    await prisma.creatorState.update({
      where: { wawuUserId: MAKER },
      data: { slotsUsed: 0 },
    });
    const keys = [
      await reserve(MAKER, 'content/full'),
      await reserve(MAKER, 'content/full'),
      await reserve(MAKER, 'content/full'),
    ];
    const other = await reserve(OTHER, 'content/full');

    let open: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      open = resolve;
    });
    const holder = inPersonsTurn(MAKER, () => held);

    const first = release(MAKER, keys[0].key).then((r) => r);
    const second = release(MAKER, keys[1].key).then((r) => r);
    await until(() => requestsWaitingFor(MAKER) === 2);

    const refused = await release(MAKER, keys[2].key);
    expect(refused.status).toBe(429);
    expect(refused.headers['retry-after']).toBe('1');
    expect(refused.body).toMatchObject({
      statusCode: 429,
      message: 'You have several uploads in progress. Try again in a moment.',
      reason: { code: 'storage_busy', retryAfterSeconds: 1 },
    });
    expect(await statusOf(keys[2].key)).toBe('pending');

    // Somebody else is not held up by it.
    const t0 = Date.now();
    await release(OTHER, other.key).expect(200);
    expect(Date.now() - t0).toBeLessThan(2_000);

    open();
    await holder;
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect(await statusOf(keys[0].key)).toBe('abandoned');
    expect(await statusOf(keys[1].key)).toBe('abandoned');

    // The line is clear: the refused request is let in when it asks again.
    await release(MAKER, keys[2].key).expect(200);
    expect(requestsWaitingFor(MAKER)).toBe(0);
  }, 30_000);

  it('twelve releases at once on one connection: each answers 200 or 429, none 500, and every 200 took effect', async () => {
    const keys: string[] = [];
    for (let i = 0; i < 12; i += 1)
      keys.push((await reserve(OTHER, 'content/preview')).key);
    const t0 = Date.now();
    const answers = await Promise.all(
      keys.map((key) => release(OTHER, key).then((r) => r)),
    );
    expect(Date.now() - t0).toBeLessThan(10_000);
    for (const [i, res] of answers.entries()) {
      expect([200, 429]).toContain(res.status);
      if (res.status === 429) {
        expect(res.headers['retry-after']).toBe('1');
        expect(await statusOf(keys[i])).toBe('pending');
      } else {
        expect(await statusOf(keys[i])).toBe('abandoned');
      }
    }
    expect(answers.some((r) => r.status === 200)).toBe(true);
  }, 30_000);
});
