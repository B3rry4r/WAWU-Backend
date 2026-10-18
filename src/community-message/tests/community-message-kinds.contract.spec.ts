// Run against the caller's own test database (set DATABASE_URL before
// invoking jest) - same convention as every other contract spec.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

// A bucket that exists only in this process: links are signed locally (nothing
// is sent to it), and the Hub reads this bucket's own address from them to
// tell its links from anybody else's (INBOX-22 round 2). Virtual-hosted style,
// as the real bucket is.
process.env.STORAGE_ENDPOINT = 'https://storage.test.invalid';
process.env.STORAGE_BUCKET = 'wawu-kinds-test';
process.env.STORAGE_ACCESS_KEY_ID = 'test-key';
process.env.STORAGE_SECRET_ACCESS_KEY = 'test-secret';
process.env.STORAGE_REGION = 'auto';
delete process.env.STORAGE_FORCE_PATH_STYLE;

import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { ConfigModule } from '@nestjs/config';
import { AdminRole } from '../../../generated/prisma/enums';
import type { AdminActor } from '../../common/audit/admin-ops-audit.service';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { CreditSpendService } from '../../credit-spend/credit-spend.service';
import { NotificationService } from '../../notification/notification.service';
import { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import {
  StorageService,
  type BucketLocation,
} from '../../storage/storage.service';
import { CommunityMessageModule } from '../community-message.module';
import { CommunityMessageService } from '../community-message.service';
import {
  expectLinkSignedAgain,
  moveClockForward,
  restoreClock,
} from './fresh-link';

/**
 * INBOX-22 (R-62): COMMUNITY CREDITS BY KIND OF MESSAGE.
 *
 * Text and emoji are free, a photo costs 1 credit, a video or a voice note 3
 * (the admin settings community_credit_cost_photo / _video / _voice at their
 * defaults). Credits are a count, never naira. One message is charged once
 * however many times its request is sent, a message that fails to send is not
 * charged, a sender who cannot cover a message is told the shortfall in plain
 * words and nothing is taken, and the host's 85% is computed on the credits
 * actually spent and on nothing else.
 *
 * No payment provider is involved: a credit is a row in CreditsState, a lot
 * (the cost basis of a bought pack) is a row written here, and every uploaded
 * file is a StorageObject row. Nothing here reaches a provider, a bucket or a
 * wallet. Every identity, room and row is this spec's own and is deleted in
 * afterAll.
 */

const MOCK_WAWU_ID_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_WAWU_ID_BASE = `http://localhost:${MOCK_WAWU_ID_PORT}`;

const admin: AdminActor = {
  id: randomUUID(),
  email: 'inbox22@admin.test.wawu.dev',
  role: AdminRole.finance,
};

// An en dash or an em dash, written by code so no source line carries one (R-5).
const LONG_DASH = new RegExp(
  `[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`,
);

const COST_KEYS = [
  'community_credit_cost_photo',
  'community_credit_cost_video',
  'community_credit_cost_voice',
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

let nonceCounter = 0;
async function registerIdentity(
  label: string,
): Promise<{ sub: string; accessToken: string }> {
  const nonce = `${Date.now().toString().slice(-8)}${(nonceCounter += 1)}`;
  const res = await fetch(`${MOCK_WAWU_ID_BASE}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fullName: `Message Kinds Spec ${label}`,
      email: `msg-kinds-${label}-${nonce}@test.wawu.dev`,
      phone: `+2347${nonce}`,
      country: 'NG',
      password: 'not-a-real-password',
    }),
  });
  if (!res.ok) throw new Error(`mock register failed for ${label}`);
  const body = (await res.json()) as {
    accessToken: string;
    user: { id: string };
  };
  return { sub: body.user.id, accessToken: body.accessToken };
}

/** What the Hub answers a send with (the error envelope has no data). */
interface Answer {
  data: {
    id: string;
    costInCredits: number;
    text: string | null;
    imageUrl: string | null;
    videoUrl: string | null;
    voiceUrl: string | null;
  } | null;
  message: string;
  reason?: string;
}
const answer = (res: { body: unknown }): Answer => res.body as Answer;

type Folder =
  'community/message-video' | 'community/message-voice' | 'community/message';
const EXTENSION: Record<Folder, string> = {
  'community/message-video': 'mp4',
  'community/message-voice': 'm4a',
  'community/message': 'png',
};
const CONTENT_TYPE: Record<Folder, string> = {
  'community/message-video': 'video/mp4',
  'community/message-voice': 'audio/mp4',
  'community/message': 'image/png',
};

describe('Community credits by kind of message (INBOX-22, contract)', () => {
  let app: INestApplication;
  let otherApp: INestApplication;
  let prisma: PrismaService;
  let settings: PlanSettingsService;
  let messages: CommunityMessageService;
  let storage: StorageService;
  let bucket: BucketLocation;
  let creditSpend: CreditSpendService;
  let notifications: NotificationService;
  let mockWawuId: ChildProcess | undefined;
  let ownedMockWawuId = false;

  let host: { sub: string; accessToken: string };
  let roomId: string;
  const ownedSubs: string[] = [];
  const communityIds: string[] = [];

  /** A member of the room with its own token; made fresh so no balance is shared. */
  async function member(label: string) {
    const person = await registerIdentity(label);
    ownedSubs.push(person.sub);
    await prisma.communityMembership.create({
      data: {
        userWawuId: person.sub,
        communityId: roomId,
        status: 'joined',
        joinedAt: new Date(),
      },
    });
    return person;
  }

  const setBalance = (userWawuId: string, creditBalance: number) =>
    prisma.creditsState.upsert({
      where: { userWawuId },
      update: { creditBalance },
      create: { userWawuId, creditBalance },
    });
  const balanceOf = async (userWawuId: string) =>
    (await prisma.creditsState.findUnique({ where: { userWawuId } }))
      ?.creditBalance;
  const spendsOf = (userWawuId: string) =>
    prisma.creditSpend.findMany({
      where: { userWawuId, communityId: roomId },
      orderBy: { spentAt: 'asc' },
    });
  const messagesOf = (userWawuId: string) =>
    prisma.communityMessage.findMany({
      where: { communityId: roomId, senderWawuId: userWawuId },
      orderBy: { sentAt: 'asc' },
    });

  /** An upload row the way presign then confirm leave it: the sender's own, in the kind's folder. Returns its key. */
  async function uploadRow(
    who: string,
    folder: Folder,
    status: 'confirmed' | 'pending' = 'confirmed',
  ): Promise<string> {
    const key = `${folder}/${who}/${randomUUID()}.${EXTENSION[folder]}`;
    await prisma.storageObject.create({
      data: {
        wawuUserId: who,
        key,
        bytes: 1000,
        contentType: CONTENT_TYPE[folder],
        folder,
        status,
        confirmedAt: status === 'confirmed' ? new Date() : null,
      },
    });
    return key;
  }

  /** What presign hands back for an upload: this bucket's signed read link (535 to 560 characters). */
  async function upload(
    who: string,
    folder: Folder,
    status: 'confirmed' | 'pending' = 'confirmed',
  ): Promise<string> {
    return storage.readUrlFor(await uploadRow(who, folder, status));
  }

  /** A link to a key on this bucket's own host, written by hand (a short one, with a made-up signature). */
  const bucketLink = (key: string) =>
    `${bucket.origin}${bucket.pathPrefix}${key}?X-Amz-Signature=abc`;

  function post(
    on: INestApplication,
    token: string,
    body: Record<string, unknown>,
    key?: string,
  ) {
    let req = request(on.getHttpServer() as App)
      .post(`/communities/${roomId}/messages`)
      .set('Authorization', `Bearer ${token}`);
    if (key !== undefined) req = req.set('Idempotency-Key', key);
    return req.send(body);
  }
  const newKey = () => `inbox22-${randomUUID()}`;

  async function resetCosts() {
    await settings.set(admin, {
      settings: Object.fromEntries(COST_KEYS.map((k) => [k, null])),
    });
  }

  async function boot(): Promise<{
    app: INestApplication;
    get: <T>(token: new (...args: never[]) => T) => T;
  }> {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        CommunityMessageModule,
      ],
    }).compile();
    const nest = moduleRef.createNestApplication();
    nest.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    nest.useGlobalFilters(new AllExceptionsFilter());
    nest.useGlobalInterceptors(new ResponseInterceptor());
    await nest.init();
    return {
      app: nest,
      get: (token) => moduleRef.get(token, { strict: false }),
    };
  }

  beforeAll(async () => {
    const alreadyUp = await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`, 1000);
    if (!alreadyUp) {
      mockWawuId = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '../../../mock-wawu-id'),
        env: { ...process.env, MOCK_WAWU_ID_PORT },
        stdio: 'ignore',
      });
      ownedMockWawuId = true;
      if (!(await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`))) {
        throw new Error('mock-wawu-id did not become healthy in time');
      }
    }

    const first = await boot();
    app = first.app;
    prisma = first.get(PrismaService);
    settings = first.get(PlanSettingsService);
    messages = first.get(CommunityMessageService);
    storage = first.get(StorageService);
    const at = await storage.bucketLocation();
    if (!at) throw new Error('the spec bucket has no address');
    bucket = at;
    creditSpend = first.get(CreditSpendService);
    notifications = first.get(NotificationService);
    // A second application, its own connection pool: "two servers".
    otherApp = (await boot()).app;

    host = await registerIdentity('host');
    ownedSubs.push(host.sub);
    const room = await prisma.community.create({
      data: {
        name: 'TEST INBOX-22: kinds',
        description: 'Fixture for community-message-kinds.contract.spec.ts.',
        hostWawuId: host.sub,
        kind: 'open',
      },
    });
    roomId = room.id;
    communityIds.push(roomId);
    await resetCosts();
  }, 60000);

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await resetCosts();
    await prisma.adminOpsAudit.deleteMany({
      where: { actedByAdminId: admin.id },
    });
    if (communityIds.length > 0) {
      // Cascades onto memberships, messages, keys, spends and earnings.
      await prisma.community.deleteMany({
        where: { id: { in: communityIds } },
      });
    }
    await prisma.storageObject.deleteMany({
      where: { wawuUserId: { in: ownedSubs } },
    });
    await prisma.creditPurchase.deleteMany({
      where: { userWawuId: { in: ownedSubs } },
    });
    await prisma.creditsState.deleteMany({
      where: { userWawuId: { in: ownedSubs } },
    });
    await app?.close();
    await otherApp?.close();
    if (ownedMockWawuId && mockWawuId) mockWawuId.kill();
  });

  // -------------------------------------------------------------------
  describe('what each kind costs', () => {
    it('states the prices from the admin settings, text always 0', () => {
      expect(messages.costsByKind()).toEqual({
        text: 0,
        photo: 1,
        video: 3,
        voice: 3,
      });
      expect(messages.meteredMessageCost()).toBe(0);
    });

    it('text and emoji cost 0 credits and work with no credits row at all', async () => {
      const who = await member('text');
      expect(await balanceOf(who.sub)).toBeUndefined();

      const text = await post(app, who.accessToken, { text: 'Hello everyone' });
      expect(text.status).toBe(201);
      expect(answer(text).data).toMatchObject({
        text: 'Hello everyone',
        costInCredits: 0,
        imageUrl: null,
        videoUrl: null,
        voiceUrl: null,
      });
      const emoji = await post(app, who.accessToken, { text: '🙂🎉🔥' });
      expect(emoji.status).toBe(201);
      expect(answer(emoji).data!.costInCredits).toBe(0);

      // Free means free: no credits row made, no ledger row, no earning.
      expect(await balanceOf(who.sub)).toBeUndefined();
      expect(await spendsOf(who.sub)).toHaveLength(0);
      expect(
        await prisma.creditSpendEarning.count({
          where: { creditSpend: { userWawuId: who.sub } },
        }),
      ).toBe(0);
      expect(await messagesOf(who.sub)).toHaveLength(2);
    });

    it('text works with a balance of 0', async () => {
      const who = await member('text-zero');
      await setBalance(who.sub, 0);
      const res = await post(app, who.accessToken, {
        text: 'No credits, still talking',
      });
      expect(res.status).toBe(201);
      expect(await balanceOf(who.sub)).toBe(0);
      expect(await spendsOf(who.sub)).toHaveLength(0);
    });

    it('a photo costs 1 credit, a video 3 and a voice note 3, each recorded once in the ledger', async () => {
      const who = await member('kinds');
      await setBalance(who.sub, 10);
      const photo = await post(app, who.accessToken, {
        imageUrl: await upload(who.sub, 'community/message'),
      });
      expect(photo.status).toBe(201);
      expect(answer(photo).data!.costInCredits).toBe(1);
      expect(await balanceOf(who.sub)).toBe(9);

      const video = await post(app, who.accessToken, {
        videoUrl: await upload(who.sub, 'community/message-video'),
      });
      expect(video.status).toBe(201);
      expect(answer(video).data!.costInCredits).toBe(3);
      expect(await balanceOf(who.sub)).toBe(6);

      const voice = await post(app, who.accessToken, {
        voiceUrl: await upload(who.sub, 'community/message-voice'),
      });
      expect(voice.status).toBe(201);
      expect(answer(voice).data!.costInCredits).toBe(3);
      expect(await balanceOf(who.sub)).toBe(3);

      expect((await spendsOf(who.sub)).map((s) => s.creditsSpent)).toEqual([
        1, 3, 3,
      ]);
      expect((await messagesOf(who.sub)).map((m) => m.costInCredits)).toEqual([
        1, 3, 3,
      ]);
    });

    it('text sent beside a photo adds nothing: the message costs the photo', async () => {
      const who = await member('caption');
      await setBalance(who.sub, 5);
      const res = await post(app, who.accessToken, {
        text: 'Fresh batch this morning',
        imageUrl: await upload(who.sub, 'community/message'),
      });
      expect(res.status).toBe(201);
      expect(answer(res).data!.costInCredits).toBe(1);
      expect(await balanceOf(who.sub)).toBe(4);
    });

    it('the prices are the admin settings, read at send time, never a number in code', async () => {
      const who = await member('settings');
      await setBalance(who.sub, 20);
      await settings.set(admin, {
        settings: {
          community_credit_cost_photo: 2,
          community_credit_cost_video: 5,
          community_credit_cost_voice: 4,
        },
      });
      try {
        expect(messages.costsByKind()).toEqual({
          text: 0,
          photo: 2,
          video: 5,
          voice: 4,
        });
        await post(app, who.accessToken, {
          imageUrl: await upload(who.sub, 'community/message'),
        }).expect(201);
        expect(await balanceOf(who.sub)).toBe(18);
        await post(app, who.accessToken, {
          videoUrl: await upload(who.sub, 'community/message-video'),
        }).expect(201);
        expect(await balanceOf(who.sub)).toBe(13);
        await post(app, who.accessToken, {
          voiceUrl: await upload(who.sub, 'community/message-voice'),
        }).expect(201);
        expect(await balanceOf(who.sub)).toBe(9);
        expect((await spendsOf(who.sub)).map((s) => s.creditsSpent)).toEqual([
          2, 5, 4,
        ]);
      } finally {
        await resetCosts();
      }
      expect(messages.costsByKind()).toEqual({
        text: 0,
        photo: 1,
        video: 3,
        voice: 3,
      });
    });

    it('the host sends every kind free in their own room: no row, no ledger, no balance made', async () => {
      const files = [
        { videoUrl: await upload(host.sub, 'community/message-video') },
        { voiceUrl: await upload(host.sub, 'community/message-voice') },
        { imageUrl: await upload(host.sub, 'community/message') },
        { text: 'Welcome' },
      ];
      for (const body of files) {
        const res = await post(app, host.accessToken, body);
        expect(res.status).toBe(201);
        expect(answer(res).data!.costInCredits).toBe(0);
      }
      expect(await balanceOf(host.sub)).toBeUndefined();
      expect(await spendsOf(host.sub)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------
  describe('a sender whose credits do not cover the message', () => {
    it('is refused a video with the shortfall in plain words, and nothing is taken; a photo still works', async () => {
      const who = await member('short');
      await setBalance(who.sub, 2);
      const video = await post(app, who.accessToken, {
        videoUrl: await upload(who.sub, 'community/message-video'),
      });
      expect(video.status).toBe(402);
      expect(answer(video).data).toBeNull();
      expect(answer(video).reason).toBe('insufficient_credits');
      expect(answer(video).message).toBe(
        'A video costs 3 WAWU Credits and you have 2. You are 1 short. Text and emoji are free.',
      );
      expect(answer(video).message).not.toMatch(LONG_DASH);
      expect(await balanceOf(who.sub)).toBe(2);
      expect(await messagesOf(who.sub)).toHaveLength(0);
      expect(await spendsOf(who.sub)).toHaveLength(0);

      const photo = await post(app, who.accessToken, {
        imageUrl: await upload(who.sub, 'community/message'),
      });
      expect(photo.status).toBe(201);
      expect(await balanceOf(who.sub)).toBe(1);
    });

    it('says "none" for a sender with no credits at all, and leaves no credits row behind', async () => {
      const who = await member('none');
      const voice = await post(app, who.accessToken, {
        voiceUrl: await upload(who.sub, 'community/message-voice'),
      });
      expect(voice.status).toBe(402);
      expect(answer(voice).message).toBe(
        'A voice note costs 3 WAWU Credits and you have none. You are 3 short. Text and emoji are free.',
      );
      expect(await balanceOf(who.sub)).toBeUndefined();
      expect(await messagesOf(who.sub)).toHaveLength(0);

      const photo = await post(app, who.accessToken, {
        imageUrl: await upload(who.sub, 'community/message'),
      });
      expect(photo.status).toBe(402);
      expect(answer(photo).message).toBe(
        'A photo costs 1 WAWU Credit and you have none. You are 1 short. Text and emoji are free.',
      );
    });
  });

  // -------------------------------------------------------------------
  describe('one deduction per message, however often the request is sent', () => {
    it('a repeat of a video send (the answer was lost) answers with the first message and takes nothing more', async () => {
      const who = await member('repeat');
      await setBalance(who.sub, 10);
      const body = {
        videoUrl: await upload(who.sub, 'community/message-video'),
      };
      const key = newKey();
      const first = await post(app, who.accessToken, body, key);
      expect(first.status).toBe(201);
      expect(await balanceOf(who.sub)).toBe(7);

      const again = await post(app, who.accessToken, body, key);
      expect(again.status).toBe(201);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(answer(again).data!.id).toBe(answer(first).data!.id);
      expect(await balanceOf(who.sub)).toBe(7);
      expect(await spendsOf(who.sub)).toHaveLength(1);
      expect(await messagesOf(who.sub)).toHaveLength(1);
    });

    it('five taps at once on two servers charge a voice note once', async () => {
      const who = await member('taps');
      await setBalance(who.sub, 10);
      const body = {
        voiceUrl: await upload(who.sub, 'community/message-voice'),
      };
      const key = newKey();
      const answers = await Promise.all(
        [app, otherApp, app, otherApp, app].map((on) =>
          post(on, who.accessToken, body, key),
        ),
      );
      expect(answers.map((a) => a.status)).toEqual([201, 201, 201, 201, 201]);
      expect(new Set(answers.map((a) => answer(a).data!.id)).size).toBe(1);
      expect(await balanceOf(who.sub)).toBe(7);
      expect(await spendsOf(who.sub)).toHaveLength(1);
      expect(await messagesOf(who.sub)).toHaveLength(1);
    });

    it('with exactly the 3 credits a video costs, a double tap sends it once and neither tap is told it has no credits', async () => {
      const who = await member('exact');
      await setBalance(who.sub, 3);
      const body = {
        videoUrl: await upload(who.sub, 'community/message-video'),
      };
      const key = newKey();
      const answers = await Promise.all([
        post(app, who.accessToken, body, key),
        post(otherApp, who.accessToken, body, key),
      ]);
      expect(answers.map((a) => a.status)).toEqual([201, 201]);
      expect(answer(answers[0]).data!.id).toBe(answer(answers[1]).data!.id);
      expect(await balanceOf(who.sub)).toBe(0);
      expect(await spendsOf(who.sub)).toHaveLength(1);
    });

    it('the same key for another kind of message is refused, and nothing is stored or taken', async () => {
      const who = await member('reuse');
      await setBalance(who.sub, 10);
      const key = newKey();
      await post(
        app,
        who.accessToken,
        { imageUrl: await upload(who.sub, 'community/message') },
        key,
      ).expect(201);
      const other = await post(
        app,
        who.accessToken,
        { videoUrl: await upload(who.sub, 'community/message-video') },
        key,
      );
      expect(other.status).toBe(409);
      expect(answer(other).reason).toBe('idempotency_key_reused');
      expect(await balanceOf(who.sub)).toBe(9);
      expect(await messagesOf(who.sub)).toHaveLength(1);

      // Nor is another video, or another voice note, the same message.
      const videoKey = newKey();
      await post(
        app,
        who.accessToken,
        { videoUrl: await upload(who.sub, 'community/message-video') },
        videoKey,
      ).expect(201);
      const otherVideo = await post(
        app,
        who.accessToken,
        { videoUrl: await upload(who.sub, 'community/message-video') },
        videoKey,
      );
      expect(otherVideo.status).toBe(409);
      const voiceKey = newKey();
      await post(
        app,
        who.accessToken,
        { voiceUrl: await upload(who.sub, 'community/message-voice') },
        voiceKey,
      ).expect(201);
      const otherVoice = await post(
        app,
        who.accessToken,
        { voiceUrl: await upload(who.sub, 'community/message-voice') },
        voiceKey,
      );
      expect(otherVoice.status).toBe(409);
      expect(await balanceOf(who.sub)).toBe(3);
      expect(await messagesOf(who.sub)).toHaveLength(3);
    });

    it('a refused send does not use up its key: the same key sends once after the person buys credits', async () => {
      const who = await member('refused-key');
      await setBalance(who.sub, 1);
      const body = {
        videoUrl: await upload(who.sub, 'community/message-video'),
      };
      const key = newKey();
      const refused = await post(app, who.accessToken, body, key);
      expect(refused.status).toBe(402);
      expect(await balanceOf(who.sub)).toBe(1);
      expect(await messagesOf(who.sub)).toHaveLength(0);

      await setBalance(who.sub, 5);
      const sent = await post(app, who.accessToken, body, key);
      expect(sent.status).toBe(201);
      expect(await balanceOf(who.sub)).toBe(2);
      const repeat = await post(app, who.accessToken, body, key);
      expect(repeat.headers['idempotent-replayed']).toBe('true');
      expect(await balanceOf(who.sub)).toBe(2);
      expect(await spendsOf(who.sub)).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------
  describe('a message that fails to send gives its credits back', () => {
    it('a failure while the ledger is written takes nothing and stores nothing, and the same key then sends once', async () => {
      const who = await member('ledger-fails');
      await setBalance(who.sub, 10);
      const body = {
        videoUrl: await upload(who.sub, 'community/message-video'),
      };
      const key = newKey();
      jest
        .spyOn(creditSpend, 'record')
        .mockRejectedValueOnce(new Error('ledger down'));
      const failed = await post(app, who.accessToken, body, key);
      expect(failed.status).toBe(500);
      expect(await balanceOf(who.sub)).toBe(10);
      expect(await messagesOf(who.sub)).toHaveLength(0);
      expect(await spendsOf(who.sub)).toHaveLength(0);
      expect(
        await prisma.communityMessageKey.count({
          where: { senderWawuId: who.sub },
        }),
      ).toBe(0);

      const retry = await post(app, who.accessToken, body, key);
      expect(retry.status).toBe(201);
      expect(await balanceOf(who.sub)).toBe(7);
      expect(await spendsOf(who.sub)).toHaveLength(1);
    });

    it('a failure of the low-credits notice after the commit does not turn a paid message into an error', async () => {
      const who = await member('notice-fails');
      await setBalance(who.sub, 6);
      const body = { imageUrl: await upload(who.sub, 'community/message') };
      const key = newKey();
      jest
        .spyOn(notifications, 'emit')
        .mockRejectedValueOnce(new Error('notification store down'));
      const sent = await post(app, who.accessToken, body, key);
      expect(sent.status).toBe(201);
      expect(await balanceOf(who.sub)).toBe(5);

      // The person who retries (they were not told otherwise) is not charged twice.
      const repeat = await post(app, who.accessToken, body, key);
      expect(repeat.headers['idempotent-replayed']).toBe('true');
      expect(await balanceOf(who.sub)).toBe(5);
      expect(await spendsOf(who.sub)).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------
  describe('video and voice note attachments', () => {
    it("refuses a file that is not the sender's own confirmed upload for that kind, and charges nothing", async () => {
      const who = await member('files');
      const stranger = await member('files-other');
      await setBalance(who.sub, 10);

      const refusals: Array<[string, Record<string, unknown>]> = [
        [
          'a link to anywhere else',
          { videoUrl: 'http://elsewhere.test/video.mp4' },
        ],
        [
          'a file nobody uploaded',
          {
            videoUrl: bucketLink(
              `community/message-video/${who.sub}/${randomUUID()}.mp4`,
            ),
          },
        ],
        [
          "another person's upload",
          { videoUrl: await upload(stranger.sub, 'community/message-video') },
        ],
        [
          'a voice note sent as a video',
          { videoUrl: await upload(who.sub, 'community/message-voice') },
        ],
        [
          'a video sent as a voice note',
          { voiceUrl: await upload(who.sub, 'community/message-video') },
        ],
      ];
      for (const [name, body] of refusals) {
        const res = await post(app, who.accessToken, body);
        expect([name, res.status]).toEqual([name, 400]);
      }
      const pending = await post(app, who.accessToken, {
        voiceUrl: await upload(who.sub, 'community/message-voice', 'pending'),
      });
      expect(pending.status).toBe(400);
      expect(answer(pending).message).toBe(
        'That voice note has not finished uploading. Wait a moment, then send it again.',
      );
      expect(await balanceOf(who.sub)).toBe(10);
      expect(await messagesOf(who.sub)).toHaveLength(0);
    });

    it("refuses a link on any other host, even with the sender's own confirmed key, and charges nothing", async () => {
      const who = await member('foreign');
      await setBalance(who.sub, 10);
      const videoKey = await uploadRow(who.sub, 'community/message-video');
      const voiceKey = await uploadRow(who.sub, 'community/message-voice');
      const host = new URL(bucket.origin).host;
      const foreign = (key: string): Array<[string, string]> => [
        ['another host', `https://evil.example/${key}?X-Amz-Signature=abc`],
        ['another host, key under a path', `https://evil.example/a/b/${key}`],
        [
          "this bucket's name as the login of another host",
          `http://${host}@evil.example/${key}`,
        ],
        [
          'a longer host that starts with the bucket host',
          `${bucket.origin}.evil.example/${key}`,
        ],
        ['the bucket host on another port', `${bucket.origin}:8443/${key}`],
        [
          'the bucket host on the other scheme',
          `${bucket.origin.replace('https:', 'http:')}/${key}`,
        ],
      ];
      for (const [name, link] of foreign(videoKey)) {
        const res = await post(app, who.accessToken, { videoUrl: link });
        expect(['video', name, res.status]).toEqual(['video', name, 400]);
        expect(answer(res).message).toBe(
          'That video could not be used. Upload it again, then send it.',
        );
      }
      for (const [name, link] of foreign(voiceKey)) {
        const res = await post(app, who.accessToken, { voiceUrl: link });
        expect(['voice', name, res.status]).toEqual(['voice', name, 400]);
        expect(answer(res).message).toBe(
          'That voice note could not be used. Upload it again, then send it.',
        );
      }
      // Nothing was stored, charged or served to the room.
      expect(await balanceOf(who.sub)).toBe(10);
      expect(await messagesOf(who.sub)).toHaveLength(0);
      expect(await spendsOf(who.sub)).toHaveLength(0);
      // The same keys on this bucket's own host are fine: the key was never the problem.
      const video = await post(app, who.accessToken, {
        videoUrl: bucketLink(videoKey),
      });
      expect([video.status, answer(video).data?.costInCredits]).toEqual([
        201, 3,
      ]);
      const voice = await post(app, who.accessToken, {
        voiceUrl: await storage.readUrlFor(voiceKey),
      });
      expect([voice.status, answer(voice).data?.costInCredits]).toEqual([
        201, 3,
      ]);
      expect(await balanceOf(who.sub)).toBe(4);
    });

    it("refuses a link on this bucket whose key is not exactly the kind's folder, the sender and one file, and charges nothing", async () => {
      const who = await member('shape');
      await setBalance(who.sub, 10);
      const videoKey = await uploadRow(who.sub, 'community/message-video');
      const photoKey = await uploadRow(who.sub, 'community/message');
      const [folder, sender, file] = [
        'community/message-video',
        who.sub,
        videoKey.split('/').pop() as string,
      ];
      const refusals: Array<[string, Record<string, unknown>]> = [
        [
          'the folder buried under another path on this bucket',
          { videoUrl: bucketLink(`legal/document/x/${videoKey}`) },
        ],
        [
          'the folder buried under one more segment',
          { videoUrl: bucketLink(`x/${videoKey}`) },
        ],
        [
          'a photo-folder file sent as a video',
          { videoUrl: await storage.readUrlFor(photoKey) },
        ],
        [
          'a video file sent as a voice note',
          { voiceUrl: await storage.readUrlFor(videoKey) },
        ],
        [
          'an extra segment between the sender and the file',
          { videoUrl: bucketLink(`${folder}/${sender}/x/${file}`) },
        ],
        [
          'the slash after the folder written as %2F',
          { videoUrl: bucketLink(`${folder}%2F${sender}/${file}`) },
        ],
        [
          'a dot segment',
          { videoUrl: bucketLink(`${folder}/${sender}/../${sender}/${file}`) },
        ],
        [
          'a backslash',
          { videoUrl: bucketLink(`${folder}/${sender}\\${file}`) },
        ],
      ];
      for (const [name, body] of refusals) {
        const res = await post(app, who.accessToken, body);
        expect([name, res.status]).toEqual([name, 400]);
      }
      expect(await balanceOf(who.sub)).toBe(10);
      expect(await messagesOf(who.sub)).toHaveLength(0);
      expect(await spendsOf(who.sub)).toHaveLength(0);
    });

    it("refuses another person's confirmed key on every link, this bucket's own included, and charges nothing", async () => {
      const who = await member('mine');
      const stranger = await member('theirs');
      await setBalance(who.sub, 10);
      const theirs = await uploadRow(stranger.sub, 'community/message-video');
      const theirVoice = await uploadRow(
        stranger.sub,
        'community/message-voice',
      );
      const refusals: Array<[string, Record<string, unknown>]> = [
        ['their link on this bucket', { videoUrl: bucketLink(theirs) }],
        [
          'their signed link from presign',
          { videoUrl: await storage.readUrlFor(theirs) },
        ],
        [
          'their key on another host',
          { videoUrl: `https://evil.example/${theirs}` },
        ],
        [
          'their voice note on this bucket',
          { voiceUrl: await storage.readUrlFor(theirVoice) },
        ],
        [
          'their voice note on another host',
          { voiceUrl: `https://evil.example/${theirVoice}` },
        ],
        [
          'their key with the sender id swapped in (no such file)',
          {
            videoUrl: bucketLink(theirs.replace(stranger.sub, who.sub)),
          },
        ],
      ];
      for (const [name, body] of refusals) {
        const res = await post(app, who.accessToken, body);
        expect([name, res.status]).toEqual([name, 400]);
      }
      expect(await balanceOf(who.sub)).toBe(10);
      expect(await messagesOf(who.sub)).toHaveLength(0);
      expect(await spendsOf(who.sub)).toHaveLength(0);
      // The room is never served a foreign link.
      expect(await messagesOf(stranger.sub)).toHaveLength(0);
    });

    it('refuses a message with more than one attachment, and one with a link that is not a link', async () => {
      const who = await member('two');
      await setBalance(who.sub, 10);
      const both = await post(app, who.accessToken, {
        imageUrl: 'http://storage.test/community/message/p9.png',
        videoUrl: await upload(who.sub, 'community/message-video'),
      });
      expect(both.status).toBe(400);
      expect(answer(both).message).toBe(
        'A message can carry one photo, one video or one voice note. Send each as its own message.',
      );
      await post(app, who.accessToken, { videoUrl: 'not-a-link' }).expect(400);
      expect(await balanceOf(who.sub)).toBe(10);
      expect(await messagesOf(who.sub)).toHaveLength(0);
    });

    it('takes the full-length signed link presign hands back (over 500 characters), for a photo, a video and a voice note', async () => {
      const who = await member('long');
      await setBalance(who.sub, 10);
      const longer = (url: string) =>
        `${url}&X-Amz-Signature=${'a'.repeat(520)}`;
      const video = longer(await upload(who.sub, 'community/message-video'));
      const voice = longer(await upload(who.sub, 'community/message-voice'));
      const photo = longer(await upload(who.sub, 'community/message'));
      expect(
        Math.min(video.length, voice.length, photo.length),
      ).toBeGreaterThan(500);
      for (const body of [
        { videoUrl: video },
        { voiceUrl: voice },
        { imageUrl: photo },
      ]) {
        const res = await post(app, who.accessToken, body);
        expect([res.status, Object.keys(body)[0]]).toEqual([
          201,
          Object.keys(body)[0],
        ]);
      }
      expect(await balanceOf(who.sub)).toBe(3);
    });

    it('lists a video and a voice note with their links, and the other two as null', async () => {
      const who = await member('listed');
      await setBalance(who.sub, 10);
      const videoUrl = await upload(who.sub, 'community/message-video');
      const voiceUrl = await upload(who.sub, 'community/message-voice');
      await post(app, who.accessToken, { videoUrl, text: 'Watch this' }).expect(
        201,
      );
      await post(app, who.accessToken, { voiceUrl }).expect(201);

      const list = await request(app.getHttpServer() as App)
        .get(`/communities/${roomId}/messages`)
        .set('Authorization', `Bearer ${who.accessToken}`)
        .expect(200);
      const mine = (
        list.body as {
          data: Array<{
            senderWawuId: string;
            text: string | null;
            imageUrl: string | null;
            videoUrl: string | null;
            voiceUrl: string | null;
          }>;
        }
      ).data.filter((m) => m.senderWawuId === who.sub);
      const video = mine.find((m) => m.videoUrl);
      const voice = mine.find((m) => m.voiceUrl);
      expect(video).toMatchObject({
        text: 'Watch this',
        videoUrl,
        imageUrl: null,
        voiceUrl: null,
      });
      expect(voice).toMatchObject({
        voiceUrl,
        videoUrl: null,
        imageUrl: null,
        text: null,
      });
    });
  });

  // -------------------------------------------------------------------
  describe('what a photo may be (FIX-77)', () => {
    const REFUSED = 'That photo could not be sent. Choose it again.';

    /** A photo send that must be refused with the photo sentence, and the room, the ledger and the balance left alone. */
    async function expectRefused(
      token: string,
      who: string,
      cases: Array<[string, unknown]>,
      balance: number,
    ) {
      for (const [name, imageUrl] of cases) {
        const res = await post(app, token, { imageUrl });
        expect([name, res.status]).toEqual([name, 400]);
        expect([name, answer(res).message]).toEqual([name, REFUSED]);
        expect(answer(res).message).not.toMatch(LONG_DASH);
      }
      expect(await balanceOf(who)).toBe(balance);
      expect(await messagesOf(who)).toHaveLength(0);
      expect(await spendsOf(who)).toHaveLength(0);
    }

    it("refuses a link that is not this bucket's own, even with the sender's own key, and charges nothing", async () => {
      const who = await member('photo-foreign');
      await setBalance(who.sub, 10);
      const key = await uploadRow(who.sub, 'community/message');
      const host = new URL(bucket.origin).host;
      await expectRefused(
        who.accessToken,
        who.sub,
        [
          ['example.com', `https://example.com/${key}`],
          [
            'another host with a signature',
            `https://evil.example/${key}?X-Amz-Signature=abc`,
          ],
          ['another host, key under a path', `https://evil.example/a/b/${key}`],
          [
            "this bucket's name as the login of another host",
            `http://${host}@evil.example/${key}`,
          ],
          [
            'a longer host that starts with the bucket host',
            `${bucket.origin}.evil.example/${key}`,
          ],
          ['the bucket host on another port', `${bucket.origin}:8443/${key}`],
          [
            'the bucket host on the other scheme',
            `${bucket.origin.replace('https:', 'http:')}/${key}`,
          ],
          [
            'a made-up photo link on a made-up host (what the old tests sent)',
            'http://storage.test/community/message/photo.png',
          ],
          ['a link to a picture anywhere', 'https://i.imgur.com/abc.png'],
        ],
        10,
      );
      // The same key on this bucket's own host is fine: the key was never the problem.
      const ok = await post(app, who.accessToken, {
        imageUrl: bucketLink(key),
      });
      expect([ok.status, answer(ok).data?.costInCredits]).toEqual([201, 1]);
      expect(await balanceOf(who.sub)).toBe(9);
    });

    it("refuses another person's key on every link, this bucket's own included, and charges nothing", async () => {
      const who = await member('photo-mine');
      const stranger = await member('photo-theirs');
      await setBalance(who.sub, 10);
      const theirs = await uploadRow(stranger.sub, 'community/message');
      const theirPending = await uploadRow(
        stranger.sub,
        'community/message',
        'pending',
      );
      await expectRefused(
        who.accessToken,
        who.sub,
        [
          ['their link on this bucket', bucketLink(theirs)],
          ['their signed link from presign', await storage.readUrlFor(theirs)],
          [
            'their presigned, unconfirmed photo',
            await storage.readUrlFor(theirPending),
          ],
          ['their key on another host', `https://evil.example/${theirs}`],
          [
            'their key with the sender id swapped in (no such file)',
            bucketLink(theirs.replace(stranger.sub, who.sub)),
          ],
        ],
        10,
      );
      // The room is never served a foreign link.
      expect(await messagesOf(stranger.sub)).toHaveLength(0);
    });

    it('refuses a file from another folder, and a key that is not exactly the folder, the sender and one file, and charges nothing', async () => {
      const who = await member('photo-folder');
      await setBalance(who.sub, 10);
      const photoKey = await uploadRow(who.sub, 'community/message');
      const videoKey = await uploadRow(who.sub, 'community/message-video');
      const voiceKey = await uploadRow(who.sub, 'community/message-voice');
      // The sender's own confirmed upload in a folder that is not a message photo's.
      const avatarKey = `avatars/${who.sub}/${randomUUID()}.png`;
      await prisma.storageObject.create({
        data: {
          wawuUserId: who.sub,
          key: avatarKey,
          bytes: 1000,
          contentType: 'image/png',
          folder: 'avatars',
          status: 'confirmed',
          confirmedAt: new Date(),
        },
      });
      const [folder, sender, file] = [
        'community/message',
        who.sub,
        photoKey.split('/').pop() as string,
      ];
      await expectRefused(
        who.accessToken,
        who.sub,
        [
          ['a video file sent as a photo', await storage.readUrlFor(videoKey)],
          ['a voice note sent as a photo', await storage.readUrlFor(voiceKey)],
          ['an avatar sent as a photo', await storage.readUrlFor(avatarKey)],
          [
            'a community cover folder file',
            bucketLink(`community/image/${sender}/${file}`),
          ],
          [
            'the folder buried under another path on this bucket',
            bucketLink(`legal/document/x/${photoKey}`),
          ],
          [
            'the folder buried under one more segment',
            bucketLink(`x/${photoKey}`),
          ],
          [
            'an extra segment between the sender and the file',
            bucketLink(`${folder}/${sender}/x/${file}`),
          ],
          [
            'the slash after the folder written as %2F',
            bucketLink(`${folder}%2F${sender}/${file}`),
          ],
          [
            'a dot segment',
            bucketLink(`${folder}/${sender}/../${sender}/${file}`),
          ],
          ['a backslash', bucketLink(`${folder}/${sender}\\${file}`)],
        ],
        10,
      );
    });

    it('refuses a key that has no upload row, and a photo that was given up, and charges nothing', async () => {
      const who = await member('photo-norow');
      await setBalance(who.sub, 10);
      // Right folder, right sender, right shape, but never presigned.
      const unknown = `community/message/${who.sub}/${randomUUID()}.png`;
      const gaveUp = await uploadRow(who.sub, 'community/message');
      await prisma.storageObject.update({
        where: { key: gaveUp },
        data: { status: 'abandoned', releasedAt: new Date() },
      });
      await expectRefused(
        who.accessToken,
        who.sub,
        [
          ['a key nobody presigned', bucketLink(unknown)],
          [
            'a key nobody presigned, signed link shape',
            `${bucket.origin}${bucket.pathPrefix}${unknown}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc`,
          ],
          ['a photo the sender gave up', await storage.readUrlFor(gaveUp)],
        ],
        10,
      );
    });

    // Every answer signs the photo's link again (FIX-71), so a link read back is
    // the sender's own file with a new signature, never the string that was sent
    // (FIX-84). The clock is moved two seconds before each send and read so every
    // run meets that, and the real clock is put back after each test.
    afterEach(() => {
      restoreClock();
    });

    it("takes the sender's own presigned photo that was never confirmed (the web's path), and charges it once", async () => {
      const who = await member('photo-web');
      await setBalance(who.sub, 10);
      const imageUrl = await upload(who.sub, 'community/message', 'pending');
      const key = newKey();
      moveClockForward();
      const first = await post(app, who.accessToken, { imageUrl }, key);
      expect(first.status).toBe(201);
      expect(answer(first).data).toMatchObject({
        costInCredits: 1,
        videoUrl: null,
        voiceUrl: null,
      });
      expectLinkSignedAgain(answer(first).data?.imageUrl, imageUrl);
      expect(await balanceOf(who.sub)).toBe(9);
      // The same request sent again is the same message: nothing more is taken.
      moveClockForward();
      const again = await post(app, who.accessToken, { imageUrl }, key);
      expect(again.status).toBe(201);
      expect(answer(again).data?.id).toBe(answer(first).data?.id);
      expectLinkSignedAgain(answer(again).data?.imageUrl, imageUrl);
      expect(await balanceOf(who.sub)).toBe(9);
      expect(await spendsOf(who.sub)).toHaveLength(1);
      expect(await messagesOf(who.sub)).toHaveLength(1);
    });

    it("takes the sender's own confirmed photo (the app's path), and charges it once", async () => {
      const who = await member('photo-app');
      await setBalance(who.sub, 10);
      const imageUrl = await upload(who.sub, 'community/message', 'confirmed');
      moveClockForward();
      const sent = await post(app, who.accessToken, {
        imageUrl,
        text: 'Fresh batch',
      });
      expect(sent.status).toBe(201);
      expect(answer(sent).data).toMatchObject({
        costInCredits: 1,
        text: 'Fresh batch',
      });
      expectLinkSignedAgain(answer(sent).data?.imageUrl, imageUrl);
      expect(await balanceOf(who.sub)).toBe(9);
      expect(await spendsOf(who.sub)).toHaveLength(1);
      // The room is served the sender's photo, its link signed again (FIX-71).
      moveClockForward();
      const list = await request(app.getHttpServer() as App)
        .get(`/communities/${roomId}/messages`)
        .set('Authorization', `Bearer ${who.accessToken}`)
        .expect(200);
      const mine = (
        list.body as {
          data: Array<{ senderWawuId: string; imageUrl: string | null }>;
        }
      ).data.filter((m) => m.senderWawuId === who.sub);
      expect(mine).toHaveLength(1);
      expectLinkSignedAgain(mine[0].imageUrl, imageUrl);
    });

    it('leaves a text message alone: a null or missing photo is not checked and costs nothing', async () => {
      const who = await member('photo-text');
      await setBalance(who.sub, 10);
      for (const body of [
        { text: 'Plain words' },
        { text: 'With a null photo', imageUrl: null },
      ]) {
        const res = await post(app, who.accessToken, body);
        expect([JSON.stringify(body), res.status]).toEqual([
          JSON.stringify(body),
          201,
        ]);
        expect(answer(res).data).toMatchObject({
          costInCredits: 0,
          imageUrl: null,
        });
      }
      expect(await balanceOf(who.sub)).toBe(10);
      expect(await spendsOf(who.sub)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------
  describe("the host's 85% is computed on credits actually spent", () => {
    it('free messages add nothing; a photo and a video add exactly what was spent', async () => {
      const who = await member('earns');
      // 120 credits bought for N1,000.00 (100000 kobo): the cost basis the
      // host's share is taken from, first in first out.
      await setBalance(who.sub, 120);
      const purchase = await prisma.creditPurchase.create({
        data: {
          userWawuId: who.sub,
          pack: 'popular',
          creditsGranted: 120,
          flutterwaveTxRef: `inbox22-${randomUUID()}`,
          amount: 1000,
          status: 'completed',
        },
      });
      await prisma.creditLot.create({
        data: {
          creditPurchaseId: purchase.id,
          userWawuId: who.sub,
          creditsGranted: 120,
          creditsRemaining: 120,
          grossKobo: 100000,
        },
      });

      await post(app, who.accessToken, { text: 'Free chat' }).expect(201);
      await post(app, who.accessToken, { text: '🙂' }).expect(201);
      expect(await spendsOf(who.sub)).toHaveLength(0);
      expect(
        await prisma.creditSpendEarning.count({
          where: { creditSpend: { userWawuId: who.sub } },
        }),
      ).toBe(0);

      await post(app, who.accessToken, {
        imageUrl: await upload(who.sub, 'community/message'),
      }).expect(201);
      await post(app, who.accessToken, {
        videoUrl: await upload(who.sub, 'community/message-video'),
      }).expect(201);

      const earnings = await prisma.creditSpendEarning.findMany({
        where: { creditSpend: { userWawuId: who.sub } },
        orderBy: { earnedAt: 'asc' },
      });
      expect(earnings.map((e) => e.creditsSpent)).toEqual([1, 3]);
      expect(earnings.map((e) => e.creditsFunded)).toEqual([1, 3]);
      // Kobo taken out of the lot, largest remainder: floor(100000 * 1 / 120)
      // = 833, then floor(100000 * 4 / 120) - 833 = 2500.
      expect(earnings.map((e) => e.grossKobo)).toEqual([833, 2500]);
      // The host's 85%, floored: floor(833 * 17 / 20) and floor(2500 * 17 / 20).
      expect(earnings.map((e) => e.hostShareKobo)).toEqual([708, 2125]);
      expect(earnings.every((e) => e.creatorWawuId === host.sub)).toBe(true);
      expect(await balanceOf(who.sub)).toBe(116);
    });
  });
});
