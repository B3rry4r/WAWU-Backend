// Run against wawu_hub_test (set DATABASE_URL before invoking jest) — same
// convention as every other contract spec in this repo.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

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
import { CommunityModule } from '../community.module';
import { CommunityMessageModule } from '../../community-message/community-message.module';

/**
 * THE BUG THIS SPEC PINS.
 *
 * `POST /communities/:id/join` wrote `status: 'pending'` for a private
 * community and NOTHING in the codebase ever flipped it to `'joined'` — a
 * grep for a `'joined'` write found exactly one, on the open-community
 * branch. `CommunityMessageService.assertMember` requires
 * `status === 'joined'`, so a pending member could neither read nor post: a
 * private community was a room nobody could ever be admitted to. Private
 * hosting is open to every creator account (WAWU-Web docs/01_SPEC.md:81),
 * so it was a dead end for everybody who used it.
 *
 * The tests below therefore do not stop at "the row says joined". The
 * central one requests -> is refused a post -> is approved -> POSTS
 * SUCCESSFULLY, because the row's status was never the point; being able to
 * get into the room was. CommunityMessageModule is imported for exactly
 * that reason.
 *
 * ISOLATION. Every identity here is a throwaway WAWU ID this spec registers
 * and deletes in `afterAll`, and every community is created under a UUID
 * nothing else touches — the pattern
 * `src/community/tests/community.contract.spec.ts` moved to (README
 * § Test hygiene rules). None of the three shared seeded accounts is
 * touched, read or relied on, so this spec cannot be moved by, and cannot
 * move, anything else in the suite.
 */

// Fixture communities — fresh UUIDs, never touched by seed.ts or any other spec.
const PRIVATE_COMMUNITY = 'c2000000-0000-4000-8000-000000000001';
const OTHER_HOSTS_COMMUNITY = 'c2000000-0000-4000-8000-000000000002';
const NON_EXISTENT_COMMUNITY = 'c2000000-0000-4000-8000-00000000dead';
const STRANGER_WAWU_ID = 'c2000000-0000-4000-8000-00000000beef';

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

/**
 * A per-run-unique identity from the mock WAWU ID. The nonce keeps the
 * mock's 409-on-taken-email from firing when the server is reused across
 * runs (see community.contract.spec.ts's copy of this helper).
 */
let throwawayNonce = 0;
async function registerThrowawayIdentity(
  label: string,
): Promise<{ sub: string; accessToken: string }> {
  const nonce = `${Date.now().toString().slice(-8)}${(throwawayNonce += 1)}`;
  const res = await fetch(`${MOCK_WAWU_ID_BASE}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fullName: `Join Request Spec ${label}`,
      email: `join-request-spec-${label}-${nonce}@test.wawu.dev`,
      phone: `+2348${nonce}`,
      country: 'NG',
      password: 'not-a-real-password',
    }),
  });
  if (!res.ok) {
    throw new Error(`mock-wawu-id register failed for ${label}: ${res.status}`);
  }
  const body = (await res.json()) as {
    accessToken: string;
    user: { id: string };
  };
  return { sub: body.user.id, accessToken: body.accessToken };
}

describe('Community join requests (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mockWawuId: ChildProcess | undefined;
  let ownedMockWawuId = false;

  // The host of PRIVATE_COMMUNITY: paid Pro creator (private hosting is Pro-only).
  let hostToken: string;
  let hostSub: string;
  // A paid creator who hosts a DIFFERENT community — the "not your community" case.
  let otherHostToken: string;
  let otherHostSub: string;
  // Two plain users who ask to join, and one who never does.
  let requesterToken: string;
  let requesterSub: string;
  let requesterHandle: string;
  let secondRequesterToken: string;
  let secondRequesterSub: string;
  let bystanderToken: string;
  let bystanderSub: string;

  const ownedSubs: string[] = [];

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

    const host = await registerThrowawayIdentity('host');
    const otherHost = await registerThrowawayIdentity('otherhost');
    const requester = await registerThrowawayIdentity('requester');
    const secondRequester = await registerThrowawayIdentity('requester2');
    const bystander = await registerThrowawayIdentity('bystander');
    hostToken = host.accessToken;
    hostSub = host.sub;
    otherHostToken = otherHost.accessToken;
    otherHostSub = otherHost.sub;
    requesterToken = requester.accessToken;
    requesterSub = requester.sub;
    secondRequesterToken = secondRequester.accessToken;
    secondRequesterSub = secondRequester.sub;
    bystanderToken = bystander.accessToken;
    bystanderSub = bystander.sub;
    ownedSubs.push(
      host.sub,
      otherHost.sub,
      requester.sub,
      secondRequester.sub,
      bystander.sub,
    );

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        CommunityModule,
        // Not decoration: "the member can now POST" is the assertion that
        // proves the dead end is gone, and posting goes through this module.
        CommunityMessageModule,
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

    // `handle` is @unique — a per-run value keeps reruns from colliding.
    requesterHandle = `join_spec_${Date.now().toString().slice(-9)}`;

    await prisma.userProfile.createMany({
      data: [
        {
          wawuUserId: hostSub,
          accountType: 'creator',
          interests: [],
          bio: 'Fixture for community-join-request.contract.spec.ts.',
        },
        {
          wawuUserId: otherHostSub,
          accountType: 'creator',
          interests: [],
          bio: 'Fixture for community-join-request.contract.spec.ts.',
        },
        {
          wawuUserId: requesterSub,
          accountType: 'user',
          handle: requesterHandle,
          interests: [],
          bio: 'Fixture for community-join-request.contract.spec.ts.',
        },
        // Deliberately NO handle: the queue must return `handle: null` for a
        // requester who has never set one rather than inventing a name.
        {
          wawuUserId: secondRequesterSub,
          accountType: 'user',
          interests: [],
          bio: 'Fixture for community-join-request.contract.spec.ts.',
        },
        {
          wawuUserId: bystanderSub,
          accountType: 'user',
          interests: [],
          bio: 'Fixture for community-join-request.contract.spec.ts.',
        },
      ],
    });

    // Both creators have kycStatus 'pending' on purpose: KYC gates EARNING,
    // never hosting or moderating (CLAUDE.md — the creator gates are
    // independent).
    await prisma.creatorState.createMany({
      data: [
        {
          wawuUserId: hostSub,
          kycStatus: 'pending',
          slotsUsed: 0,
          dmEnabled: false,
        },
        {
          wawuUserId: otherHostSub,
          kycStatus: 'pending',
          slotsUsed: 0,
          dmEnabled: false,
        },
      ],
    });

    await prisma.community.createMany({
      data: [
        {
          id: PRIVATE_COMMUNITY,
          name: 'TEST: Private Room With A Door',
          description: 'Fixture — the private community host-approval flow.',
          hostWawuId: hostSub,
          kind: 'private',
        },
        {
          id: OTHER_HOSTS_COMMUNITY,
          name: 'TEST: Somebody Else Private Room',
          description: 'Fixture — a community the host under test does NOT host.',
          hostWawuId: otherHostSub,
          kind: 'private',
        },
      ],
    });
  }, 30000);

  afterAll(async () => {
    // Deleting the communities cascades onto CommunityMembership,
    // CommunityMessage and CreditSpend (schema: onDelete: Cascade on all
    // three), so the only rows left to sweep are the identities' own.
    await prisma.community.deleteMany({
      where: { id: { in: [PRIVATE_COMMUNITY, OTHER_HOSTS_COMMUNITY] } },
    });
    if (ownedSubs.length > 0) {
      await prisma.community.deleteMany({
        where: { hostWawuId: { in: ownedSubs } },
      });
      // Posting a message lazily creates a CreditsState row for the sender
      // (community-message.service.ts) — it is not cascaded by anything.
      await prisma.creditsState.deleteMany({
        where: { userWawuId: { in: ownedSubs } },
      });
      await prisma.creatorState.deleteMany({
        where: { wawuUserId: { in: ownedSubs } },
      });
      await prisma.userProfile.deleteMany({
        where: { wawuUserId: { in: ownedSubs } },
      });
    }
    await app?.close();
    if (ownedMockWawuId && mockWawuId) {
      mockWawuId.kill();
    }
  });

  /** Re-requests access, so each block can start from a known `pending` row. */
  const requestToJoin = (token: string, communityId = PRIVATE_COMMUNITY) =>
    request(app.getHttpServer())
      .post(`/communities/${communityId}/join`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

  describe('GET /communities/:id/requests', () => {
    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer())
        .get(`/communities/${PRIVATE_COMMUNITY}/requests`)
        .expect(401);
    });

    it('403s a plain (non-creator) account', async () => {
      const res = await request(app.getHttpServer())
        .get(`/communities/${PRIVATE_COMMUNITY}/requests`)
        .set('Authorization', `Bearer ${bystanderToken}`)
        .expect(403);

      expect(res.body.message).toBe(
        'This endpoint is only available to creator accounts.',
      );
    });

    it('403s a creator who is not the host of THIS community', async () => {
      const res = await request(app.getHttpServer())
        .get(`/communities/${PRIVATE_COMMUNITY}/requests`)
        .set('Authorization', `Bearer ${otherHostToken}`)
        .expect(403);

      expect(res.body.message).toBe(
        'Only the community host can review join requests for this community.',
      );
    });

    it('403s the host asking about a community they do NOT host', async () => {
      const res = await request(app.getHttpServer())
        .get(`/communities/${OTHER_HOSTS_COMMUNITY}/requests`)
        .set('Authorization', `Bearer ${hostToken}`)
        .expect(403);

      expect(res.body.message).toBe(
        'Only the community host can review join requests for this community.',
      );
    });

    it('404s a community that does not exist', async () => {
      await request(app.getHttpServer())
        .get(`/communities/${NON_EXISTENT_COMMUNITY}/requests`)
        .set('Authorization', `Bearer ${hostToken}`)
        .expect(404);
    });

    it('400s a malformed community id', async () => {
      await request(app.getHttpServer())
        .get('/communities/not-a-uuid/requests')
        .set('Authorization', `Bearer ${hostToken}`)
        .expect(400);
    });

    it('lists pending requests oldest-first, with the requester handle (null when unset)', async () => {
      await requestToJoin(requesterToken);
      await requestToJoin(secondRequesterToken);

      const res = await request(app.getHttpServer())
        .get(`/communities/${PRIVATE_COMMUNITY}/requests`)
        .set('Authorization', `Bearer ${hostToken}`)
        .expect(200);

      expect(res.body.pagination).toEqual({
        currentPage: 1,
        nextPage: null,
        perPage: 20,
        total: 2,
      });
      expect(res.body.data).toHaveLength(2);
      // FIFO on `requestedAt` — the column this feature added, because a
      // pending row's `joinedAt` is null and there was nothing else to
      // order a queue by.
      expect(res.body.data.map((r: { userWawuId: string }) => r.userWawuId)).toEqual([
        requesterSub,
        secondRequesterSub,
      ]);
      expect(res.body.data[0]).toMatchObject({
        userWawuId: requesterSub,
        communityId: PRIVATE_COMMUNITY,
        status: 'pending',
        joinedAt: null,
        handle: requesterHandle,
      });
      expect(res.body.data[0].requestedAt).toEqual(expect.any(String));
      expect(res.body.data[1].handle).toBeNull();
    });
  });

  describe('POST /communities/:id/requests/:userWawuId/approve', () => {
    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer())
        .post(
          `/communities/${PRIVATE_COMMUNITY}/requests/${requesterSub}/approve`,
        )
        .expect(401);
    });

    it('403s a creator who is not the host', async () => {
      await requestToJoin(requesterToken);

      const res = await request(app.getHttpServer())
        .post(
          `/communities/${PRIVATE_COMMUNITY}/requests/${requesterSub}/approve`,
        )
        .set('Authorization', `Bearer ${otherHostToken}`)
        .expect(403);

      expect(res.body.message).toBe(
        'Only the community host can review join requests for this community.',
      );

      // Refused, not quietly applied.
      const row = await prisma.communityMembership.findUnique({
        where: {
          userWawuId_communityId: {
            userWawuId: requesterSub,
            communityId: PRIVATE_COMMUNITY,
          },
        },
      });
      expect(row).toMatchObject({ status: 'pending', joinedAt: null });
    });

    it('403s a plain (non-creator) account', async () => {
      await request(app.getHttpServer())
        .post(
          `/communities/${PRIVATE_COMMUNITY}/requests/${requesterSub}/approve`,
        )
        .set('Authorization', `Bearer ${bystanderToken}`)
        .expect(403);
    });

    it('404s a user who never requested to join', async () => {
      const res = await request(app.getHttpServer())
        .post(
          `/communities/${PRIVATE_COMMUNITY}/requests/${STRANGER_WAWU_ID}/approve`,
        )
        .set('Authorization', `Bearer ${hostToken}`)
        .expect(404);

      expect(res.body.message).toBe(
        'No join request from this user for this community.',
      );

      // An approve must never CONJURE a membership for someone who never asked.
      const row = await prisma.communityMembership.findUnique({
        where: {
          userWawuId_communityId: {
            userWawuId: STRANGER_WAWU_ID,
            communityId: PRIVATE_COMMUNITY,
          },
        },
      });
      expect(row).toBeNull();
    });

    /**
     * THE DEAD END, END TO END. This is the test the whole change exists
     * for: not "the status column says joined" but "the person who asked
     * can now actually be in the room".
     */
    it('approves a pending request — and the member, refused a post a moment earlier, can now post', async () => {
      await requestToJoin(requesterToken);

      // Before approval: pending is NOT membership. This is the dead end.
      const refused = await request(app.getHttpServer())
        .post(`/communities/${PRIVATE_COMMUNITY}/messages`)
        .set('Authorization', `Bearer ${requesterToken}`)
        .send({ text: 'Let me in?' })
        .expect(403);
      expect(refused.body.message).toBe(
        'Join this community to read or post in it.',
      );

      const before = await request(app.getHttpServer())
        .get(`/communities/${PRIVATE_COMMUNITY}`)
        .set('Authorization', `Bearer ${hostToken}`)
        .expect(200);
      expect(before.body.data.memberCount).toBe(0);

      const approved = await request(app.getHttpServer())
        .post(
          `/communities/${PRIVATE_COMMUNITY}/requests/${requesterSub}/approve`,
        )
        .set('Authorization', `Bearer ${hostToken}`)
        .expect(200);

      expect(approved.body.data).toMatchObject({
        userWawuId: requesterSub,
        communityId: PRIVATE_COMMUNITY,
        status: 'joined',
      });
      // `joinedAt` is stamped at APPROVAL, not at request time — a private
      // member was not a member while they were waiting.
      expect(approved.body.data.joinedAt).not.toBeNull();

      // After approval: the room opens. Reading first...
      await request(app.getHttpServer())
        .get(`/communities/${PRIVATE_COMMUNITY}/messages`)
        .set('Authorization', `Bearer ${requesterToken}`)
        .expect(200);

      // ...then posting, which is what the host is actually selling.
      const posted = await request(app.getHttpServer())
        .post(`/communities/${PRIVATE_COMMUNITY}/messages`)
        .set('Authorization', `Bearer ${requesterToken}`)
        .send({ text: 'Thanks for letting me in.' });
      expect([200, 201]).toContain(posted.status);
      expect(posted.body.data).toMatchObject({
        communityId: PRIVATE_COMMUNITY,
        senderWawuId: requesterSub,
        text: 'Thanks for letting me in.',
      });

      // The derived memberCount now counts them.
      const after = await request(app.getHttpServer())
        .get(`/communities/${PRIVATE_COMMUNITY}`)
        .set('Authorization', `Bearer ${hostToken}`)
        .expect(200);
      expect(after.body.data.memberCount).toBe(1);

      // ...and they are off the queue.
      const queue = await request(app.getHttpServer())
        .get(`/communities/${PRIVATE_COMMUNITY}/requests`)
        .set('Authorization', `Bearer ${hostToken}`)
        .expect(200);
      expect(
        queue.body.data.some(
          (r: { userWawuId: string }) => r.userWawuId === requesterSub,
        ),
      ).toBe(false);
    });

    it('is a no-op on an already-joined row: same joinedAt, no second row, no error', async () => {
      // Left `joined` by the test above.
      const first = await request(app.getHttpServer())
        .post(
          `/communities/${PRIVATE_COMMUNITY}/requests/${requesterSub}/approve`,
        )
        .set('Authorization', `Bearer ${hostToken}`)
        .expect(200);

      const second = await request(app.getHttpServer())
        .post(
          `/communities/${PRIVATE_COMMUNITY}/requests/${requesterSub}/approve`,
        )
        .set('Authorization', `Bearer ${hostToken}`)
        .expect(200);

      expect(second.body.data).toEqual(first.body.data);
      expect(second.body.data.status).toBe('joined');

      const rows = await prisma.communityMembership.findMany({
        where: { userWawuId: requesterSub, communityId: PRIVATE_COMMUNITY },
      });
      expect(rows).toHaveLength(1);
      // Re-approving must not rewrite "member since".
      expect(rows[0].joinedAt?.toISOString()).toBe(first.body.data.joinedAt);
    });
  });

  describe('DELETE /communities/:id/requests/:userWawuId (decline)', () => {
    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer())
        .delete(
          `/communities/${PRIVATE_COMMUNITY}/requests/${secondRequesterSub}`,
        )
        .expect(401);
    });

    it('403s a creator who is not the host, leaving the request pending', async () => {
      const res = await request(app.getHttpServer())
        .delete(
          `/communities/${PRIVATE_COMMUNITY}/requests/${secondRequesterSub}`,
        )
        .set('Authorization', `Bearer ${otherHostToken}`)
        .expect(403);

      expect(res.body.message).toBe(
        'Only the community host can review join requests for this community.',
      );

      const row = await prisma.communityMembership.findUnique({
        where: {
          userWawuId_communityId: {
            userWawuId: secondRequesterSub,
            communityId: PRIVATE_COMMUNITY,
          },
        },
      });
      expect(row).toMatchObject({ status: 'pending' });
    });

    /**
     * DECLINE DELETES THE ROW rather than storing a third `declined` status
     * (which the MembershipStatus enum does not have and which would have
     * needed a migration). See CommunityService.declineJoinRequest for the
     * full reasoning; the two consequences are pinned here so the semantics
     * are a contract and not an implementation detail: the row is GONE, and
     * the declined user may ask again.
     */
    it('declines a pending request: the row is deleted, the queue clears, and the user is not a member', async () => {
      const res = await request(app.getHttpServer())
        .delete(
          `/communities/${PRIVATE_COMMUNITY}/requests/${secondRequesterSub}`,
        )
        .set('Authorization', `Bearer ${hostToken}`)
        .expect(200);

      expect(res.body.data).toEqual({ declined: true });

      const row = await prisma.communityMembership.findUnique({
        where: {
          userWawuId_communityId: {
            userWawuId: secondRequesterSub,
            communityId: PRIVATE_COMMUNITY,
          },
        },
      });
      expect(row).toBeNull();

      const membership = await request(app.getHttpServer())
        .get(`/communities/${PRIVATE_COMMUNITY}/membership`)
        .set('Authorization', `Bearer ${secondRequesterToken}`)
        .expect(200);
      expect(membership.body.data).toBeNull();

      await request(app.getHttpServer())
        .post(`/communities/${PRIVATE_COMMUNITY}/messages`)
        .set('Authorization', `Bearer ${secondRequesterToken}`)
        .send({ text: 'Still out here.' })
        .expect(403);

      const queue = await request(app.getHttpServer())
        .get(`/communities/${PRIVATE_COMMUNITY}/requests`)
        .set('Authorization', `Bearer ${hostToken}`)
        .expect(200);
      expect(
        queue.body.data.some(
          (r: { userWawuId: string }) => r.userWawuId === secondRequesterSub,
        ),
      ).toBe(false);
    });

    it('is idempotent: declining someone with no request succeeds, changing nothing', async () => {
      const res = await request(app.getHttpServer())
        .delete(
          `/communities/${PRIVATE_COMMUNITY}/requests/${secondRequesterSub}`,
        )
        .set('Authorization', `Bearer ${hostToken}`)
        .expect(200);

      expect(res.body.data).toEqual({ declined: true });
    });

    it('lets a declined user request again — the documented cost of not storing a "declined" state', async () => {
      const res = await requestToJoin(secondRequesterToken);
      expect(res.body.data).toMatchObject({
        userWawuId: secondRequesterSub,
        status: 'pending',
      });

      // Tidy up so the removal block below starts from a known queue.
      await request(app.getHttpServer())
        .delete(
          `/communities/${PRIVATE_COMMUNITY}/requests/${secondRequesterSub}`,
        )
        .set('Authorization', `Bearer ${hostToken}`)
        .expect(200);
    });

    it('409s rather than ejecting someone who is already a member (a stale queue must not remove people)', async () => {
      const res = await request(app.getHttpServer())
        .delete(`/communities/${PRIVATE_COMMUNITY}/requests/${requesterSub}`)
        .set('Authorization', `Bearer ${hostToken}`)
        .expect(409);

      expect(res.body.message).toBe(
        'That request was already approved — this person is a member. Remove them instead.',
      );

      const row = await prisma.communityMembership.findUnique({
        where: {
          userWawuId_communityId: {
            userWawuId: requesterSub,
            communityId: PRIVATE_COMMUNITY,
          },
        },
      });
      expect(row).toMatchObject({ status: 'joined' });
    });
  });

  describe('DELETE /communities/:id/members/:userWawuId (remove)', () => {
    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer())
        .delete(`/communities/${PRIVATE_COMMUNITY}/members/${requesterSub}`)
        .expect(401);
    });

    it('403s a creator who is not the host, leaving the member in place', async () => {
      const res = await request(app.getHttpServer())
        .delete(`/communities/${PRIVATE_COMMUNITY}/members/${requesterSub}`)
        .set('Authorization', `Bearer ${otherHostToken}`)
        .expect(403);

      expect(res.body.message).toBe(
        'Only the community host can remove members from this community.',
      );

      const row = await prisma.communityMembership.findUnique({
        where: {
          userWawuId_communityId: {
            userWawuId: requesterSub,
            communityId: PRIVATE_COMMUNITY,
          },
        },
      });
      expect(row).toMatchObject({ status: 'joined' });
    });

    it('400s the host trying to remove themselves', async () => {
      const res = await request(app.getHttpServer())
        .delete(`/communities/${PRIVATE_COMMUNITY}/members/${hostSub}`)
        .set('Authorization', `Bearer ${hostToken}`)
        .expect(400);

      expect(res.body.message).toBe(
        'The host cannot be removed from their own community.',
      );
    });

    it('removes a joined member: they lose access and stop counting, and may request again', async () => {
      const res = await request(app.getHttpServer())
        .delete(`/communities/${PRIVATE_COMMUNITY}/members/${requesterSub}`)
        .set('Authorization', `Bearer ${hostToken}`)
        .expect(200);

      expect(res.body.data).toEqual({ removed: true });

      await request(app.getHttpServer())
        .post(`/communities/${PRIVATE_COMMUNITY}/messages`)
        .set('Authorization', `Bearer ${requesterToken}`)
        .send({ text: 'Back so soon?' })
        .expect(403);

      const community = await request(app.getHttpServer())
        .get(`/communities/${PRIVATE_COMMUNITY}`)
        .set('Authorization', `Bearer ${hostToken}`)
        .expect(200);
      expect(community.body.data.memberCount).toBe(0);

      // Removal returns them to "not a member" — the same state a decline
      // leaves, so re-requesting works identically.
      const again = await requestToJoin(requesterToken);
      expect(again.body.data).toMatchObject({ status: 'pending' });
    });

    it('is idempotent: removing someone who is not in the community succeeds', async () => {
      const res = await request(app.getHttpServer())
        .delete(`/communities/${PRIVATE_COMMUNITY}/members/${bystanderSub}`)
        .set('Authorization', `Bearer ${hostToken}`)
        .expect(200);

      expect(res.body.data).toEqual({ removed: true });
    });
  });
});
