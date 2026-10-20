/* eslint-disable @typescript-eslint/no-unsafe-member-access */
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
import { CreatorStateModule } from '../../creator-state/creator-state.module';
import { StorageModule } from '../../storage/storage.module';
import { WALLET_PROVIDER } from '../../wallet-provider/wallet-provider.interface';
import { PLANS_CONFIG, type PlansConfig } from '../plans-config';
import { PlansModule } from '../plans.module';

/**
 * S7 round 2, F3 over HTTP, on the real database and the real modules: the
 * Hub's publish gate refuses while the person's identity check is paused,
 * with one code (403 `identity_paused`) and the Hub's own sentence. A check
 * that passed (a wallet is open), one under way, and one never started are
 * refused nothing. The server runs the reviewing provider (the wallet
 * provider seam is a stand-in that only says it reviews the person, so no
 * provider is called and nothing is configured).
 */

const DAY = 86_400_000;

function mintToken(sub: string): string {
  const privateKey = readFileSync(
    join(__dirname, '../../../mock-wawu-id/private.pem'),
    'utf8',
  );
  return jwt.sign(
    {
      sub,
      email: `pause-${sub}@test.wawu.dev`,
      phone: '+2348031234567',
      firstName: 'Pause',
      lastName: 'Tester',
      country: 'Nigeria',
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
  STORAGE_ACCESS_KEY_ID: 'pause-test-key',
  STORAGE_SECRET_ACCESS_KEY: 'pause-test-secret',
  STORAGE_BUCKET: 'pause-test-bucket',
  STORAGE_REGION: 'auto',
};

describe('Publishing while the identity check is paused (S7 round 2, F3) over HTTP', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let config: PlansConfig;
  const envSnapshot: Record<string, string | undefined> = {};
  const people: string[] = [];
  let seq = 0;

  const auth = (id: string) => `Bearer ${mintToken(id)}`;
  const http = () => request(app.getHttpServer());
  const get = (id: string, path: string) =>
    http().get(`/api/hub${path}`).set('Authorization', auth(id));
  const post = (id: string, path: string, send?: object) =>
    http().post(`/api/hub${path}`).set('Authorization', auth(id)).send(send);

  /** A creator with a running tier and nothing published. */
  async function maker(withTier = true): Promise<string> {
    const id = randomUUID();
    people.push(id);
    await prisma.userProfile.create({
      data: { wawuUserId: id, accountType: 'creator' },
    });
    if (withTier) {
      const t = config.tiers[0];
      const until = Date.now() + 20 * DAY;
      await prisma.makerTier.create({
        data: {
          wawuUserId: id,
          tierId: t.id,
          activeFrom: new Date(until - t.days * DAY),
          activeUntil: new Date(until),
          productsIncluded: t.products,
          extraProducts: 0,
          pointsIncluded: t.bonusPoints,
          voiceIntroIncluded: false,
        },
      });
    }
    return id;
  }
  /** The provider's review of the person, in its own word (`incomplete`, `pending`, `rejected` ...). */
  async function review(id: string, status: string, extra: object = {}) {
    seq += 1;
    await prisma.nuvionEntity.create({
      data: {
        wawuUserId: id,
        entityId: `ent-pause-${Date.now()}-${seq}`,
        status,
        ...extra,
      },
    });
  }
  async function openWallet(id: string) {
    seq += 1;
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId: id,
        customerId: `cus-pause-${Date.now()}-${seq}`,
        walletId: `wal-pause-${Date.now()}-${seq}`,
        accountNumber: `9${String(Date.now()).slice(-6)}${String(seq).padStart(3, '0')}`,
        provider: 'nuvion',
      },
    });
  }
  const pieceBody = () => {
    seq += 1;
    return {
      contentType: 'video',
      title: `Pause piece ${seq}`,
      description: 'A piece the identity pause spec makes.',
      category: 'business_entrepreneurship',
      specializations: [],
      accessType: 'paid',
      price: 1500,
      previewAsset: `https://cdn.example.com/p-${seq}.jpg`,
      fullAsset: `https://cdn.example.com/f-${seq}.mp4`,
    };
  };
  const publish = (id: string) => post(id, '/content', pieceBody());
  const presign = (id: string, folder: string) =>
    post(id, '/uploads/presign', {
      folder,
      contentType: 'image/png',
      extension: 'png',
      contentLength: 1000,
    });

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
    })
      .overrideProvider(WALLET_PROVIDER)
      .useValue({ name: 'nuvion', capabilities: { separateKyc: true } })
      .compile();
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
    await prisma.nuvionEntity.deleteMany({ where });
    await prisma.fintavaWallet.deleteMany({ where });
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

  it('refuses POST /content while the check waits for documents: 403 identity_paused, the Hub’s sentence, nothing published', async () => {
    const id = await maker();
    await review(id, 'incomplete');
    const res = await publish(id).expect(403);
    expect(body(res).reason).toMatchObject({
      code: 'identity_paused',
      stage: 'needs_documents',
    });
    expect(body(res).reason.message).toBe(body(res).message);
    expect(body(res).message).toBe(
      'Publishing is paused until your identity check passes. Your wallet is not finished opening. Send the documents the bank asked for.',
    );
    expect(body(res).message).not.toMatch(/—/);
    expect(
      await prisma.contentPiece.count({ where: { creatorWawuId: id } }),
    ).toBe(0);
  });

  it('refuses a draft publish and a content upload the same way, and says what failed when the check was refused', async () => {
    const id = await maker();
    await review(id, 'rejected', {
      decidedAt: new Date(),
      documentStatus: 'rejected',
    });
    const draft = body(
      await post(id, '/product-drafts', { title: 'Held draft' }).expect(201),
    );
    const res = await post(id, `/product-drafts/${draft.data.id}/publish`, {
      previewAsset: 'https://cdn.example.com/p.jpg',
      fullAsset: 'https://cdn.example.com/f.mp4',
    }).expect(403);
    expect(body(res).reason).toMatchObject({
      code: 'identity_paused',
      stage: 'rejected',
    });
    expect(body(res).message).toContain(
      'We could not verify your ID document.',
    );
    const upload = await presign(id, 'content/full').expect(403);
    expect(body(upload).reason.code).toBe('identity_paused');
    // The draft is still there: nothing was lost.
    expect(
      body(await get(id, '/product-drafts').expect(200)).data,
    ).toHaveLength(1);
  });

  it('keeps the way out open: a paused person can still upload their ID document', async () => {
    const id = await maker();
    await review(id, 'incomplete');
    await presign(id, 'kyc/id-document').expect(200);
  });

  it('is told about the tier first when there is none: 402 tier_required, not the identity', async () => {
    const id = await maker(false);
    await review(id, 'incomplete');
    const res = await publish(id).expect(402);
    expect(body(res).reason.code).toBe('tier_required');
  });

  it('lets a check that passed publish: a wallet is open', async () => {
    const id = await maker();
    await openWallet(id);
    await publish(id).expect(201);
  });

  it('lets a check still under way publish as before (the provider is looking)', async () => {
    const id = await maker();
    await review(id, 'pending');
    await publish(id).expect(201);
  });

  it('lets a check never started publish as before: no review was ever sent', async () => {
    const id = await maker();
    await publish(id).expect(201);
    expect((await get(id, '/me/tier').expect(200)).body.data.productsUsed).toBe(
      1,
    );
  });
});
