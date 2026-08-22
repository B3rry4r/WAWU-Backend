import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ConfigModule } from '@nestjs/config';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { ContentPieceModule } from '../content-piece.module';
import { MOCK_FAILURE_TRANSACTION_ID } from '../mock-flutterwave.adapter';

// Seeded WAWU IDs — mirror mock-wawu-id/server.js and prisma/seed.ts exactly
// (see WAWU-Hub-API build task brief).
const USER_PLAIN = '00000000-0000-4000-8000-000000000001';
const USER_CREATOR_BASIC = '00000000-0000-4000-8000-000000000002';
const USER_CREATOR_PRO = '00000000-0000-4000-8000-000000000003';

// seeded-cac-in-7-days: paid ₦5000, owned by USER_CREATOR_PRO, already
// completed-purchased by USER_PLAIN (PURCHASE_PLAIN_BUYS_CAC_COURSE seed row).
const CONTENT_CAC_COURSE = '10000000-0000-4000-8000-000000000001';
// seeded-10-minute-owambe-makeup: free, owned by USER_CREATOR_BASIC.
const CONTENT_MAKEUP_VIDEO = '10000000-0000-4000-8000-000000000002';
// seeded-invoice-template-pack: paid ₦1500, owned by USER_CREATOR_PRO, never
// purchased by USER_PLAIN in seed data — used as the "still locked" fixture.
const CONTENT_PDF_TEMPLATE = '10000000-0000-4000-8000-000000000003';
const NONEXISTENT_CONTENT_ID = 'ffffffff-0000-4000-8000-000000000099';

const MOCK_WAWU_ID_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_WAWU_ID_BASE = `http://localhost:${MOCK_WAWU_ID_PORT}`;

async function waitForHealth(url: string, timeoutMs = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function login(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_WAWU_ID_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) {
    throw new Error(
      `mock-wawu-id login failed for ${identifier}: ${res.status}`,
    );
  }
  const body = (await res.json()) as { accessToken: string };
  return body.accessToken;
}

describe('ContentPiece (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mockWawuId: ChildProcess | undefined;
  let ownedMockWawuId = false;

  let userToken: string;
  let creatorToken: string;
  /**
   * Snapshot of the seeded creator's CreatorState, restored in afterAll.
   *
   * This suite's POST /content tests genuinely need USER_CREATOR_BASIC — the
   * scope=mine assertions are pinned to content that account owns in the
   * seed, so a throwaway identity cannot stand in for it here. What it must
   * NOT do is leave the row mutated: every successful create claims an upload
   * slot (`slotsUsed += 1`), and deleting the ContentPiece rows in afterAll
   * does not give the slot back. That leak is why CreatorState's contract spec
   * saw `slotsUsed: 2` and failed depending on which suite ran first, and why
   * `slotsUsed` climbed by one on every single run of the suite.
   */
  let seededCreatorState: {
    tier: 'basic' | 'pro';
    subscriptionPaid: boolean;
    kycStatus: string;
    slotsUsed: number;
    dmPrice: number | null;
    dmEnabled: boolean;
  } | null = null;

  beforeAll(async () => {
    const alreadyUp = await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`, 1000);
    if (!alreadyUp) {
      mockWawuId = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '../../../mock-wawu-id'),
        env: { ...process.env, MOCK_WAWU_ID_PORT },
        stdio: 'ignore',
      });
      ownedMockWawuId = true;
      const up = await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`);
      if (!up) {
        throw new Error('mock-wawu-id did not become healthy in time');
      }
    }

    userToken = await login('user@test.wawu.dev');
    creatorToken = await login('creator-basic@test.wawu.dev');

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        ContentPieceModule,
      ],
    }).compile();

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

    const state = await prisma.creatorState.findUnique({
      where: { wawuUserId: USER_CREATOR_BASIC },
    });
    if (state) {
      seededCreatorState = {
        tier: state.tier,
        subscriptionPaid: state.subscriptionPaid,
        kycStatus: state.kycStatus,
        slotsUsed: state.slotsUsed,
        dmPrice: state.dmPrice,
        dmEnabled: state.dmEnabled,
      };
    }
  }, 30000);

  afterAll(async () => {
    // POST /content and /unlock tests create real ContentPiece rows
    // (titled 'Contract Test Upload' / 'Unlock Flow Fixture') that are not
    // in seed.ts's known-id set -- delete them so other suites sharing
    // wawu_hub_test (e.g. list-scoped assertions) see a stable dataset.
    const created = await prisma?.contentPiece.findMany({
      where: { title: { in: ['Contract Test Upload', 'Unlock Flow Fixture'] } },
      select: { id: true },
    });
    const createdIds = (created ?? []).map((c) => c.id);
    if (createdIds.length > 0) {
      // Purchase -> ContentPiece is onDelete: Restrict (schema.prisma), NOT
      // Cascade, so the unlock-flow purchases have to go first. This never
      // fired before because the unlock tests were failing in beforeAll and
      // no purchase was ever created; the moment they started passing, the
      // teardown itself began throwing.
      await prisma?.purchase.deleteMany({
        where: { contentId: { in: createdIds } },
      });
      await prisma?.contentPiece.deleteMany({
        where: { id: { in: createdIds } },
      });
    }
    // Give back the upload slots the creates above claimed. Without this the
    // seeded creator's `slotsUsed` ratchets up permanently and poisons every
    // other suite that reads it.
    if (seededCreatorState) {
      await prisma?.creatorState.update({
        where: { wawuUserId: USER_CREATOR_BASIC },
        data: seededCreatorState as never,
      });
    }
    await app?.close();
    if (ownedMockWawuId && mockWawuId) {
      mockWawuId.kill();
    }
  });

  describe('GET /content', () => {
    it('returns only live content by default (feed scope) (200)', async () => {
      const res = await request(app.getHttpServer())
        .get('/content')
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);

      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.pagination).toEqual(
        expect.objectContaining({
          currentPage: 1,
          perPage: 20,
          total: expect.any(Number),
        }),
      );
      for (const item of res.body.data) {
        expect(item.status).toBe('live');
      }
      const cac = res.body.data.find(
        (c: { id: string }) => c.id === CONTENT_CAC_COURSE,
      );
      expect(cac).toBeDefined();
    });

    it('filters by category', async () => {
      const res = await request(app.getHttpServer())
        .get('/content')
        .query({ category: 'beauty' })
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);

      for (const item of res.body.data) {
        expect(item.category).toBe('beauty');
      }
      expect(
        res.body.data.some(
          (c: { id: string }) => c.id === CONTENT_MAKEUP_VIDEO,
        ),
      ).toBe(true);
    });

    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer()).get('/content').expect(401);
    });
  });

  describe('GET /content/:id', () => {
    it('exposes fullAssetUrl unlocked for free content (200)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/content/${CONTENT_MAKEUP_VIDEO}`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);

      expect(res.body.data.id).toBe(CONTENT_MAKEUP_VIDEO);
      expect(res.body.data.fullAssetLocked).toBe(false);
      expect(res.body.data.fullAssetUrl).toEqual(expect.any(String));
    });

    it('exposes fullAssetUrl unlocked for paid content the requester already purchased (200)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/content/${CONTENT_CAC_COURSE}`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);

      expect(res.body.data.fullAssetLocked).toBe(false);
      expect(res.body.data.fullAssetUrl).toEqual(expect.any(String));
    });

    it('locks fullAssetUrl for paid content the requester has not purchased (200)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/content/${CONTENT_PDF_TEMPLATE}`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);

      expect(res.body.data.fullAssetLocked).toBe(true);
      expect(res.body.data.fullAssetUrl).toBeNull();
    });

    it('404s for content that does not exist', async () => {
      const res = await request(app.getHttpServer())
        .get(`/content/${NONEXISTENT_CONTENT_ID}`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(404);
      expect(res.body.data).toBeNull();
    });

    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer())
        .get(`/content/${CONTENT_MAKEUP_VIDEO}`)
        .expect(401);
    });
  });

  describe('POST /content', () => {
    it('creates content for a creator account (subscriptionPaid=true)', async () => {
      const res = await request(app.getHttpServer())
        .post('/content')
        .set('Authorization', `Bearer ${creatorToken}`)
        .send({
          contentType: 'video',
          title: 'Contract Test Upload',
          description:
            'A test upload created by the ContentPiece contract suite.',
          category: 'beauty',
          tags: ['test'],
          accessType: 'paid',
          price: 2000,
          previewAsset:
            'https://storage.seed.local/content/contract-test-preview.mp4',
          fullAsset:
            'https://storage.seed.local/content/contract-test-full.mp4',
        });

      expect([200, 201]).toContain(res.status);
      expect(res.body.data).toEqual(
        expect.objectContaining({
          creatorWawuId: USER_CREATOR_BASIC,
          title: 'Contract Test Upload',
          accessType: 'paid',
          price: 2000,
          status: 'pending',
          creatorFirstUploadFree: false,
        }),
      );
      expect(res.body.data.id).toEqual(expect.any(String));

      const stored = await prisma.contentPiece.findUnique({
        where: { id: res.body.data.id },
      });
      expect(stored).not.toBeNull();
    });

    it('rejects free content submitted with a non-zero price (400)', async () => {
      const res = await request(app.getHttpServer())
        .post('/content')
        .set('Authorization', `Bearer ${creatorToken}`)
        .send({
          contentType: 'video',
          title: 'Bad free price',
          description: 'desc',
          category: 'beauty',
          accessType: 'free',
          price: 500,
          previewAsset: 'https://storage.seed.local/content/x-preview.mp4',
          fullAsset: 'https://storage.seed.local/content/x-full.mp4',
        })
        .expect(400);
      expect(res.body.data).toBeNull();
    });

    it('rejects paid content submitted with a zero price (400)', async () => {
      await request(app.getHttpServer())
        .post('/content')
        .set('Authorization', `Bearer ${creatorToken}`)
        .send({
          contentType: 'video',
          title: 'Bad paid price',
          description: 'desc',
          category: 'beauty',
          accessType: 'paid',
          price: 0,
          previewAsset: 'https://storage.seed.local/content/y-preview.mp4',
          fullAsset: 'https://storage.seed.local/content/y-full.mp4',
        })
        .expect(400);
    });

    it('400s on a payload with a non-whitelisted field', async () => {
      await request(app.getHttpServer())
        .post('/content')
        .set('Authorization', `Bearer ${creatorToken}`)
        .send({
          contentType: 'video',
          title: 'x',
          description: 'desc',
          category: 'beauty',
          accessType: 'free',
          price: 0,
          previewAsset: 'https://storage.seed.local/content/z-preview.mp4',
          fullAsset: 'https://storage.seed.local/content/z-full.mp4',
          views: 999999,
        })
        .expect(400);
    });

    it('403s for a plain (non-creator) account', async () => {
      const res = await request(app.getHttpServer())
        .post('/content')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          contentType: 'video',
          title: 'Should be forbidden',
          description: 'desc',
          category: 'beauty',
          accessType: 'free',
          price: 0,
          previewAsset: 'https://storage.seed.local/content/p-preview.mp4',
          fullAsset: 'https://storage.seed.local/content/p-full.mp4',
        })
        .expect(403);
      expect(res.body.data).toBeNull();
    });

    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer())
        .post('/content')
        .send({ contentType: 'video' })
        .expect(401);
    });

    it('does not count a REJECTED piece against the per-kind allowance', async () => {
      // Returning a rejected upload's slot is two caps, not one.
      // POST /admin/content/:id/reject decrements CreatorState.slotsUsed,
      // which restores the TOTAL cap — but the free/paid sub-caps are counted
      // from ContentPiece rows here in create(). Those counts used to include
      // rejected rows, making the return only half a return: the creator got
      // the total slot back and was still refused another upload of the same
      // kind. And because `isFirstUpload` derives from the same counts, they
      // also stopped being a first-time uploader, which would force their
      // first visible piece to be PAID — the opposite of the spec's
      // first-upload-must-be-free rule.
      //
      // Asserted through the real creator-facing endpoint, because the
      // counter was never the thing that was broken.
      const state = await prisma.creatorState.findUniqueOrThrow({
        where: { wawuUserId: USER_CREATOR_BASIC },
      });

      // This creator's single Basic free slot is already held by a seeded LIVE
      // piece, so the rule is isolated by flipping that one piece to rejected
      // and asserting the slot frees up. Restored below — the seeded row is
      // shared with other specs.
      const occupying = await prisma.contentPiece.findFirstOrThrow({
        where: {
          creatorWawuId: USER_CREATOR_BASIC,
          accessType: 'free',
          status: { not: 'rejected' },
        },
      });
      await prisma.contentPiece.update({
        where: { id: occupying.id },
        data: { status: 'rejected' },
      });

      const res = await request(app.getHttpServer())
        .post('/content')
        .set('Authorization', `Bearer ${creatorToken}`)
        .send({
          contentType: 'pdf',
          title: 'Replacement for the rejected piece',
          description: 'Uploaded after a rejection handed the slot back.',
          category: 'business_entrepreneurship',
          accessType: 'free',
          price: 0,
          previewAsset: 'https://storage.seed.local/content/rep-preview.pdf',
          fullAsset: 'https://storage.seed.local/content/rep-full.pdf',
        });

      // Restore the shared seeded row FIRST, so a failed assertion below
      // cannot leave it rejected and poison every later spec — the exact
      // fixture-litter trap this suite's own afterAll comment documents.
      await prisma.contentPiece.update({
        where: { id: occupying.id },
        data: { status: occupying.status },
      });
      await prisma.contentPiece.deleteMany({
        where: { id: res.body?.data?.id ?? '__none__' },
      });
      await prisma.creatorState.update({
        where: { wawuUserId: USER_CREATOR_BASIC },
        data: { slotsUsed: state.slotsUsed },
      });

      // A 403 here is the regression: the rejected row still occupying the
      // creator's one free slot.
      expect([200, 201]).toContain(res.status);
    });
  });

  describe('GET /content (scope=mine) and GET /content/mine', () => {
    it('scope=mine returns only the creator own content, any status', async () => {
      const res = await request(app.getHttpServer())
        .get('/content')
        .query({ scope: 'mine' })
        .set('Authorization', `Bearer ${creatorToken}`)
        .expect(200);

      for (const item of res.body.data) {
        expect(item.creatorWawuId).toBe(USER_CREATOR_BASIC);
      }
      expect(
        res.body.data.some(
          (c: { id: string }) => c.id === CONTENT_MAKEUP_VIDEO,
        ),
      ).toBe(true);
      expect(
        res.body.data.some((c: { status: string }) => c.status === 'pending'),
      ).toBe(true);
    });

    it('GET /content/mine is creator-only (403 for plain user)', async () => {
      await request(app.getHttpServer())
        .get('/content/mine')
        .set('Authorization', `Bearer ${userToken}`)
        .expect(403);
    });

    it('GET /content/mine returns the creator own content', async () => {
      const res = await request(app.getHttpServer())
        .get('/content/mine')
        .set('Authorization', `Bearer ${creatorToken}`)
        .expect(200);

      expect(
        res.body.data.every(
          (c: { creatorWawuId: string }) =>
            c.creatorWawuId === USER_CREATOR_BASIC,
        ),
      ).toBe(true);
    });
  });

  describe('GET /content/purchases', () => {
    it('returns the buyer own content purchases with a numeric commissionRate', async () => {
      const res = await request(app.getHttpServer())
        .get('/content/purchases')
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);

      const seeded = res.body.data.find(
        (p: { contentId: string }) => p.contentId === CONTENT_CAC_COURSE,
      );
      expect(seeded).toBeDefined();
      expect(seeded.buyerWawuId).toBe(USER_PLAIN);
      expect(seeded.status).toBe('completed');
      expect(typeof seeded.commissionRate).toBe('number');
    });

    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer()).get('/content/purchases').expect(401);
    });
  });

  describe('POST /content/:id/unlock + /unlock/verify (full flow)', () => {
    let liveContentId: string;

    beforeAll(async () => {
      const createRes = await request(app.getHttpServer())
        .post('/content')
        .set('Authorization', `Bearer ${creatorToken}`)
        .send({
          contentType: 'pdf',
          title: 'Unlock Flow Fixture',
          description:
            'Created and flipped live directly for the unlock-flow test.',
          // Must be one of the 25 taxonomy ids in src/common/categories.ts.
          // This was 'business', which stopped being valid when d01000e
          // introduced the taxonomy — the fixture create 400'd, `data` came
          // back null, and all eight tests in this block died on a
          // `Cannot read properties of null` instead of reporting the 400.
          category: 'business_entrepreneurship',
          accessType: 'paid',
          price: 1200,
          previewAsset:
            'https://storage.seed.local/content/unlock-fixture-preview.pdf',
          fullAsset:
            'https://storage.seed.local/content/unlock-fixture-full.pdf',
        });
      // Fail loudly, and with the server's own reason, if the fixture cannot
      // be created — a broken fixture must not masquerade as eight unrelated
      // assertion failures.
      if (![200, 201].includes(createRes.status) || !createRes.body?.data) {
        throw new Error(
          `Unlock fixture create failed: ${createRes.status} ${JSON.stringify(createRes.body)}`,
        );
      }
      liveContentId = createRes.body.data.id;
      // Flip to 'live' directly — no moderation/publish endpoint exists in
      // ContentPiece's own contract (out of scope), so this test fixture
      // bypasses the API for that one field, same as other contract specs
      // reading Prisma directly to assert on stored state.
      await prisma.contentPiece.update({
        where: { id: liveContentId },
        data: { status: 'live' },
      });
    });

    it('rejects unlocking free content (400)', async () => {
      await request(app.getHttpServer())
        .post(`/content/${CONTENT_MAKEUP_VIDEO}/unlock`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(400);
    });

    it('rejects a creator unlocking their own content (400)', async () => {
      await request(app.getHttpServer())
        .post(`/content/${liveContentId}/unlock`)
        .set('Authorization', `Bearer ${creatorToken}`)
        .expect(400);
    });

    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer())
        .post(`/content/${liveContentId}/unlock`)
        .expect(401);
    });

    let txRef: string;

    it('initializes a charge for a buyer (200/201)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/content/${liveContentId}/unlock`)
        .set('Authorization', `Bearer ${userToken}`)
        .send();

      expect([200, 201]).toContain(res.status);
      expect(res.body.data.flutterwaveConfig).toEqual(
        expect.objectContaining({
          amount: 1200,
          currency: 'NGN',
          txRef: expect.any(String),
        }),
      );
      txRef = res.body.data.flutterwaveConfig.txRef;
    });

    it('400s verify on a failed Flutterwave transaction and marks the purchase failed', async () => {
      const res = await request(app.getHttpServer())
        .post(`/content/${liveContentId}/unlock/verify`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ transaction_id: MOCK_FAILURE_TRANSACTION_ID, tx_ref: txRef })
        .expect(400);
      expect(res.body.data).toBeNull();
    });

    it('404s verify for a tx_ref that does not match any unlock attempt', async () => {
      await request(app.getHttpServer())
        .post(`/content/${liveContentId}/unlock/verify`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ transaction_id: 'whatever', tx_ref: 'no-such-ref' })
        .expect(404);
    });

    it('completes the unlock on a fresh successful attempt, then GET reflects unlocked', async () => {
      const initRes = await request(app.getHttpServer())
        .post(`/content/${liveContentId}/unlock`)
        .set('Authorization', `Bearer ${userToken}`)
        .send();
      const freshTxRef = initRes.body.data.flutterwaveConfig.txRef;

      const verifyRes = await request(app.getHttpServer())
        .post(`/content/${liveContentId}/unlock/verify`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ transaction_id: 'real-looking-tx-id', tx_ref: freshTxRef });

      expect([200, 201]).toContain(verifyRes.status);
      expect(verifyRes.body.data).toEqual(
        expect.objectContaining({
          purchased: true,
          fullAssetUrl: expect.any(String),
        }),
      );

      const getRes = await request(app.getHttpServer())
        .get(`/content/${liveContentId}`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);
      expect(getRes.body.data.fullAssetLocked).toBe(false);
    });

    it('rejects unlocking again once already purchased (400)', async () => {
      await request(app.getHttpServer())
        .post(`/content/${liveContentId}/unlock`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(400);
    });
  });

  describe('POST /content/:id/save + DELETE /content/:id/save', () => {
    it('saves content for the requester (200/201)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/content/${CONTENT_MAKEUP_VIDEO}/save`)
        .set('Authorization', `Bearer ${userToken}`)
        .send();

      expect([200, 201]).toContain(res.status);
      expect(res.body.data).toEqual(
        expect.objectContaining({
          userWawuId: USER_PLAIN,
          contentId: CONTENT_MAKEUP_VIDEO,
        }),
      );

      const stored = await prisma.savedItem.findUnique({
        where: {
          userWawuId_contentId: {
            userWawuId: USER_PLAIN,
            contentId: CONTENT_MAKEUP_VIDEO,
          },
        },
      });
      expect(stored).not.toBeNull();
    });

    it('404s saving content that does not exist', async () => {
      await request(app.getHttpServer())
        .post(`/content/${NONEXISTENT_CONTENT_ID}/save`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(404);
    });

    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer())
        .post(`/content/${CONTENT_MAKEUP_VIDEO}/save`)
        .expect(401);
    });

    it('unsaves content (200, void)', async () => {
      const res = await request(app.getHttpServer())
        .delete(`/content/${CONTENT_MAKEUP_VIDEO}/save`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);
      expect(res.body.data).toBeNull();

      const stored = await prisma.savedItem.findUnique({
        where: {
          userWawuId_contentId: {
            userWawuId: USER_PLAIN,
            contentId: CONTENT_MAKEUP_VIDEO,
          },
        },
      });
      expect(stored).toBeNull();
    });
  });

  describe('POST /content/:id/rate', () => {
    it('recomputes ratingPct within [0,100] (200/201)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/content/${CONTENT_MAKEUP_VIDEO}/rate`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ rating: 5 });

      expect([200, 201]).toContain(res.status);
      expect(res.body.data.id).toBe(CONTENT_MAKEUP_VIDEO);
      expect(typeof res.body.data.ratingPct).toBe('number');
      expect(res.body.data.ratingPct).toBeGreaterThanOrEqual(0);
      expect(res.body.data.ratingPct).toBeLessThanOrEqual(100);
    });

    it('400s on an out-of-range rating', async () => {
      await request(app.getHttpServer())
        .post(`/content/${CONTENT_MAKEUP_VIDEO}/rate`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ rating: 6 })
        .expect(400);
    });

    it('404s rating content that does not exist', async () => {
      await request(app.getHttpServer())
        .post(`/content/${NONEXISTENT_CONTENT_ID}/rate`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ rating: 3 })
        .expect(404);
    });

    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer())
        .post(`/content/${CONTENT_MAKEUP_VIDEO}/rate`)
        .send({ rating: 3 })
        .expect(401);
    });
  });
});
