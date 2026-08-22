// Run against wawu_hub_test (set DATABASE_URL before invoking jest, per the
// build brief) — same convention as every other contract spec.
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
 * Community images — the room's own picture, and photos posted inside it.
 *
 * `Community` was (id, name, description, hostWawuId, kind) with no image
 * column, and `CommunityMessage` carried only `text`, so a member could never
 * post a photo in a community about fashion, food, crafts, art or beauty.
 * This spec pins the columns, who may set them, and — the part that decides
 * whether the credit COUNT stays predictable — what a photo costs.
 *
 * Every identity, community and credits row below is registered/created by
 * this spec and deleted in afterAll. Nothing here touches the three shared
 * seeded accounts, whose tier, balance and account type other specs mutate
 * (README § Why not parallel).
 */

const MOCK_WAWU_ID_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_WAWU_ID_BASE = `http://localhost:${MOCK_WAWU_ID_PORT}`;

// Storage hands back URLs on the configured bucket host; any absolute URL is
// the same thing to the API, which stores what it validated.
const IMAGE_A = 'https://storage.example.com/community/image/a-cover.jpg';
const IMAGE_B = 'https://storage.example.com/community/image/b-cover.webp';
const MESSAGE_IMAGE =
  'https://storage.example.com/community/message/a-photo.png';

/** Names this spec asks the API to create — swept in afterAll. */
const CREATED_COMMUNITY_NAMES = [
  'TEST IMAGES: Room With A Picture',
  'TEST IMAGES: Room Without A Picture',
];

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
      fullName: `Community Image Spec ${label}`,
      email: `community-image-spec-${label}-${nonce}@test.wawu.dev`,
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

describe('Community images (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mockWawuId: ChildProcess | undefined;
  let ownedMockWawuId = false;

  // The host of everything this spec creates, and a second paid creator who
  // hosts nothing here — the one whose PATCH must be refused.
  let hostToken: string;
  let hostSub: string;
  let otherCreatorToken: string;
  let otherCreatorSub: string;

  const ownedSubs: string[] = [];
  const createdCommunityIds: string[] = [];

  /** Sets this spec's own host balance. Never a seeded row. */
  const setHostCredits = async (creditBalance: number) => {
    await prisma.creditsState.upsert({
      where: { userWawuId: hostSub },
      update: {
        creditBalance,
        // Trial deliberately EXPIRED: a trial-covered send does not debit a
        // balance, and this spec is about what a message actually costs.
        trialEndsAt: new Date(Date.now() - 60_000),
      },
      create: {
        userWawuId: hostSub,
        creditBalance,
        trialEndsAt: new Date(Date.now() - 60_000),
      },
    });
  };

  const balanceOf = async (userWawuId: string): Promise<number | undefined> =>
    (
      await prisma.creditsState.findUnique({ where: { userWawuId } })
    )?.creditBalance;

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
    const other = await registerThrowawayIdentity('other');
    hostToken = host.accessToken;
    hostSub = host.sub;
    otherCreatorToken = other.accessToken;
    otherCreatorSub = other.sub;
    ownedSubs.push(host.sub, other.sub);

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        CommunityModule,
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

    // Both are paid creators with KYC still pending — hosting is gated on the
    // subscription, never on KYC (CLAUDE.md: the two gates are independent).
    for (const sub of ownedSubs) {
      await prisma.userProfile.upsert({
        where: { wawuUserId: sub },
        update: { accountType: 'creator' },
        create: {
          wawuUserId: sub,
          accountType: 'creator',
          bio: 'Fixture for community-image.contract.spec.ts.',
          interests: [],
        },
      });
      await prisma.creatorState.upsert({
        where: { wawuUserId: sub },
        update: { tier: 'basic', subscriptionPaid: true },
        create: {
          wawuUserId: sub,
          tier: 'basic',
          subscriptionPaid: true,
          kycStatus: 'pending',
          slotsUsed: 0,
          dmPrice: null,
          dmEnabled: false,
        },
      });
    }
  }, 30000);

  afterAll(async () => {
    // Deleting a Community cascades onto CommunityMessage AND CreditSpend
    // (schema: onDelete Cascade on both), so the messages and ledger rows
    // this spec wrote go with it. The name sweep catches a row created by a
    // request whose assertion failed before the id was recorded.
    if (createdCommunityIds.length > 0) {
      await prisma.community.deleteMany({
        where: { id: { in: createdCommunityIds } },
      });
    }
    await prisma.community.deleteMany({
      where: { name: { in: CREATED_COMMUNITY_NAMES } },
    });
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
      await prisma.userProfile.deleteMany({
        where: { wawuUserId: { in: ownedSubs } },
      });
    }
    await app?.close();
    if (ownedMockWawuId && mockWawuId) {
      mockWawuId.kill();
    }
  });

  /** Creates a community as this spec's host and records it for teardown. */
  const createCommunity = async (body: Record<string, unknown>) => {
    const res = await request(app.getHttpServer())
      .post('/communities')
      .set('Authorization', `Bearer ${hostToken}`)
      .send(body);
    if (res.body?.data?.id) createdCommunityIds.push(res.body.data.id);
    return res;
  };

  describe('POST /communities — the room gets a picture', () => {
    it('stores the image sent at creation and returns it on the community', async () => {
      const res = await createCommunity({
        name: 'TEST IMAGES: Room With A Picture',
        description: 'A room that actually looks like something.',
        kind: 'open',
        imageUrl: IMAGE_A,
      });

      expect([200, 201]).toContain(res.status);
      expect(res.body.data).toMatchObject({
        name: 'TEST IMAGES: Room With A Picture',
        hostWawuId: hostSub,
        kind: 'open',
        imageUrl: IMAGE_A,
      });

      const stored = await prisma.community.findUnique({
        where: { id: res.body.data.id },
      });
      expect(stored?.imageUrl).toBe(IMAGE_A);
    });

    it('leaves imageUrl null when none is sent — a room without a picture is normal', async () => {
      const res = await createCommunity({
        name: 'TEST IMAGES: Room Without A Picture',
        description: 'The placeholder tile is the fallback, not a failure.',
        kind: 'open',
      });

      expect([200, 201]).toContain(res.status);
      expect(res.body.data.imageUrl).toBeNull();

      const stored = await prisma.community.findUnique({
        where: { id: res.body.data.id },
      });
      expect(stored?.imageUrl).toBeNull();
    });

    it('400s an imageUrl that is not a link', async () => {
      const res = await createCommunity({
        name: 'TEST IMAGES: Room With A Picture',
        description: 'Rejected before anything is stored.',
        kind: 'open',
        imageUrl: 'not-a-url',
      });

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body.message)).toContain(
        'imageUrl must be a full link',
      );
    });
  });

  describe('PATCH /communities/:id — only the host changes the picture', () => {
    let communityId: string;

    beforeAll(async () => {
      const created = await prisma.community.create({
        data: {
          name: 'TEST IMAGES: Editable Room',
          description: 'Fixture for the PATCH image tests.',
          hostWawuId: hostSub,
          kind: 'open',
          imageUrl: IMAGE_A,
        },
      });
      communityId = created.id;
      createdCommunityIds.push(created.id);
    });

    it('lets the host replace the image (200)', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/communities/${communityId}`)
        .set('Authorization', `Bearer ${hostToken}`)
        .send({ imageUrl: IMAGE_B })
        .expect(200);

      expect(res.body.data).toMatchObject({
        id: communityId,
        imageUrl: IMAGE_B,
        // An image-only edit leaves the rest of the room alone.
        name: 'TEST IMAGES: Editable Room',
        kind: 'open',
      });

      const stored = await prisma.community.findUnique({
        where: { id: communityId },
      });
      expect(stored?.imageUrl).toBe(IMAGE_B);
    });

    it('lets the host clear the image with null, back to the placeholder (200)', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/communities/${communityId}`)
        .set('Authorization', `Bearer ${hostToken}`)
        .send({ imageUrl: null })
        .expect(200);

      expect(res.body.data.imageUrl).toBeNull();

      const stored = await prisma.community.findUnique({
        where: { id: communityId },
      });
      expect(stored?.imageUrl).toBeNull();

      // Put it back for the non-host test below.
      await prisma.community.update({
        where: { id: communityId },
        data: { imageUrl: IMAGE_A },
      });
    });

    it('403s a paid creator who is not the host, and the image is untouched', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/communities/${communityId}`)
        .set('Authorization', `Bearer ${otherCreatorToken}`)
        .send({ imageUrl: IMAGE_B })
        .expect(403);

      expect(res.body.message).toBe(
        'Only the community host can edit this community.',
      );
      expect(otherCreatorSub).not.toBe(hostSub);

      const stored = await prisma.community.findUnique({
        where: { id: communityId },
      });
      expect(stored?.imageUrl).toBe(IMAGE_A);
    });
  });

  describe('POST /communities/:id/messages — a photo is a message', () => {
    let communityId: string;

    beforeAll(async () => {
      const created = await prisma.community.create({
        data: {
          name: 'TEST IMAGES: Photo Room',
          description: 'Fixture for the image-message tests.',
          hostWawuId: hostSub,
          kind: 'open',
          imageUrl: IMAGE_A,
        },
      });
      communityId = created.id;
      createdCommunityIds.push(created.id);
    });

    // The host is a member of their own community by convention
    // (CommunityMessageService.assertMember short-circuits on the host), so
    // no membership row is needed to post here.
    const send = (body: Record<string, unknown>) =>
      request(app.getHttpServer())
        .post(`/communities/${communityId}/messages`)
        .set('Authorization', `Bearer ${hostToken}`)
        .send(body);

    it('accepts an image with no text, and charges exactly 1 credit for it', async () => {
      await setHostCredits(10);

      const res = await send({ imageUrl: MESSAGE_IMAGE });
      expect([200, 201]).toContain(res.status);

      expect(res.body.data).toEqual(
        expect.objectContaining({
          communityId,
          senderWawuId: hostSub,
          text: null,
          imageUrl: MESSAGE_IMAGE,
          // The rule: 1 credit = 1 message, whatever is in it. A photo is
          // NOT priced differently — see MESSAGE_COST_IN_CREDITS.
          costInCredits: 1,
        }),
      );

      expect(await balanceOf(hostSub)).toBe(9); // 10 - 1, not 10 - anything-else

      const spend = await prisma.creditSpend.findFirst({
        where: { userWawuId: hostSub, communityId },
        orderBy: { spentAt: 'desc' },
      });
      // The ledger the host's earnings are computed from records the same 1.
      expect(spend?.creditsSpent).toBe(1);
      expect(spend?.creatorWawuId).toBe(hostSub);
    });

    it('charges the same 1 credit for text AND an image together', async () => {
      await setHostCredits(10);

      const res = await send({
        text: 'Fresh batch, this morning.',
        imageUrl: MESSAGE_IMAGE,
      });
      expect([200, 201]).toContain(res.status);

      expect(res.body.data).toEqual(
        expect.objectContaining({
          text: 'Fresh batch, this morning.',
          imageUrl: MESSAGE_IMAGE,
          costInCredits: 1,
        }),
      );
      expect(await balanceOf(hostSub)).toBe(9);
    });

    it('still stores a text-only message with a null image', async () => {
      await setHostCredits(10);

      const res = await send({ text: 'No photo on this one.' });
      expect([200, 201]).toContain(res.status);
      expect(res.body.data).toEqual(
        expect.objectContaining({
          text: 'No photo on this one.',
          imageUrl: null,
          costInCredits: 1,
        }),
      );
      expect(await balanceOf(hostSub)).toBe(9);
    });

    it('400s a message with neither text nor an image, and charges nothing for it', async () => {
      await setHostCredits(10);
      const before = await prisma.communityMessage.count({
        where: { communityId },
      });

      const res = await send({}).expect(400);
      expect(res.body.message).toBe(
        'A message needs something in it — write something, attach a photo, or both.',
      );

      // The empty message cost nobody a credit and stored nothing.
      expect(await balanceOf(hostSub)).toBe(10);
      expect(
        await prisma.communityMessage.count({ where: { communityId } }),
      ).toBe(before);
    });

    it('400s a message whose only content is whitespace', async () => {
      await setHostCredits(10);

      const res = await send({ text: '   ' }).expect(400);
      expect(res.body.data).toBeNull();
      expect(await balanceOf(hostSub)).toBe(10);
    });

    it('400s an imageUrl that is not a link', async () => {
      await setHostCredits(10);

      await send({ imageUrl: 'not-a-url' }).expect(400);
      expect(await balanceOf(hostSub)).toBe(10);
    });
  });
});
