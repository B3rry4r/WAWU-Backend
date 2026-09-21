import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../../common/auth/wawu-auth.module';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { NotificationModule } from '../../../notification/notification.module';
import { VerificationReminderService } from '../../../notification/verification-reminder.service';
import { AdminAuthModule } from '../../auth/admin-auth.module';
import { AdminNotificationsModule } from '../admin-notifications.module';

/**
 * Contract tests for the admin notification campaign surface (build brief C8).
 *
 * The load-bearing assertion in this file is not that a row changed. It is
 * that an admin composes a campaign in the dashboard, dispatches it, and an
 * ORDINARY USER then sees it on the REAL, unmodified app endpoint
 * (`GET /api/hub/notifications`) with their own WAWU ID token, carrying the
 * picture and the destination the admin chose. Both halves are mounted from
 * their real modules; nothing is stubbed.
 *
 * Also proved here: the em-dash ban is enforced server-side on admin-typed
 * copy; a campaign button cannot point anywhere outside the in-app allowlist;
 * a dispatch cannot run twice; a sent campaign cannot be edited; "Offers and
 * news" is honoured and the gap between recipients and deliveries is
 * recorded; every action writes an audit row naming who and when; a reviewer
 * may compose but NOT dispatch; support may read but not write; finance is
 * refused outright; and a WAWU ID user token reaches none of it.
 *
 * And separately: B1's recurring verification prompt is a real sweep, it
 * skips verified accounts, and it does not repeat inside its interval.
 *
 * ── FIXTURE IDS ──────────────────────────────────────────────────────────────
 * This suite owns the `adc8……` admin prefix and the `c8000000-……` profile
 * prefix, deliberately NOT the `ad000000-0000-4000-8000-00000000000X` ids
 * that admin-auth, admin-events and admin-kyc-review all three already share.
 * Those three collide with each other today (they delete and recreate the
 * same four AdminUser rows), which is why the admin-events suite fails when
 * the full contract run reaches it. Reusing that prefix would have made a
 * three-way collision a four-way one.
 */

const MOCK_WAWU_ID_URL = process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';

/** Seeded WAWU ID users. The mock keys login on the identifier, not the sub. */
const CREATOR_BASIC_EMAIL = 'creator-basic@test.wawu.dev';
const CREATOR_BASIC_SUB = '00000000-0000-4000-8000-000000000002';

// ── suite-owned admin fixtures ──────────────────────────────────────────────
const ADMIN_SUPER_ID = 'adc80000-0000-4000-8000-000000000001';
const ADMIN_REVIEWER_ID = 'adc80000-0000-4000-8000-000000000002';
const ADMIN_SUPPORT_ID = 'adc80000-0000-4000-8000-000000000003';
const ADMIN_FINANCE_ID = 'adc80000-0000-4000-8000-000000000004';
const ADMIN_IDS = [ADMIN_SUPER_ID, ADMIN_REVIEWER_ID, ADMIN_SUPPORT_ID, ADMIN_FINANCE_ID];

const SUPER_EMAIL = 'c8-super@admin.test.wawu.dev';
const REVIEWER_EMAIL = 'c8-reviewer@admin.test.wawu.dev';
const SUPPORT_EMAIL = 'c8-support@admin.test.wawu.dev';
const FINANCE_EMAIL = 'c8-finance@admin.test.wawu.dev';
const PASSWORD = 'admin-notifications-contract-password';

const TEST_ACCESS_SECRET = 'admin-notif-access-secret-0123456789abcdef';
const TEST_REFRESH_SECRET = 'admin-notif-refresh-secret-0123456789abcdef';

// ── suite-owned account fixtures ────────────────────────────────────────────
/** An unverified creator who wants announcements. */
const CREATOR_OPTED_IN = 'c8000000-0000-4000-8000-000000000001';
/** An unverified creator who switched "Offers and news" off. */
const CREATOR_OPTED_OUT = 'c8000000-0000-4000-8000-000000000002';
/** A creator with an approved verification, so the reminder must skip them. */
const CREATOR_VERIFIED = 'c8000000-0000-4000-8000-000000000003';
/** A buyer, so an audience of `creators` must not reach them. */
const BUYER = 'c8000000-0000-4000-8000-000000000004';
const PROFILE_IDS = [CREATOR_OPTED_IN, CREATOR_OPTED_OUT, CREATOR_VERIFIED, BUYER];

const VERIFICATION_ROW = 'c8000000-0000-4000-8000-0000000000a1';
const UNKNOWN_CAMPAIGN = 'c8000000-0000-4000-8000-0000000000ff';

const IMAGE = 'https://picsum.photos/seed/wawu-campaign/800/450';

function validCampaign(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Bills payment is live',
    body: 'Airtime, data, electricity and TV, all inside WAWU. Pay in naira, get the token on the spot.',
    imageUrl: IMAGE,
    actionLabel: 'Pay a bill',
    actionHref: '/home',
    tone: 'accent',
    audience: 'creators',
    ...overrides,
  };
}

/**
 * The mock WAWU ID service, started if it is not already up. Same helper as
 * notification.contract.spec.ts: auth is exercised for real here, with an
 * RS256 token this backend verifies over JWKS, never a minted one.
 */
let mockWawuId: ChildProcessWithoutNullStreams | undefined;

async function ensureMockWawuIdRunning(): Promise<void> {
  const healthy = async () => {
    try {
      return (await fetch(`${MOCK_WAWU_ID_URL}/health`)).ok;
    } catch {
      return false;
    }
  };
  if (await healthy()) return;
  mockWawuId = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '../../../../mock-wawu-id'),
    env: { ...process.env, MOCK_WAWU_ID_PORT: '4001' },
    stdio: 'pipe',
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await healthy()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('mock-wawu-id did not become healthy in time');
}

async function loginToWawuId(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_WAWU_ID_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) throw new Error(`mock-wawu-id login failed for ${identifier}: ${res.status}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

describe('Admin notification campaigns contract', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let reminders: VerificationReminderService;

  let superToken: string;
  let reviewerToken: string;
  let supportToken: string;
  let financeToken: string;
  let creatorBasicToken: string;

  const envSnapshot: Record<string, string | undefined> = {};
  /**
   * The one seeded row this suite mutates, snapshotted so afterAll puts it
   * back exactly as it was (README § Test hygiene: no seeded row is left
   * changed).
   */
  let creatorBasicPromotions: boolean | undefined;

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function adminLogin(email: string): Promise<string> {
    const res = await http()
      .post('/api/hub/admin/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return res.body.data.accessToken as string;
  }

  /** Delete everything this suite could have written, in FK-safe order. */
  async function sweep(): Promise<void> {
    const campaigns = await prisma.notificationCampaign.findMany({
      where: { createdByAdminId: { in: ADMIN_IDS } },
      select: { id: true },
    });
    const campaignIds = campaigns.map((c) => c.id);
    if (campaignIds.length > 0) {
      await prisma.notification.deleteMany({ where: { campaignId: { in: campaignIds } } });
      await prisma.adminNotificationAudit.deleteMany({
        where: { campaignId: { in: campaignIds } },
      });
      await prisma.notificationCampaign.deleteMany({ where: { id: { in: campaignIds } } });
    }
    // Notifications this suite caused on accounts it does not own (the seeded
    // creators are in the `creators` audience too) and every reminder it sent.
    await prisma.notification.deleteMany({
      where: { kind: { in: ['campaign', 'verify_reminder'] } },
    });
    await prisma.verificationSubmission.deleteMany({ where: { id: VERIFICATION_ROW } });
    await prisma.notificationSettings.deleteMany({ where: { userWawuId: { in: PROFILE_IDS } } });
    await prisma.userProfile.deleteMany({ where: { wawuUserId: { in: PROFILE_IDS } } });
  }

  async function resetFixtures(): Promise<void> {
    await sweep();
    await prisma.userProfile.createMany({
      data: [
        { wawuUserId: CREATOR_OPTED_IN, accountType: 'creator' },
        { wawuUserId: CREATOR_OPTED_OUT, accountType: 'creator' },
        { wawuUserId: CREATOR_VERIFIED, accountType: 'creator' },
        { wawuUserId: BUYER, accountType: 'user' },
      ],
    });
    await prisma.notificationSettings.create({
      data: { userWawuId: CREATOR_OPTED_OUT, promotions: false },
    });
    await prisma.verificationSubmission.create({
      data: {
        id: VERIFICATION_ROW,
        wawuUserId: CREATOR_VERIFIED,
        tier: 'verified_user',
        status: 'approved',
        documents: [],
      },
    });
  }

  beforeAll(async () => {
    for (const key of ['ADMIN_JWT_SECRET', 'ADMIN_JWT_REFRESH_SECRET']) {
      envSnapshot[key] = process.env[key];
    }
    process.env.ADMIN_JWT_SECRET = TEST_ACCESS_SECRET;
    process.env.ADMIN_JWT_REFRESH_SECRET = TEST_REFRESH_SECRET;

    await ensureMockWawuIdRunning();
    creatorBasicToken = await loginToWawuId(CREATOR_BASIC_EMAIL);

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        AdminAuthModule,
        AdminNotificationsModule,
        // The REAL app-facing surface, unmodified, so "the user received it"
        // can be proved against what a user actually calls.
        WawuAuthModule,
        NotificationModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/hub');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();

    prisma = app.get(PrismaService);
    reminders = app.get(VerificationReminderService);

    const argon2 = await import('argon2');
    const passwordHash = await argon2.hash(PASSWORD);
    await prisma.adminUser.deleteMany({ where: { id: { in: ADMIN_IDS } } });
    await prisma.adminUser.deleteMany({
      where: { email: { in: [SUPER_EMAIL, REVIEWER_EMAIL, SUPPORT_EMAIL, FINANCE_EMAIL] } },
    });
    await prisma.adminUser.createMany({
      data: [
        { id: ADMIN_SUPER_ID, email: SUPER_EMAIL, passwordHash, name: 'C8 Super', role: 'superadmin' },
        { id: ADMIN_REVIEWER_ID, email: REVIEWER_EMAIL, passwordHash, name: 'C8 Reviewer', role: 'reviewer' },
        { id: ADMIN_SUPPORT_ID, email: SUPPORT_EMAIL, passwordHash, name: 'C8 Support', role: 'support' },
        { id: ADMIN_FINANCE_ID, email: FINANCE_EMAIL, passwordHash, name: 'C8 Finance', role: 'finance' },
      ],
    });

    creatorBasicPromotions = (
      await prisma.notificationSettings.findUnique({ where: { userWawuId: CREATOR_BASIC_SUB } })
    )?.promotions;

    [superToken, reviewerToken, supportToken, financeToken] = await Promise.all([
      adminLogin(SUPER_EMAIL),
      adminLogin(REVIEWER_EMAIL),
      adminLogin(SUPPORT_EMAIL),
      adminLogin(FINANCE_EMAIL),
    ]);
  }, 60_000);

  beforeEach(resetFixtures);

  afterAll(async () => {
    await sweep();
    if (creatorBasicPromotions !== undefined) {
      await prisma.notificationSettings.update({
        where: { userWawuId: CREATOR_BASIC_SUB },
        data: { promotions: creatorBasicPromotions },
      });
    }
    await prisma.adminNotificationAudit.deleteMany({
      where: { actedByAdminId: { in: ADMIN_IDS } },
    });
    await prisma.adminUser.deleteMany({ where: { id: { in: ADMIN_IDS } } });
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await app.close();
    mockWawuId?.kill();
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('who may reach this surface', () => {
    it('refuses an unauthenticated request', async () => {
      await http().get('/api/hub/admin/notifications/campaigns').expect(401);
    });

    it('refuses a WAWU ID USER token, which is a different signing key entirely', async () => {
      await http()
        .get('/api/hub/admin/notifications/campaigns')
        .set(auth(creatorBasicToken))
        .expect(401);
    });

    it('refuses finance on every route here, read and write alike', async () => {
      await http()
        .get('/api/hub/admin/notifications/campaigns')
        .set(auth(financeToken))
        .expect(403);
      await http()
        .post('/api/hub/admin/notifications/campaigns')
        .set(auth(financeToken))
        .send(validCampaign())
        .expect(403);
    });

    it('lets support READ but not compose', async () => {
      await http()
        .get('/api/hub/admin/notifications/audiences')
        .set(auth(supportToken))
        .expect(200);
      await http()
        .post('/api/hub/admin/notifications/campaigns')
        .set(auth(supportToken))
        .send(validCampaign())
        .expect(403);
    });

    it('lets a reviewer compose but NOT dispatch: sending is superadmin only', async () => {
      const composed = await http()
        .post('/api/hub/admin/notifications/campaigns')
        .set(auth(reviewerToken))
        .send(validCampaign())
        .expect(200);

      await http()
        .post(`/api/hub/admin/notifications/campaigns/${composed.body.data.id}/dispatch`)
        .set(auth(reviewerToken))
        .expect(403);

      // And nothing was sent by the attempt.
      expect(
        await prisma.notification.count({ where: { campaignId: composed.body.data.id } }),
      ).toBe(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('GET /admin/notifications/audiences', () => {
    it('reports a LIVE count per segment, not a stored figure', async () => {
      const before = await http()
        .get('/api/hub/admin/notifications/audiences')
        .set(auth(superToken))
        .expect(200);
      const creatorsBefore = before.body.data.find(
        (a: { audience: string }) => a.audience === 'creators',
      ).size;

      await prisma.userProfile.create({
        data: { wawuUserId: 'c8000000-0000-4000-8000-0000000000b1', accountType: 'creator' },
      });

      const after = await http()
        .get('/api/hub/admin/notifications/audiences')
        .set(auth(superToken))
        .expect(200);
      const creatorsAfter = after.body.data.find(
        (a: { audience: string }) => a.audience === 'creators',
      ).size;

      expect(creatorsAfter).toBe(creatorsBefore + 1);

      await prisma.userProfile.delete({
        where: { wawuUserId: 'c8000000-0000-4000-8000-0000000000b1' },
      });
    });

    it('separates how many MATCH from how many will actually receive it', async () => {
      const res = await http()
        .get('/api/hub/admin/notifications/audiences')
        .set(auth(superToken))
        .expect(200);

      const creators = res.body.data.find((a: { audience: string }) => a.audience === 'creators');
      // CREATOR_OPTED_OUT is a creator with promotions off, so the two
      // numbers must differ by at least that one account.
      expect(creators.optedIn).toBeLessThan(creators.size);
      expect(creators.label).toBe('Creators');
    });

    it('excludes a verified creator from unverified_creators', async () => {
      const res = await http()
        .get('/api/hub/admin/notifications/audiences')
        .set(auth(superToken))
        .expect(200);
      const all = res.body.data.find((a: { audience: string }) => a.audience === 'creators').size;
      const unverified = res.body.data.find(
        (a: { audience: string }) => a.audience === 'unverified_creators',
      ).size;
      expect(unverified).toBe(all - 1);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('POST /admin/notifications/campaigns (compose)', () => {
    it('composes a draft and sends NOTHING', async () => {
      const res = await http()
        .post('/api/hub/admin/notifications/campaigns')
        .set(auth(superToken))
        .send(validCampaign())
        .expect(200);

      expect(res.body.data.status).toBe('draft');
      expect(res.body.data.imageUrl).toBe(IMAGE);
      expect(res.body.data.createdByAdminEmail).toBe(SUPER_EMAIL);
      expect(res.body.data.recipientCount).toBe(0);
      expect(await prisma.notification.count({ where: { kind: 'campaign' } })).toBe(0);
    });

    it('writes an audit row naming who composed it and when', async () => {
      const res = await http()
        .post('/api/hub/admin/notifications/campaigns')
        .set(auth(superToken))
        .send(validCampaign())
        .expect(200);

      const audit = await prisma.adminNotificationAudit.findMany({
        where: { campaignId: res.body.data.id },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0].action).toBe('campaign_created');
      expect(audit[0].actedByAdminEmail).toBe(SUPER_EMAIL);
      expect(audit[0].actedByAdminRole).toBe('superadmin');
    });

    it('REFUSES an em-dash in admin-typed copy, in the title and in the body', async () => {
      await http()
        .post('/api/hub/admin/notifications/campaigns')
        .set(auth(superToken))
        .send(validCampaign({ title: 'Bills payment — now live' }))
        .expect(400);

      await http()
        .post('/api/hub/admin/notifications/campaigns')
        .set(auth(superToken))
        .send(validCampaign({ body: 'Airtime, data and TV — all inside WAWU, paid in naira.' }))
        .expect(400);
    });

    it('refuses a destination that is not an allowed in-app route', async () => {
      for (const actionHref of ['https://evil.example/login', '/not-a-screen', '//evil.example']) {
        await http()
          .post('/api/hub/admin/notifications/campaigns')
          .set(auth(superToken))
          .send(validCampaign({ actionHref }))
          .expect(400);
      }
    });

    it('refuses a button with a label and no destination, or the reverse', async () => {
      await http()
        .post('/api/hub/admin/notifications/campaigns')
        .set(auth(superToken))
        .send(validCampaign({ actionHref: undefined }))
        .expect(400);
      await http()
        .post('/api/hub/admin/notifications/campaigns')
        .set(auth(superToken))
        .send(validCampaign({ actionLabel: undefined }))
        .expect(400);
    });

    it('refuses the alarm tones a promotion has no business borrowing', async () => {
      for (const tone of ['danger', 'warning']) {
        await http()
          .post('/api/hub/admin/notifications/campaigns')
          .set(auth(superToken))
          .send(validCampaign({ tone }))
          .expect(400);
      }
    });

    it('refuses a non-https image and an undeclared property', async () => {
      await http()
        .post('/api/hub/admin/notifications/campaigns')
        .set(auth(superToken))
        .send(validCampaign({ imageUrl: 'http://example.com/a.jpg' }))
        .expect(400);
      await http()
        .post('/api/hub/admin/notifications/campaigns')
        .set(auth(superToken))
        .send(validCampaign({ sendImmediately: true }))
        .expect(400);
    });

    it('accepts a campaign with no picture and no button', async () => {
      const res = await http()
        .post('/api/hub/admin/notifications/campaigns')
        .set(auth(superToken))
        .send({
          title: 'Scheduled maintenance tonight',
          body: 'WAWU will be briefly unavailable from 1am to 2am while we move some things around.',
          audience: 'everyone',
          tone: 'info',
        })
        .expect(200);
      expect(res.body.data.imageUrl).toBeNull();
      expect(res.body.data.actionHref).toBeNull();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('POST /admin/notifications/campaigns/:id/dispatch', () => {
    async function compose(overrides: Record<string, unknown> = {}): Promise<string> {
      const res = await http()
        .post('/api/hub/admin/notifications/campaigns')
        .set(auth(superToken))
        .send(validCampaign(overrides))
        .expect(200);
      return res.body.data.id as string;
    }

    it('writes the picture, the label and the destination onto the recipient row', async () => {
      const id = await compose();

      const sent = await http()
        .post(`/api/hub/admin/notifications/campaigns/${id}/dispatch`)
        .set(auth(superToken))
        .expect(200);

      expect(sent.body.data.campaign.status).toBe('sent');
      expect(sent.body.data.deliveredCount).toBeGreaterThan(0);

      const mine = await prisma.notification.findFirst({
        where: { userWawuId: CREATOR_OPTED_IN, campaignId: id },
      });
      expect(mine).not.toBeNull();
      expect(mine!.kind).toBe('campaign');
      expect(mine!.imageUrl).toBe(IMAGE);
      expect(mine!.actionHref).toBe('/home');
      expect(mine!.actionLabel).toBe('Pay a bill');
      expect(mine!.read).toBe(false);
    });

    /**
     * The one that matters. A REAL seeded creator, signed in with a REAL
     * RS256 WAWU ID token, reading the REAL unmodified app endpoint - and the
     * switch in their own settings is what decides whether the campaign is
     * there. Both directions are asserted in one test on purpose: "they got
     * it" and "they did not get it" are only meaningful together.
     *
     * BOTH STATES ARE SET EXPLICITLY, neither is assumed.
     *
     * This used to rely on the seeded row starting at promotions=false,
     * which was the model default when the test was written. C8 flipped that
     * default to true, so on a freshly seeded database the creator now
     * receives the first campaign and the "did not get it" half failed. It
     * kept passing on developer machines whose row predated the flip, and
     * failed on every CI run from 14 September onward, blocking every deploy.
     *
     * A test about what a SWITCH does must set the switch. It has no business
     * knowing what the column defaults to.
     */
    it('an ordinary signed-in creator sees it, or does not, according to their own switch', async () => {
      // Off, stated rather than inherited.
      await prisma.notificationSettings.upsert({
        where: { userWawuId: CREATOR_BASIC_SUB },
        create: { userWawuId: CREATOR_BASIC_SUB, promotions: false },
        update: { promotions: false },
      });

      const off = await compose();
      await http()
        .post(`/api/hub/admin/notifications/campaigns/${off}/dispatch`)
        .set(auth(superToken))
        .expect(200);

      const inboxWithout = await http()
        .get('/api/hub/notifications')
        .set(auth(creatorBasicToken))
        .expect(200);
      expect(
        inboxWithout.body.data.items.data.find(
          (n: { campaignId: string | null }) => n.campaignId === off,
        ),
      ).toBeUndefined();

      // They switch "Offers and news" on.
      await prisma.notificationSettings.update({
        where: { userWawuId: CREATOR_BASIC_SUB },
        data: { promotions: true },
      });

      const on = await compose();
      await http()
        .post(`/api/hub/admin/notifications/campaigns/${on}/dispatch`)
        .set(auth(superToken))
        .expect(200);

      const inbox = await http()
        .get('/api/hub/notifications')
        .set(auth(creatorBasicToken))
        .expect(200);
      const received = inbox.body.data.items.data.find(
        (n: { campaignId: string | null }) => n.campaignId === on,
      );
      expect(received).toBeDefined();
      expect(received.title).toBe('Bills payment is live');
      expect(received.imageUrl).toBe(IMAGE);
      expect(received.actionHref).toBe('/home');
      expect(inbox.body.data.unreadCount).toBeGreaterThan(0);
    });

    it('honours "Offers and news", and records the gap rather than hiding it', async () => {
      const id = await compose();
      const sent = await http()
        .post(`/api/hub/admin/notifications/campaigns/${id}/dispatch`)
        .set(auth(superToken))
        .expect(200);

      expect(
        await prisma.notification.count({ where: { userWawuId: CREATOR_OPTED_OUT, campaignId: id } }),
      ).toBe(0);
      expect(sent.body.data.deliveredCount).toBeLessThan(sent.body.data.recipientCount);
      expect(sent.body.data.suppressedByPreference).toBe(
        sent.body.data.recipientCount - sent.body.data.deliveredCount,
      );
      expect(sent.body.data.suppressedByPreference).toBeGreaterThanOrEqual(1);
    });

    it('does not reach an account outside the segment', async () => {
      const id = await compose({ audience: 'creators' });
      await http()
        .post(`/api/hub/admin/notifications/campaigns/${id}/dispatch`)
        .set(auth(superToken))
        .expect(200);
      expect(
        await prisma.notification.count({ where: { userWawuId: BUYER, campaignId: id } }),
      ).toBe(0);
    });

    it('cannot be sent twice, and the second attempt writes no duplicate', async () => {
      const id = await compose();
      await http()
        .post(`/api/hub/admin/notifications/campaigns/${id}/dispatch`)
        .set(auth(superToken))
        .expect(200);
      const afterFirst = await prisma.notification.count({ where: { campaignId: id } });

      await http()
        .post(`/api/hub/admin/notifications/campaigns/${id}/dispatch`)
        .set(auth(superToken))
        .expect(409);

      expect(await prisma.notification.count({ where: { campaignId: id } })).toBe(afterFirst);
    });

    it('records both counts and the sender on the campaign and on the audit row', async () => {
      const id = await compose();
      const sent = await http()
        .post(`/api/hub/admin/notifications/campaigns/${id}/dispatch`)
        .set(auth(superToken))
        .expect(200);

      const row = await prisma.notificationCampaign.findUniqueOrThrow({ where: { id } });
      expect(row.dispatchedByAdminEmail).toBe(SUPER_EMAIL);
      expect(row.dispatchedAt).not.toBeNull();
      expect(row.deliveredCount).toBe(sent.body.data.deliveredCount);

      const audit = await prisma.adminNotificationAudit.findFirst({
        where: { campaignId: id, action: 'campaign_dispatched' },
      });
      expect(audit).not.toBeNull();
      expect(audit!.recipientCount).toBe(row.recipientCount);
      expect(audit!.deliveredCount).toBe(row.deliveredCount);
    });

    it('404s an unknown campaign and 400s a non-uuid id', async () => {
      await http()
        .post(`/api/hub/admin/notifications/campaigns/${UNKNOWN_CAMPAIGN}/dispatch`)
        .set(auth(superToken))
        .expect(404);
      await http()
        .post('/api/hub/admin/notifications/campaigns/not-a-uuid/dispatch')
        .set(auth(superToken))
        .expect(400);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('PATCH /admin/notifications/campaigns/:id', () => {
    it('edits a draft', async () => {
      const composed = await http()
        .post('/api/hub/admin/notifications/campaigns')
        .set(auth(superToken))
        .send(validCampaign())
        .expect(200);

      const res = await http()
        .patch(`/api/hub/admin/notifications/campaigns/${composed.body.data.id}`)
        .set(auth(reviewerToken))
        .send(validCampaign({ title: 'Bills payment is here' }))
        .expect(200);
      expect(res.body.data.title).toBe('Bills payment is here');
    });

    it('refuses to edit a SENT campaign: it is the record of what people were shown', async () => {
      const composed = await http()
        .post('/api/hub/admin/notifications/campaigns')
        .set(auth(superToken))
        .send(validCampaign())
        .expect(200);
      await http()
        .post(`/api/hub/admin/notifications/campaigns/${composed.body.data.id}/dispatch`)
        .set(auth(superToken))
        .expect(200);

      await http()
        .patch(`/api/hub/admin/notifications/campaigns/${composed.body.data.id}`)
        .set(auth(superToken))
        .send(validCampaign({ title: 'Something else entirely' }))
        .expect(400);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('B1 recurring verification prompt', () => {
    it('reminds an unverified creator and skips a verified one', async () => {
      const written = await reminders.run();
      expect(written).toBeGreaterThan(0);

      expect(
        await prisma.notification.count({
          where: { userWawuId: CREATOR_OPTED_IN, kind: 'verify_reminder' },
        }),
      ).toBe(1);
      expect(
        await prisma.notification.count({
          where: { userWawuId: CREATOR_VERIFIED, kind: 'verify_reminder' },
        }),
      ).toBe(0);
      expect(
        await prisma.notification.count({ where: { userWawuId: BUYER, kind: 'verify_reminder' } }),
      ).toBe(0);
    });

    it('opens the verification screen, and promises nothing in the future tense', async () => {
      await reminders.run();
      const row = await prisma.notification.findFirstOrThrow({
        where: { userWawuId: CREATOR_OPTED_IN, kind: 'verify_reminder' },
      });
      expect(row.actionHref).toBe('/profile/verification');
      expect(row.actionLabel).toBe('Get verified');
      expect(row.body).toMatch(/purple tick/);
      expect(row.body).not.toMatch(/—|–/);
      expect(`${row.title} ${row.body}`).not.toMatch(/we(?:'|’)?ll|we will|you(?:'|’)?ll/i);
    });

    it('does not repeat inside its interval, however often it runs', async () => {
      await reminders.run();
      const afterFirst = await prisma.notification.count({ where: { kind: 'verify_reminder' } });
      await reminders.run();
      expect(await prisma.notification.count({ where: { kind: 'verify_reminder' } })).toBe(
        afterFirst,
      );
    });

    it('reminds again once the interval has passed', async () => {
      await reminders.run();
      await prisma.notification.updateMany({
        where: { userWawuId: CREATOR_OPTED_IN, kind: 'verify_reminder' },
        data: { createdAt: new Date(Date.now() - 30 * 86_400_000) },
      });
      await reminders.run();
      expect(
        await prisma.notification.count({
          where: { userWawuId: CREATOR_OPTED_IN, kind: 'verify_reminder' },
        }),
      ).toBe(2);
    });

    it('is not silenced by the promotions switch: it is account state, not marketing', async () => {
      await reminders.run();
      expect(
        await prisma.notification.count({
          where: { userWawuId: CREATOR_OPTED_OUT, kind: 'verify_reminder' },
        }),
      ).toBe(1);
    });
  });
});
