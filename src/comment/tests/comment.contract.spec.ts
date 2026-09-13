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
import { CommentModule } from '../comment.module';

// Seeded WAWU IDs — mirror mock-wawu-id/server.js and prisma/seed.ts exactly
// (see WAWU-Hub-API build task brief). Only used to obtain real tokens; this
// spec never mutates a row that hangs off these accounts.
const USER_PLAIN = '00000000-0000-4000-8000-000000000001';
const USER_CREATOR_BASIC = '00000000-0000-4000-8000-000000000002';

const NONEXISTENT_CONTENT_ID = 'ffffffff-0000-4000-8000-000000000099';

/**
 * Fixtures this spec owns outright (README § Test hygiene rules, rule 1 —
 * the pattern community.contract.spec.ts and creator-state.contract.spec.ts
 * already follow).
 *
 * These tests used to read and write the SEEDED content piece
 * `10000000-...-000000000002` and assert that the seeded comment
 * `12000000-...-000000000001` appeared on page 1 of its comment list. The
 * POST tests below then added two more comments to that same seeded content
 * and never removed them. CommentService.list() orders `createdAt desc` with
 * a default perPage of 20, so once ~10 suite runs had piled up 20 newer
 * comments, the seeded one fell off page 1 and the GET assertion started
 * failing — a failure inherited from previous runs rather than caused by the
 * code under test. (Each run also left `ContentPiece.commentCount` on the
 * seeded row two higher than seed.ts set it.)
 *
 * The read fixtures and the write fixtures are deliberately two DIFFERENT
 * content pieces, so the exact totals the GET tests assert cannot drift even
 * if the POST tests run first.
 */
const OWN_CONTENT_READ = 'c6000000-0000-4000-8000-000000000001';
const OWN_CONTENT_WRITE = 'c6000000-0000-4000-8000-000000000002';
const OWNED_CONTENT_IDS = [OWN_CONTENT_READ, OWN_CONTENT_WRITE];

// Three comments on OWN_CONTENT_READ with fixed, strictly increasing
// createdAt values, so "newest first" and the page boundaries are exact.
const OWN_COMMENT_OLDEST = 'c6100000-0000-4000-8000-000000000001';
const OWN_COMMENT_MIDDLE = 'c6100000-0000-4000-8000-000000000002';
const OWN_COMMENT_NEWEST = 'c6100000-0000-4000-8000-000000000003';
// Parent for the reply test, on the write fixture.
const OWN_COMMENT_PARENT = 'c6100000-0000-4000-8000-000000000004';

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

describe('Comment (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mockWawuId: ChildProcess | undefined;
  let ownedMockWawuId = false;

  let userToken: string;
  let creatorToken: string;

  /** Removes every row this spec owns. Also run before creating them, so an
   *  aborted previous run cannot leave a fixture behind that skews the counts. */
  async function dropOwnedFixtures(): Promise<void> {
    await prisma.comment.deleteMany({
      where: { contentId: { in: OWNED_CONTENT_IDS } },
    });
    // Purchase -> ContentPiece is onDelete: Restrict (README § Test hygiene),
    // but this spec never creates a purchase against its own content, so the
    // content delete is unblocked.
    await prisma.contentPiece.deleteMany({
      where: { id: { in: OWNED_CONTENT_IDS } },
    });
  }

  beforeAll(async () => {
    // Reuse an already-running mock WAWU ID if present, otherwise spawn one
    // for this test run (conventions.md § Local test environment).
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
        CommentModule,
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

    await dropOwnedFixtures();

    // Two content pieces of this spec's own, shaped like the seeded video
    // (prisma/seed.ts CONTENT_MAKEUP_VIDEO) but under UUIDs and slugs that
    // neither seed.ts nor any other spec touches.
    for (const [id, slug] of [
      [OWN_CONTENT_READ, 'fixture-comment-spec-read'],
      [OWN_CONTENT_WRITE, 'fixture-comment-spec-write'],
    ] as const) {
      await prisma.contentPiece.create({
        data: {
          id,
          slug,
          creatorWawuId: USER_CREATOR_BASIC,
          contentType: 'video',
          title: 'FIXTURE: comment.contract.spec.ts',
          description:
            'Owned by comment.contract.spec.ts; deleted in afterAll.',
          category: 'beauty',
          tags: [],
          accessType: 'free',
          price: 0,
          durationLabel: '10m',
          previewAssetUrl: 'https://storage.test/fixture-preview.mp4',
          fullAssetUrl: 'https://storage.test/fixture-full.mp4',
          status: 'live',
          commentCount: 0,
        },
      });
    }

    await prisma.comment.createMany({
      data: [
        {
          id: OWN_COMMENT_OLDEST,
          contentId: OWN_CONTENT_READ,
          authorWawuId: USER_PLAIN,
          text: 'FIXTURE: oldest comment',
          createdAt: new Date('2026-01-01T10:00:00.000Z'),
        },
        {
          id: OWN_COMMENT_MIDDLE,
          contentId: OWN_CONTENT_READ,
          authorWawuId: USER_CREATOR_BASIC,
          text: 'FIXTURE: middle comment',
          createdAt: new Date('2026-01-01T11:00:00.000Z'),
        },
        {
          id: OWN_COMMENT_NEWEST,
          contentId: OWN_CONTENT_READ,
          authorWawuId: USER_PLAIN,
          text: 'FIXTURE: newest comment',
          createdAt: new Date('2026-01-01T12:00:00.000Z'),
        },
        {
          id: OWN_COMMENT_PARENT,
          contentId: OWN_CONTENT_WRITE,
          authorWawuId: USER_PLAIN,
          text: 'FIXTURE: reply target',
          createdAt: new Date('2026-01-01T10:00:00.000Z'),
        },
      ],
    });
    await prisma.contentPiece.update({
      where: { id: OWN_CONTENT_READ },
      data: { commentCount: 3 },
    });
    await prisma.contentPiece.update({
      where: { id: OWN_CONTENT_WRITE },
      data: { commentCount: 1 },
    });
  }, 30000);

  afterAll(async () => {
    // Leave wawu_hub_test exactly as it was found — including the comments the
    // POST tests below created, which land on OWN_CONTENT_WRITE.
    await dropOwnedFixtures();
    await app?.close();
    if (ownedMockWawuId && mockWawuId) {
      mockWawuId.kill();
    }
  });

  describe('GET /content/:id/comments', () => {
    it('returns the paginated list of comments for valid content (200)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/content/${OWN_CONTENT_READ}/comments`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);

      expect(res.body.statusCode).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      // Defaults from PaginationQueryDto, and an EXACT total — this spec owns
      // every comment on this content, so nothing else can move the number.
      expect(res.body.pagination).toEqual({
        currentPage: 1,
        nextPage: null,
        perPage: 20,
        total: 3,
      });
      // Newest first (CommentService.list orders createdAt desc).
      expect(res.body.data.map((c: { id: string }) => c.id)).toEqual([
        OWN_COMMENT_NEWEST,
        OWN_COMMENT_MIDDLE,
        OWN_COMMENT_OLDEST,
      ]);

      const oldest = res.body.data.find(
        (c: { id: string }) => c.id === OWN_COMMENT_OLDEST,
      );
      expect(oldest).toBeDefined();
      expect(oldest.contentId).toBe(OWN_CONTENT_READ);
      expect(oldest.authorWawuId).toBe(USER_PLAIN);
      expect(oldest.text).toBe('FIXTURE: oldest comment');
      expect(oldest.replyToId).toBeNull();
      // list() resolves `author` from authorWawuId (CommentService.lookupAuthors)
      // rather than leaving the client to render the bare id it used to.
      expect(oldest.author).toEqual(
        expect.objectContaining({ wawuId: USER_PLAIN }),
      );
    });

    it('honours page/perPage — page 1 of 2 carries the two newest, page 2 the rest', async () => {
      const first = await request(app.getHttpServer())
        .get(`/content/${OWN_CONTENT_READ}/comments`)
        .query({ page: 1, perPage: 2 })
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);

      expect(first.body.pagination).toEqual({
        currentPage: 1,
        nextPage: 2,
        perPage: 2,
        total: 3,
      });
      expect(first.body.data.map((c: { id: string }) => c.id)).toEqual([
        OWN_COMMENT_NEWEST,
        OWN_COMMENT_MIDDLE,
      ]);

      const second = await request(app.getHttpServer())
        .get(`/content/${OWN_CONTENT_READ}/comments`)
        .query({ page: 2, perPage: 2 })
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);

      expect(second.body.pagination).toEqual({
        currentPage: 2,
        nextPage: null,
        perPage: 2,
        total: 3,
      });
      expect(second.body.data.map((c: { id: string }) => c.id)).toEqual([
        OWN_COMMENT_OLDEST,
      ]);
    });

    it('returns an empty page past the end without inventing rows', async () => {
      const res = await request(app.getHttpServer())
        .get(`/content/${OWN_CONTENT_READ}/comments`)
        .query({ page: 3, perPage: 2 })
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);

      expect(res.body.data).toEqual([]);
      expect(res.body.pagination).toEqual({
        currentPage: 3,
        nextPage: null,
        perPage: 2,
        total: 3,
      });
    });

    it('404s for content that does not exist (invalid request)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/content/${NONEXISTENT_CONTENT_ID}/comments`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(404);

      expect(res.body.data).toBeNull();
    });

    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer())
        .get(`/content/${OWN_CONTENT_READ}/comments`)
        .expect(401);
    });
  });

  describe('POST /content/:id/comments', () => {
    it('creates a comment for a valid request (201/200 shape)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/content/${OWN_CONTENT_WRITE}/comments`)
        .set('Authorization', `Bearer ${creatorToken}`)
        .send({ text: 'Great tutorial, thank you!' });

      expect([200, 201]).toContain(res.status);
      expect(res.body.data).toEqual(
        expect.objectContaining({
          contentId: OWN_CONTENT_WRITE,
          authorWawuId: USER_CREATOR_BASIC,
          text: 'Great tutorial, thank you!',
          replyToId: null,
        }),
      );
      expect(res.body.data.id).toEqual(expect.any(String));

      const stored = await prisma.comment.findUnique({
        where: { id: res.body.data.id },
      });
      expect(stored).not.toBeNull();
    });

    it('supports replying to an existing comment on the same content', async () => {
      const res = await request(app.getHttpServer())
        .post(`/content/${OWN_CONTENT_WRITE}/comments`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ text: 'Totally agree!', replyToId: OWN_COMMENT_PARENT });

      expect([200, 201]).toContain(res.status);
      expect(res.body.data.replyToId).toBe(OWN_COMMENT_PARENT);
    });

    it('400s on an invalid payload (empty text)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/content/${OWN_CONTENT_WRITE}/comments`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ text: '' })
        .expect(400);

      expect(res.body.data).toBeNull();
    });

    it('400s on a payload with a non-whitelisted field', async () => {
      await request(app.getHttpServer())
        .post(`/content/${OWN_CONTENT_WRITE}/comments`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ text: 'hello', likes: 999 })
        .expect(400);
    });

    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer())
        .post(`/content/${OWN_CONTENT_WRITE}/comments`)
        .send({ text: 'no auth' })
        .expect(401);
    });
  });

  describe('POST/DELETE /content/:id/comments/:commentId/like', () => {
    // OWN_COMMENT_PARENT (on the write fixture) rather than a comment on
    // OWN_CONTENT_READ: the GET describe block above asserts exact totals
    // and list membership for that content, and liking never touches either,
    // but keeping every mutation on the write fixture is the one rule this
    // whole file follows (see the fixtures' own doc comment).
    afterEach(async () => {
      await prisma.commentLike.deleteMany({
        where: { commentId: OWN_COMMENT_PARENT },
      });
      await prisma.comment.update({
        where: { id: OWN_COMMENT_PARENT },
        data: { likes: 0 },
      });
    });

    it('likes a comment: increments likes and reports likedByMe (200)', async () => {
      const res = await request(app.getHttpServer())
        .post(
          `/content/${OWN_CONTENT_WRITE}/comments/${OWN_COMMENT_PARENT}/like`,
        )
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);

      expect(res.body.data).toEqual({ likes: 1, likedByMe: true });

      const stored = await prisma.comment.findUniqueOrThrow({
        where: { id: OWN_COMMENT_PARENT },
      });
      expect(stored.likes).toBe(1);
    });

    it('is idempotent: liking an already-liked comment does not double the count', async () => {
      await request(app.getHttpServer())
        .post(
          `/content/${OWN_CONTENT_WRITE}/comments/${OWN_COMMENT_PARENT}/like`,
        )
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);

      const res = await request(app.getHttpServer())
        .post(
          `/content/${OWN_CONTENT_WRITE}/comments/${OWN_COMMENT_PARENT}/like`,
        )
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);

      expect(res.body.data).toEqual({ likes: 1, likedByMe: true });
    });

    it('unlikes a comment: decrements likes back down', async () => {
      await request(app.getHttpServer())
        .post(
          `/content/${OWN_CONTENT_WRITE}/comments/${OWN_COMMENT_PARENT}/like`,
        )
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);

      const res = await request(app.getHttpServer())
        .delete(
          `/content/${OWN_CONTENT_WRITE}/comments/${OWN_COMMENT_PARENT}/like`,
        )
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);

      expect(res.body.data).toEqual({ likes: 0, likedByMe: false });
    });

    it('is idempotent: unliking a comment nobody has liked does not go negative', async () => {
      const res = await request(app.getHttpServer())
        .delete(
          `/content/${OWN_CONTENT_WRITE}/comments/${OWN_COMMENT_PARENT}/like`,
        )
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);

      expect(res.body.data).toEqual({ likes: 0, likedByMe: false });
    });

    it('404s when the comment does not belong to the given content', async () => {
      await request(app.getHttpServer())
        .post(
          `/content/${OWN_CONTENT_READ}/comments/${OWN_COMMENT_PARENT}/like`,
        )
        .set('Authorization', `Bearer ${userToken}`)
        .expect(404);
    });

    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer())
        .post(
          `/content/${OWN_CONTENT_WRITE}/comments/${OWN_COMMENT_PARENT}/like`,
        )
        .expect(401);
    });

    it('reflects likedByMe on the list read for the liking user only', async () => {
      await request(app.getHttpServer())
        .post(
          `/content/${OWN_CONTENT_WRITE}/comments/${OWN_COMMENT_PARENT}/like`,
        )
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);

      const asLiker = await request(app.getHttpServer())
        .get(`/content/${OWN_CONTENT_WRITE}/comments`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);
      const likerRow = asLiker.body.data.find(
        (c: { id: string }) => c.id === OWN_COMMENT_PARENT,
      );
      expect(likerRow.likedByMe).toBe(true);

      const asOther = await request(app.getHttpServer())
        .get(`/content/${OWN_CONTENT_WRITE}/comments`)
        .set('Authorization', `Bearer ${creatorToken}`)
        .expect(200);
      const otherRow = asOther.body.data.find(
        (c: { id: string }) => c.id === OWN_COMMENT_PARENT,
      );
      expect(otherRow.likedByMe).toBe(false);
    });
  });
});
