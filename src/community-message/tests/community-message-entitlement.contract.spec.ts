// Run against the caller's own test database (set DATABASE_URL before
// invoking jest, per the build brief) — same convention as every other
// contract spec.
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
import { CommunityMessageModule } from '../community-message.module';

/**
 * WHO PAYS TO POST IN A COMMUNITY.
 *
 * `CommunityMessageService` debited 1 credit from every sender, including the
 * HOST — who was charged for posting in their own community and could be 402'd
 * out of it, while being the party who earns 85% of the credits spent in that
 * same room (docs/01_SPEC.md §1, stream 4). That is the one exemption, and
 * this spec pins it.
 *
 * A second exemption used to sit beside it: a paid subscription bought a
 * creator unlimited messages in OPEN communities. Subscriptions are gone, so
 * a creator is now an ordinary sender and pays like one. The tests below pin
 * that too, because silently keeping a free send alive for a plan nobody
 * holds would take money out of every host's ledger.
 *
 * It also pins what must NOT change: an ordinary sender pays 1 credit and
 * still hits the 402 wall at zero, and the ledger (`CreditSpend`, which a
 * host's earnings are computed from) gains a row if and only if a credit was
 * actually charged.
 *
 * Every identity, community, membership and credits row below is created by
 * this spec and deleted in afterAll. Nothing here touches the three shared
 * seeded accounts, whose balance other specs mutate (README § Why
 * not parallel).
 */

const MOCK_WAWU_ID_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_WAWU_ID_BASE = `http://localhost:${MOCK_WAWU_ID_PORT}`;

// LEGACY COLUMN. The 7-day free credits trial was removed on 21 Sep 2026, so
// `CreditsState.trialEndsAt` is never written and never read. Rows seeded here
// leave it null, which is what a real row looks like now. The one exception is
// the regression test at the bottom of this file, which plants a FUTURE date on
// purpose to prove the gate ignores it.
const FUTURE_TRIAL_END = () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

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

let throwawayNonce = 0;
async function registerThrowawayIdentity(
  label: string,
): Promise<{ sub: string; accessToken: string }> {
  const nonce = `${Date.now().toString().slice(-8)}${(throwawayNonce += 1)}`;
  const res = await fetch(`${MOCK_WAWU_ID_BASE}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fullName: `Message Entitlement Spec ${label}`,
      email: `msg-entitlement-${label}-${nonce}@test.wawu.dev`,
      phone: `+2347${nonce}`,
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

describe('CommunityMessage entitlements (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mockWawuId: ChildProcess | undefined;
  let ownedMockWawuId = false;

  /** Hosts both rooms below. Creator account. */
  let hostSub: string;
  let hostToken: string;
  /** Creator account, member of both rooms, hosts nothing. */
  let subscriberSub: string;
  let subscriberToken: string;
  /** A second creator account, member of both rooms, hosts nothing. */
  let lapsedSub: string;
  let lapsedToken: string;
  /** Plain user, no CreatorState at all. Member of both rooms. */
  let plainSub: string;
  let plainToken: string;

  const ownedSubs: string[] = [];
  const createdCommunityIds: string[] = [];

  let openRoomId: string;
  let privateRoomId: string;

  const setCredits = async (
    userWawuId: string,
    creditBalance: number,
    trialEndsAt: Date | null = null,
  ) => {
    await prisma.creditsState.upsert({
      where: { userWawuId },
      update: { creditBalance, trialEndsAt },
      create: { userWawuId, creditBalance, trialEndsAt },
    });
  };

  const balanceOf = async (userWawuId: string): Promise<number | undefined> =>
    (await prisma.creditsState.findUnique({ where: { userWawuId } }))
      ?.creditBalance;

  const spendCount = (userWawuId: string, communityId: string) =>
    prisma.creditSpend.count({ where: { userWawuId, communityId } });

  const post = (communityId: string, token: string, text: string) =>
    request(app.getHttpServer())
      .post(`/communities/${communityId}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ text });

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
    const subscriber = await registerThrowawayIdentity('subscriber');
    const lapsed = await registerThrowawayIdentity('lapsed');
    const plain = await registerThrowawayIdentity('plain');
    hostSub = host.sub;
    hostToken = host.accessToken;
    subscriberSub = subscriber.sub;
    subscriberToken = subscriber.accessToken;
    lapsedSub = lapsed.sub;
    lapsedToken = lapsed.accessToken;
    plainSub = plain.sub;
    plainToken = plain.accessToken;
    ownedSubs.push(hostSub, subscriberSub, lapsedSub, plainSub);

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
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

    // Creator accounts, KYC still pending: KYC gates EARNING, never sending
    // (CLAUDE.md). Having a CreatorState row must buy nothing here — that is
    // the point of the tests below.
    for (const sub of [hostSub, subscriberSub, lapsedSub]) {
      await prisma.creatorState.upsert({
        where: { wawuUserId: sub },
        update: { kycStatus: 'pending' },
        create: {
          wawuUserId: sub,
          kycStatus: 'pending',
          slotsUsed: 0,
        },
      });
    }
    // `plainSub` deliberately gets no CreatorState row at all.

    const openRoom = await prisma.community.create({
      data: {
        name: 'TEST ENTITLEMENT: Open Room',
        description:
          'Fixture for community-message-entitlement.contract.spec.ts.',
        hostWawuId: hostSub,
        kind: 'open',
      },
    });
    openRoomId = openRoom.id;
    const privateRoom = await prisma.community.create({
      data: {
        name: 'TEST ENTITLEMENT: Private Room',
        description:
          'Fixture for community-message-entitlement.contract.spec.ts.',
        hostWawuId: hostSub,
        kind: 'private',
      },
    });
    privateRoomId = privateRoom.id;
    createdCommunityIds.push(openRoomId, privateRoomId);

    // Everyone but the host is an approved member of both rooms. (The host
    // holds access via Community.hostWawuId, not a membership row —
    // host-implies-member, see CommunityService.create.)
    for (const sub of [subscriberSub, lapsedSub, plainSub]) {
      for (const communityId of [openRoomId, privateRoomId]) {
        await prisma.communityMembership.create({
          data: {
            userWawuId: sub,
            communityId,
            status: 'joined',
            joinedAt: new Date(),
          },
        });
      }
    }
  }, 30000);

  afterAll(async () => {
    // Deleting a Community cascades onto CommunityMembership,
    // CommunityMessage AND CreditSpend (schema: onDelete Cascade on all
    // three), so everything this spec wrote inside a room goes with it.
    if (createdCommunityIds.length > 0) {
      await prisma.community.deleteMany({
        where: { id: { in: createdCommunityIds } },
      });
    }
    if (ownedSubs.length > 0) {
      await prisma.community.deleteMany({
        where: { hostWawuId: { in: ownedSubs } },
      });
      await prisma.creditsState.deleteMany({
        where: { userWawuId: { in: ownedSubs } },
      });
      await prisma.creatorState.deleteMany({
        where: { wawuUserId: { in: ownedSubs } },
      });
    }
    await app?.close();
    if (ownedMockWawuId && mockWawuId) {
      mockWawuId.kill();
    }
  });

  // -------------------------------------------------------------------
  // The host never pays in a room they host.
  // -------------------------------------------------------------------
  describe('the host of a community', () => {
    it('posts in their own OPEN community free — no debit, no ledger row, and no 402 even at zero balance', async () => {
      // The exact state that used to lock a host out of their own room.
      await setCredits(hostSub, 0);
      const spendsBefore = await spendCount(hostSub, openRoomId);

      for (const text of [
        'Welcome in.',
        'Rules are pinned.',
        'Answering all questions here.',
      ]) {
        const res = await post(openRoomId, hostToken, text);
        expect([200, 201]).toContain(res.status);
        expect(res.body.data).toEqual(
          expect.objectContaining({
            communityId: openRoomId,
            senderWawuId: hostSub,
            text,
            // The stored row says what it cost: nothing.
            costInCredits: 0,
          }),
        );
      }

      expect(await balanceOf(hostSub)).toBe(0);
      // No phantom spend rows: the host must never appear in the ledger
      // their own 85% is computed from for messages they sent free.
      expect(await spendCount(hostSub, openRoomId)).toBe(spendsBefore);
    });

    it('posts in their own PRIVATE community free too — hosting is hosting', async () => {
      await setCredits(hostSub, 0);
      const spendsBefore = await spendCount(hostSub, privateRoomId);

      const res = await post(
        privateRoomId,
        hostToken,
        'Private room, still my room.',
      );
      expect([200, 201]).toContain(res.status);
      expect(res.body.data.costInCredits).toBe(0);

      expect(await balanceOf(hostSub)).toBe(0);
      expect(await spendCount(hostSub, privateRoomId)).toBe(spendsBefore);
    });

    it('posts with no CreditsState row at all, and none is created for them', async () => {
      await prisma.creditsState.deleteMany({ where: { userWawuId: hostSub } });

      const res = await post(
        openRoomId,
        hostToken,
        'No credits row, no problem.',
      );
      expect([200, 201]).toContain(res.status);

      // The metered path lazily creates a CreditsState row. The entitled
      // path must not: sending free must not silently open a credits row for
      // a sender who never needed one.
      expect(
        await prisma.creditsState.findUnique({
          where: { userWawuId: hostSub },
        }),
      ).toBeNull();
    });
  });

  // -------------------------------------------------------------------
  // A creator who is not the host: charged, like everybody else.
  // -------------------------------------------------------------------
  describe('a creator account that does not host the room', () => {
    it('pays 1 credit per message in an OPEN community', async () => {
      // This used to be free: "unlimited messages in open communities" was a
      // paid-subscription benefit. The subscription is gone, so the exemption
      // went with it rather than being handed to every creator for nothing.
      await setCredits(subscriberSub, 3);
      const spendsBefore = await spendCount(subscriberSub, openRoomId);

      const res = await post(openRoomId, subscriberToken, 'Charged like anyone.');
      expect([200, 201]).toContain(res.status);
      expect(res.body.data.costInCredits).toBe(1);

      expect(await balanceOf(subscriberSub)).toBe(2);
      expect(await spendCount(subscriberSub, openRoomId)).toBe(spendsBefore + 1);
    });

    it('hits the same 402 wall at zero balance', async () => {
      await setCredits(lapsedSub, 0);
      const spendsBefore = await spendCount(lapsedSub, openRoomId);

      await post(openRoomId, lapsedToken, 'No balance, no send.').expect(402);

      expect(await spendCount(lapsedSub, openRoomId)).toBe(spendsBefore);
    });

    it('credits the HOST for the spend, so the room still earns', async () => {
      await setCredits(lapsedSub, 2);

      const res = await post(openRoomId, lapsedToken, 'The host earns this.');
      expect([200, 201]).toContain(res.status);

      const spend = await prisma.creditSpend.findFirst({
        where: { userWawuId: lapsedSub, communityId: openRoomId },
        orderBy: { spentAt: 'desc' },
      });
      expect(spend?.creditsSpent).toBe(1);
      expect(spend?.creatorWawuId).toBe(hostSub);
    });
  });

  // -------------------------------------------------------------------
  // Everyone else: the documented model, unchanged.
  // -------------------------------------------------------------------
  describe('an ordinary user with no creator account', () => {
    it('still pays exactly 1 credit per message, and the ledger records it against the host', async () => {
      await setCredits(plainSub, 5);

      const res = await post(openRoomId, plainToken, 'One credit, please.');
      expect([200, 201]).toContain(res.status);
      expect(res.body.data.costInCredits).toBe(1);
      expect(await balanceOf(plainSub)).toBe(4);

      const spend = await prisma.creditSpend.findFirst({
        where: { userWawuId: plainSub, communityId: openRoomId },
        orderBy: { spentAt: 'desc' },
      });
      expect(spend?.creditsSpent).toBe(1);
      expect(spend?.creatorWawuId).toBe(hostSub);
    });

    it('is still 402d at zero balance, and nothing is written', async () => {
      await setCredits(plainSub, 0);
      const spendsBefore = await spendCount(plainSub, openRoomId);
      const messagesBefore = await prisma.communityMessage.count({
        where: { communityId: openRoomId },
      });

      const res = await post(
        openRoomId,
        plainToken,
        'Should be refused.',
      ).expect(402);
      expect(res.body.data).toBeNull();
      expect(res.body.message.toLowerCase()).toEqual(
        expect.stringContaining('credit'),
      );

      expect(await balanceOf(plainSub)).toBe(0);
      expect(await spendCount(plainSub, openRoomId)).toBe(spendsBefore);
      expect(
        await prisma.communityMessage.count({
          where: { communityId: openRoomId },
        }),
      ).toBe(messagesBefore);
    });

    /**
     * INVERTED ON 21 SEP 2026. This used to read "is still covered by the
     * 7-day trial at zero balance, and that message still lands in the
     * ledger". The trial is gone, so the same fixture must now be refused.
     *
     * Kept rather than deleted, and it still plants a FUTURE trial end on
     * purpose. `CreditsState.trialEndsAt` was made nullable, not dropped, so
     * a revert could quietly restore the `trialEndsAt > now` bypass in
     * CommunityMessageService; every other test in this file leaves the
     * column null and would stay green through that. This one would not.
     */
    it('is NOT rescued by a future trialEndsAt at zero balance: 402, and nothing is written', async () => {
      await setCredits(plainSub, 0, FUTURE_TRIAL_END());
      const spendsBefore = await spendCount(plainSub, openRoomId);
      const messagesBefore = await prisma.communityMessage.count({
        where: { communityId: openRoomId },
      });

      const res = await post(openRoomId, plainToken, 'Trial-covered.').expect(
        402,
      );
      expect(res.body.data).toBeNull();
      expect(res.body.reason).toBe('insufficient_credits');

      expect(await balanceOf(plainSub)).toBe(0);
      // Nothing written: no ledger row...
      expect(await spendCount(plainSub, openRoomId)).toBe(spendsBefore);
      // ...and no message row.
      expect(
        await prisma.communityMessage.count({
          where: { communityId: openRoomId },
        }),
      ).toBe(messagesBefore);
    });
  });

  // -------------------------------------------------------------------
  // Private communities: same rule, and it always was.
  // -------------------------------------------------------------------
  describe('a PRIVATE community', () => {
    it('charges a non-host member 1 credit, exactly as an open room now does', async () => {
      await setCredits(subscriberSub, 4);
      const spendsBefore = await spendCount(subscriberSub, privateRoomId);

      const res = await post(
        privateRoomId,
        subscriberToken,
        'Paying in private.',
      );
      expect([200, 201]).toContain(res.status);
      expect(res.body.data.costInCredits).toBe(1);
      expect(await balanceOf(subscriberSub)).toBe(3);

      // The private host's 85% still has something to be computed from.
      const spend = await prisma.creditSpend.findFirst({
        where: { userWawuId: subscriberSub, communityId: privateRoomId },
        orderBy: { spentAt: 'desc' },
      });
      expect(spend?.creditsSpent).toBe(1);
      expect(spend?.creatorWawuId).toBe(hostSub);
      expect(await spendCount(subscriberSub, privateRoomId)).toBe(
        spendsBefore + 1,
      );
    });

    it('402s a non-host member at zero balance', async () => {
      await setCredits(subscriberSub, 0);

      await post(
        privateRoomId,
        subscriberToken,
        'Out of credits in private.',
      ).expect(402);
    });
  });
});
