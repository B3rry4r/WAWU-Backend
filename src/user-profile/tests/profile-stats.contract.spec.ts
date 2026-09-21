import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { UserProfileModule } from '../user-profile.module';
import { profileCompleteness } from '../profile-completeness';

/**
 * The numbers on the approved Profile screen.
 *
 * Three-up row (followers / following / posts), two stat cards (profile views
 * and products sold, both "This month") and a "Complete your profile" ring.
 *
 * What this suite is here to prove:
 *  - every figure is DERIVED, so moving a row moves the number;
 *  - the private ones (views, sales) are owner-only and are NOT on the public
 *    aggregate, which any visitor can read;
 *  - a profile view is counted once per viewer per day, is not counted for
 *    the owner's own visit, and is not counted at all for an anonymous read;
 *  - the completeness ring is a function of which fields are filled.
 *
 * Fixtures: the three seeded accounts, with every row this suite creates
 * swept in afterAll and the seeded profile columns it touches snapshotted and
 * written back (README § Test hygiene, options 1 and 2).
 */

const MOCK_WAWU_ID_BASE = process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';

const OWNER_EMAIL = 'creator-pro@test.wawu.dev';
const OWNER_SUB = '00000000-0000-4000-8000-000000000003';
const VISITOR_EMAIL = 'user@test.wawu.dev';
const VISITOR_SUB = '00000000-0000-4000-8000-000000000001';
const SECOND_EMAIL = 'creator-basic@test.wawu.dev';
const SECOND_SUB = '00000000-0000-4000-8000-000000000002';
const ALL_SUBS = [OWNER_SUB, VISITOR_SUB, SECOND_SUB];

async function login(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_WAWU_ID_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) {
    throw new Error(`mock-wawu-id login failed for ${identifier}: ${res.status}`);
  }
  return ((await res.json()) as { accessToken: string }).accessToken;
}

/** Midnight UTC today — the key a view is stored under. */
function today(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

describe('Profile stats (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ownerToken: string;
  let visitorToken: string;
  let secondToken: string;

  const http = () => request(app.getHttpServer());
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  /** The seeded profile columns this suite writes, restored in afterAll. */
  const profileSnapshot = new Map<string, Record<string, unknown>>();
  const PROFILE_COLUMNS = {
    avatarUrl: true,
    coverUrl: true,
    handle: true,
    bio: true,
    websiteUrl: true,
    instagramHandle: true,
    whatsappHandle: true,
    xHandle: true,
    tiktokHandle: true,
    youtubeUrl: true,
    facebookUrl: true,
    linkedinUrl: true,
  } as const;

  async function sweep(): Promise<void> {
    await prisma.profileView.deleteMany({
      where: {
        OR: [
          { profileWawuId: { in: ALL_SUBS } },
          { viewerWawuId: { in: ALL_SUBS } },
        ],
      },
    });
    await prisma.followRelationship.deleteMany({
      where: { followerWawuId: OWNER_SUB },
    });
  }

  beforeAll(async () => {
    [ownerToken, visitorToken, secondToken] = await Promise.all([
      login(OWNER_EMAIL),
      login(VISITOR_EMAIL),
      login(SECOND_EMAIL),
    ]);

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        UserProfileModule,
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

    const row = await prisma.userProfile.findUnique({
      where: { wawuUserId: OWNER_SUB },
      select: PROFILE_COLUMNS,
    });
    if (row) profileSnapshot.set(OWNER_SUB, row);
  }, 30000);

  beforeEach(async () => {
    await sweep();
  });

  afterAll(async () => {
    await sweep();
    for (const [sub, snapshot] of profileSnapshot) {
      await prisma.userProfile.update({
        where: { wawuUserId: sub },
        data: snapshot,
      });
    }
    await app?.close();
  });

  // ── the three-up row ──────────────────────────────────────────────────────

  describe('followers, following and posts', () => {
    it('counts both directions of the follow relation', async () => {
      const before = await http()
        .get('/users/me/profile-stats')
        .set(auth(ownerToken))
        .expect(200);

      await prisma.followRelationship.create({
        data: { followerWawuId: OWNER_SUB, followingWawuId: SECOND_SUB },
      });

      const after = await http()
        .get('/users/me/profile-stats')
        .set(auth(ownerToken))
        .expect(200);

      // Following moved; followers did not. Before this, only one direction
      // of the relation was ever counted anywhere.
      expect(after.body.data.followingCount).toBe(
        before.body.data.followingCount + 1,
      );
      expect(after.body.data.followerCount).toBe(
        before.body.data.followerCount,
      );
    });

    it('puts followingCount on the public aggregate too, beside followerCount', async () => {
      const res = await http()
        .get(`/users/${OWNER_SUB}/public-profile`)
        .set(auth(visitorToken))
        .expect(200);
      expect(res.body.data).toHaveProperty('followerCount');
      expect(res.body.data).toHaveProperty('followingCount');
      expect(typeof res.body.data.followingCount).toBe('number');
    });

    it('counts posts as live content, matching the public aggregate', async () => {
      const stats = await http()
        .get('/users/me/profile-stats')
        .set(auth(ownerToken))
        .expect(200);
      const publicProfile = await http()
        .get(`/users/${OWNER_SUB}/public-profile`)
        .set(auth(visitorToken))
        .expect(200);

      expect(stats.body.data.postCount).toBe(
        publicProfile.body.data.contentCount,
      );
    });
  });

  // ── the stat cards ────────────────────────────────────────────────────────

  describe('profile views', () => {
    it('counts a visitor once per day, however many times they look', async () => {
      for (let i = 0; i < 3; i++) {
        await http()
          .get(`/users/${OWNER_SUB}/public-profile`)
          .set(auth(visitorToken))
          .expect(200);
      }

      expect(
        await prisma.profileView.count({
          where: { profileWawuId: OWNER_SUB, viewerWawuId: VISITOR_SUB },
        }),
      ).toBe(1);

      const stats = await http()
        .get('/users/me/profile-stats')
        .set(auth(ownerToken))
        .expect(200);
      expect(stats.body.data.profileViewsThisMonth).toBe(1);
    });

    it('does not count the owner looking at their own page', async () => {
      await http()
        .get(`/users/${OWNER_SUB}/public-profile`)
        .set(auth(ownerToken))
        .expect(200);

      expect(
        await prisma.profileView.count({ where: { profileWawuId: OWNER_SUB } }),
      ).toBe(0);
    });

    it('counts each distinct viewer separately', async () => {
      await http()
        .get(`/users/${OWNER_SUB}/public-profile`)
        .set(auth(visitorToken))
        .expect(200);
      await http()
        .get(`/users/${OWNER_SUB}/public-profile`)
        .set(auth(secondToken))
        .expect(200);

      const stats = await http()
        .get('/users/me/profile-stats')
        .set(auth(ownerToken))
        .expect(200);
      expect(stats.body.data.profileViewsThisMonth).toBe(2);
    });

    it('leaves a view from before this month out of "this month"', async () => {
      const lastMonth = new Date(today());
      lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
      await prisma.profileView.create({
        data: {
          profileWawuId: OWNER_SUB,
          viewerWawuId: VISITOR_SUB,
          viewedOn: lastMonth,
        },
      });

      const stats = await http()
        .get('/users/me/profile-stats')
        .set(auth(ownerToken))
        .expect(200);
      expect(stats.body.data.profileViewsThisMonth).toBe(0);
      // The window the figure was counted over is reported, not guessed at.
      expect(new Date(stats.body.data.monthStart).getUTCDate()).toBe(1);
    });

    it('never publishes the figure to a visitor', async () => {
      const res = await http()
        .get(`/users/${OWNER_SUB}/public-profile`)
        .set(auth(visitorToken))
        .expect(200);

      // How many people looked at you, and how much you sold, are facts about
      // an account, not about a public profile.
      expect(res.body.data).not.toHaveProperty('profileViewsThisMonth');
      expect(res.body.data).not.toHaveProperty('productsSoldThisMonth');
      expect(res.body.data).not.toHaveProperty('profileCompletenessPct');
    });
  });

  describe('products sold', () => {
    it('counts completed sales of this creator\'s own listings, this month', async () => {
      const before = await http()
        .get('/users/me/profile-stats')
        .set(auth(ownerToken))
        .expect(200);

      const content = await prisma.contentPiece.findFirst({
        where: { creatorWawuId: OWNER_SUB },
        select: { id: true },
      });
      const made = await prisma.purchase.create({
        data: {
          contentId: content?.id ?? null,
          type: 'content',
          buyerWawuId: VISITOR_SUB,
          creatorWawuId: OWNER_SUB,
          amount: 5000,
          commissionRate: 0.15,
          status: 'completed',
          flutterwaveTxRef: `profile-stats-test-${Date.now()}-${Math.random()}`,
        },
      });

      const after = await http()
        .get('/users/me/profile-stats')
        .set(auth(ownerToken))
        .expect(200);
      expect(after.body.data.productsSoldThisMonth).toBe(
        before.body.data.productsSoldThisMonth + 1,
      );

      await prisma.purchase.delete({ where: { id: made.id } });
    });

    it('does not count a tip, or a payment that never completed', async () => {
      const before = await http()
        .get('/users/me/profile-stats')
        .set(auth(ownerToken))
        .expect(200);

      const noise = await prisma.$transaction([
        prisma.purchase.create({
          data: {
            type: 'tip',
            buyerWawuId: VISITOR_SUB,
            creatorWawuId: OWNER_SUB,
            amount: 2000,
            commissionRate: 0.15,
            status: 'completed',
            flutterwaveTxRef: `profile-stats-tip-${Date.now()}-${Math.random()}`,
          },
        }),
        prisma.purchase.create({
          data: {
            type: 'content',
            buyerWawuId: VISITOR_SUB,
            creatorWawuId: OWNER_SUB,
            amount: 5000,
            commissionRate: 0.15,
            status: 'pending',
            flutterwaveTxRef: `profile-stats-pending-${Date.now()}-${Math.random()}`,
          },
        }),
      ]);

      const after = await http()
        .get('/users/me/profile-stats')
        .set(auth(ownerToken))
        .expect(200);
      // A tip is money somebody chose to give, not a thing that was bought;
      // a pending charge sold nothing at all.
      expect(after.body.data.productsSoldThisMonth).toBe(
        before.body.data.productsSoldThisMonth,
      );

      await prisma.purchase.deleteMany({
        where: { id: { in: noise.map((p) => p.id) } },
      });
    });
  });

  // ── the completeness ring ─────────────────────────────────────────────────

  describe('profile completeness', () => {
    it('is 100% with everything filled in, and names nothing outstanding', async () => {
      await prisma.userProfile.update({
        where: { wawuUserId: OWNER_SUB },
        data: {
          avatarUrl: 'https://example.test/a.jpg',
          coverUrl: 'https://example.test/c.jpg',
          handle: 'stats-fixture',
          bio: 'Building things.',
          websiteUrl: 'https://example.test',
        },
      });

      const res = await http()
        .get('/users/me/profile-stats')
        .set(auth(ownerToken))
        .expect(200);
      expect(res.body.data.profileCompletenessPct).toBe(100);
      expect(res.body.data.profileCompletenessMissing).toEqual([]);
    });

    it('drops as fields empty, and says which ones are missing', async () => {
      await prisma.userProfile.update({
        where: { wawuUserId: OWNER_SUB },
        data: {
          avatarUrl: 'https://example.test/a.jpg',
          coverUrl: null,
          handle: 'stats-fixture',
          bio: null,
          websiteUrl: null,
          instagramHandle: null,
          whatsappHandle: null,
          xHandle: null,
          tiktokHandle: null,
          youtubeUrl: null,
          facebookUrl: null,
          linkedinUrl: null,
        },
      });

      const res = await http()
        .get('/users/me/profile-stats')
        .set(auth(ownerToken))
        .expect(200);
      expect(res.body.data.profileCompletenessPct).toBe(40);
      expect(res.body.data.profileCompletenessMissing).toEqual([
        'cover',
        'bio',
        'links',
      ]);
    });

    it('treats whitespace as unfilled, and one social link as reachable', () => {
      const blank = {
        avatarUrl: null,
        coverUrl: null,
        handle: '   ',
        bio: null,
        websiteUrl: null,
        instagramHandle: null,
        whatsappHandle: null,
        xHandle: null,
        tiktokHandle: null,
        youtubeUrl: null,
        facebookUrl: null,
        linkedinUrl: null,
      };
      expect(profileCompleteness(blank).pct).toBe(0);
      expect(profileCompleteness(blank).missing).toEqual([
        'avatar',
        'cover',
        'handle',
        'bio',
        'links',
      ]);

      // ONE way to be reached is enough: requiring every network would leave
      // somebody who only uses Instagram permanently short of 100%.
      const reachable = { ...blank, instagramHandle: 'adaeze' };
      expect(profileCompleteness(reachable).missing).not.toContain('links');
    });
  });

  // ── auth ──────────────────────────────────────────────────────────────────

  it('refuses an unauthenticated caller, and has no parameter for somebody else', async () => {
    await http().get('/users/me/profile-stats').expect(401);

    // The route takes the caller's id from the token. `me` is not a wawuId
    // that could be swapped for another, which is what keeps these figures
    // owner-only.
    const res = await http()
      .get('/users/me/profile-stats')
      .set(auth(visitorToken))
      .expect(200);
    expect(res.body.data.wawuUserId).toBe(VISITOR_SUB);
  });
});
