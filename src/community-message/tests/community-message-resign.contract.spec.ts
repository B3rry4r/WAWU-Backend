// Run against the caller's own test database (set DATABASE_URL before
// invoking jest) - same convention as every other contract spec.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';
// A storage that can SIGN, and nothing else: a presigned link is computed
// locally, so no request ever leaves the machine. The host cannot resolve.
process.env.STORAGE_ENDPOINT = 'https://fix71-bucket.test.invalid';
process.env.STORAGE_ACCESS_KEY_ID = 'tid_fix71_test';
process.env.STORAGE_SECRET_ACCESS_KEY = 'secret_fix71_test';
process.env.STORAGE_BUCKET = 'fix71-bucket';
process.env.STORAGE_REGION = 'sjc';

import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { ConfigModule } from '@nestjs/config';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { BlockedAccountModule } from '../../blocked-account/blocked-account.module';
import { CommunityModule } from '../../community/community.module';
import { LiveModule } from '../../live/live.module';
import { LiveDispatcher } from '../../live/live-dispatcher.service';
import { LiveCatchUpService } from '../../live/live-catch-up.service';
import { LiveConnections } from '../../live/live-connections.service';
import { encodeLiveCursor } from '../../live/live-cursor';
import type { LiveEvent } from '../../live/live-event.type';

/**
 * FIX-71 (G-INBOX-22-2): THE PHOTO, THE VIDEO AND THE VOICE NOTE OF A
 * COMMUNITY MESSAGE LOAD A WEEK LATER.
 *
 * They are stored as the 7-day signed link the app sent. Every path that
 * returns a message signs the link again from the key it names: the room's
 * list, the answer to a send (and to its repeat), the live event, the
 * catch-up page and the last message of "my communities". A message stored 8
 * days ago comes back with a link signed now in each of them; an old row that
 * holds a full link works; and a link that names somebody else's file, or a
 * file from another folder, is never signed for the room.
 *
 * Nothing here reaches a bucket or a provider: the storage is configured only
 * so it can sign (locally), at a host that does not exist. Every identity,
 * room and row is this spec's own and is deleted in afterAll.
 */

const MOCK_WAWU_ID_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_WAWU_ID_BASE = `http://localhost:${MOCK_WAWU_ID_PORT}`;
const HOST = 'https://fix71-bucket.test.invalid';
const STALE = 'dead0000beef';
const DAY = 24 * 3600 * 1000;

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
      fullName: `Resign Spec ${label}`,
      email: `fix71-${label}-${nonce}@test.wawu.dev`,
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

/** The signed link presign handed back 8 days ago: dead today. */
function eightDayOldLink(key: string): string {
  const stamp =
    new Date(Date.now() - 8 * DAY)
      .toISOString()
      .replace(/[-:]/g, '')
      .slice(0, 15) + 'Z';
  return (
    `${HOST}/${key}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=${stamp}` +
    `&X-Amz-Expires=604800&X-Amz-Signature=${STALE}`
  );
}

/** A link signed now, for 7 days, for exactly `key`. */
function expectSignedNowFor(link: unknown, key: string): void {
  expect(typeof link).toBe('string');
  const url = new URL(link as string);
  expect(decodeURIComponent(url.pathname)).toBe(`/${key}`);
  expect(url.searchParams.get('X-Amz-Signature')).not.toBe(STALE);
  expect(url.searchParams.get('X-Amz-Expires')).toBe('604800');
  const date = url.searchParams.get('X-Amz-Date') as string;
  const signedAt = Date.parse(
    date.replace(
      /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
      '$1-$2-$3T$4:$5:$6Z',
    ),
  );
  expect(Math.abs(Date.now() - signedAt)).toBeLessThan(5 * 60 * 1000);
}

interface WireMessage {
  id: string;
  imageUrl: string | null;
  videoUrl: string | null;
  voiceUrl: string | null;
}

describe('Community message media is signed again on read (FIX-71, contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let connections: LiveConnections;
  let dispatcher: LiveDispatcher;
  let catchUps: LiveCatchUpService;
  let mockWawuId: ChildProcess | undefined;
  let ownedMockWawuId = false;

  let host: { sub: string; accessToken: string };
  let member: { sub: string; accessToken: string };
  let outsider: { sub: string; accessToken: string };
  let victim: { sub: string; accessToken: string };
  let roomId: string;
  const communityIds: string[] = [];

  const photoKey = () => `community/message/${member.sub}/${randomUUID()}.jpg`;
  const videoKey = () =>
    `community/message-video/${member.sub}/${randomUUID()}.mp4`;
  const voiceKey = () =>
    `community/message-voice/${member.sub}/${randomUUID()}.m4a`;

  /** A message the way it was stored 8 days ago: the old link, sent by `senderWawuId`. */
  function storedEightDaysAgo(
    communityId: string,
    senderWawuId: string,
    media: { imageUrl?: string; videoUrl?: string; voiceUrl?: string },
  ) {
    return prisma.communityMessage.create({
      data: {
        communityId,
        senderWawuId,
        text: null,
        costInCredits: 0,
        sentAt: new Date(Date.now() - 8 * DAY),
        ...media,
      },
    });
  }

  async function room(label: string) {
    const created = await prisma.community.create({
      data: {
        name: `TEST FIX-71: ${label}`,
        description: 'Fixture for community-message-resign.contract.spec.ts.',
        hostWawuId: host.sub,
        kind: 'open',
      },
    });
    communityIds.push(created.id);
    await prisma.communityMembership.create({
      data: {
        userWawuId: member.sub,
        communityId: created.id,
        status: 'joined',
        joinedAt: new Date(Date.now() - 20 * DAY),
      },
    });
    return created.id;
  }

  // The messages of the main room, each stored 8 days ago.
  const photo = { key: '', link: '', id: '' };
  const video = { key: '', link: '', id: '' };
  const voice = { key: '', link: '', id: '' };
  const bare = { key: '', id: '' };
  const victimKyc = { key: '', link: '', id: '' };
  const victimPhoto = { key: '', link: '', id: '' };
  const external = { link: 'https://cdn.example.com/a/pic.png', id: '' };
  const wrongField = { key: '', link: '', id: '' };

  /** Every message of the main room must come back the way this says. */
  function expectRoomMessages(byId: Map<string, WireMessage>): void {
    expectSignedNowFor(byId.get(photo.id)?.imageUrl, photo.key);
    expectSignedNowFor(byId.get(video.id)?.videoUrl, video.key);
    expectSignedNowFor(byId.get(voice.id)?.voiceUrl, voice.key);
    expectSignedNowFor(byId.get(bare.id)?.imageUrl, bare.key);
    // Somebody else's file, an identity document, a link elsewhere and a file
    // in the wrong field are never signed: they come back as they were stored.
    expect(byId.get(victimKyc.id)?.imageUrl).toBe(victimKyc.link);
    expect(byId.get(victimPhoto.id)?.imageUrl).toBe(victimPhoto.link);
    expect(byId.get(external.id)?.imageUrl).toBe(external.link);
    expect(byId.get(wrongField.id)?.videoUrl).toBe(wrongField.link);
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

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        BlockedAccountModule,
        CommunityModule,
        LiveModule,
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
    await app.listen(0, '127.0.0.1');
    prisma = app.get(PrismaService);
    connections = app.get(LiveConnections);
    dispatcher = app.get(LiveDispatcher);
    catchUps = app.get(LiveCatchUpService);

    host = await registerIdentity('host');
    member = await registerIdentity('member');
    outsider = await registerIdentity('outsider');
    victim = await registerIdentity('victim');

    roomId = await room('main');

    photo.key = photoKey();
    photo.link = eightDayOldLink(photo.key);
    video.key = videoKey();
    video.link = eightDayOldLink(video.key);
    voice.key = voiceKey();
    voice.link = eightDayOldLink(voice.key);
    bare.key = photoKey();
    victimKyc.key = `kyc/id-document/${victim.sub}/${randomUUID()}.jpg`;
    victimKyc.link = eightDayOldLink(victimKyc.key);
    victimPhoto.key = `community/message/${victim.sub}/${randomUUID()}.jpg`;
    victimPhoto.link = eightDayOldLink(victimPhoto.key);
    wrongField.key = `community/message/${member.sub}/${randomUUID()}.jpg`;
    wrongField.link = eightDayOldLink(wrongField.key);

    photo.id = (
      await storedEightDaysAgo(roomId, member.sub, { imageUrl: photo.link })
    ).id;
    video.id = (
      await storedEightDaysAgo(roomId, member.sub, { videoUrl: video.link })
    ).id;
    voice.id = (
      await storedEightDaysAgo(roomId, member.sub, { voiceUrl: voice.link })
    ).id;
    // An old row that holds the bare key.
    bare.id = (
      await storedEightDaysAgo(roomId, member.sub, { imageUrl: bare.key })
    ).id;
    victimKyc.id = (
      await storedEightDaysAgo(roomId, member.sub, {
        imageUrl: victimKyc.link,
      })
    ).id;
    victimPhoto.id = (
      await storedEightDaysAgo(roomId, member.sub, {
        imageUrl: victimPhoto.link,
      })
    ).id;
    external.id = (
      await storedEightDaysAgo(roomId, member.sub, {
        imageUrl: external.link,
      })
    ).id;
    wrongField.id = (
      await storedEightDaysAgo(roomId, member.sub, {
        videoUrl: wrongField.link,
      })
    ).id;
  }, 90000);

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    if (communityIds.length > 0) {
      // Cascades onto memberships and messages.
      await prisma?.community.deleteMany({
        where: { id: { in: communityIds } },
      });
    }
    await app?.close();
    if (ownedMockWawuId && mockWawuId) mockWawuId.kill();
  });

  // -------------------------------------------------------------------
  it('the list of the room signs each link again', async () => {
    const res = await request(app.getHttpServer() as App)
      .get(`/communities/${roomId}/messages?perPage=50`)
      .set('Authorization', `Bearer ${member.accessToken}`);
    expect(res.status).toBe(200);
    const items = (res.body as { data: WireMessage[] }).data;
    expect(items).toHaveLength(8);
    expectRoomMessages(new Map(items.map((m) => [m.id, m])));
  });

  it('the host reads the same signed links', async () => {
    const res = await request(app.getHttpServer() as App)
      .get(`/communities/${roomId}/messages?perPage=50`)
      .set('Authorization', `Bearer ${host.accessToken}`);
    expect(res.status).toBe(200);
    const items = (res.body as { data: WireMessage[] }).data;
    expectRoomMessages(new Map(items.map((m) => [m.id, m])));
  });

  it('a person outside the room is refused and nothing is signed for them', async () => {
    const res = await request(app.getHttpServer() as App)
      .get(`/communities/${roomId}/messages?perPage=50`)
      .set('Authorization', `Bearer ${outsider.accessToken}`);
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('X-Amz-Signature');
  });

  it('the stored rows are not rewritten', async () => {
    const stored = await prisma.communityMessage.findMany({
      where: { id: { in: [photo.id, video.id, voice.id] } },
    });
    const links = stored.flatMap((m) => [m.imageUrl, m.videoUrl, m.voiceUrl]);
    expect(links).toEqual(
      expect.arrayContaining([photo.link, video.link, voice.link]),
    );
  });

  it('the answer to a send, and to its repeat, carries a link that loads today', async () => {
    const key = `community/message/${host.sub}/${randomUUID()}.jpg`;
    const old = eightDayOldLink(key);
    const idem = `fix71-${randomUUID()}`;
    const send = () =>
      request(app.getHttpServer() as App)
        .post(`/communities/${roomId}/messages`)
        .set('Authorization', `Bearer ${host.accessToken}`)
        .set('Idempotency-Key', idem)
        .send({ imageUrl: old });
    const first = await send();
    expect(first.status).toBe(201);
    expectSignedNowFor(
      (first.body as { data: WireMessage }).data.imageUrl,
      key,
    );
    const again = await send();
    expect(again.headers['idempotent-replayed']).toBe('true');
    expectSignedNowFor(
      (again.body as { data: WireMessage }).data.imageUrl,
      key,
    );
    // What is stored is what the app sent.
    const row = await prisma.communityMessage.findFirstOrThrow({
      where: { communityId: roomId, senderWawuId: host.sub },
    });
    expect(row.imageUrl).toBe(old);
    await prisma.communityMessage.delete({ where: { id: row.id } });
  });

  it('"my communities" signs the last message of each kind again', async () => {
    const photoRoom = await room('last photo');
    const videoRoom = await room('last video');
    const voiceRoom = await room('last voice');
    const pk = photoKey();
    const vk = videoKey();
    const nk = voiceKey();
    await storedEightDaysAgo(photoRoom, member.sub, {
      imageUrl: eightDayOldLink(pk),
    });
    await storedEightDaysAgo(videoRoom, member.sub, {
      videoUrl: eightDayOldLink(vk),
    });
    await storedEightDaysAgo(voiceRoom, member.sub, {
      voiceUrl: eightDayOldLink(nk),
    });

    const res = await request(app.getHttpServer() as App)
      .get('/communities/mine?perPage=50')
      .set('Authorization', `Bearer ${member.accessToken}`);
    expect(res.status).toBe(200);
    const mine = (
      res.body as {
        data: Array<{ id: string; lastMessage: WireMessage | null }>;
      }
    ).data;
    const last = (id: string) => mine.find((r) => r.id === id)?.lastMessage;
    expectSignedNowFor(last(photoRoom)?.imageUrl, pk);
    expectSignedNowFor(last(videoRoom)?.videoUrl, vk);
    expectSignedNowFor(last(voiceRoom)?.voiceUrl, nk);
  });

  it('"my communities" does not sign another person\'s file', async () => {
    const odd = await room('last foreign');
    const foreign = `community/message/${victim.sub}/${randomUUID()}.jpg`;
    const link = eightDayOldLink(foreign);
    await storedEightDaysAgo(odd, member.sub, { imageUrl: link });
    const res = await request(app.getHttpServer() as App)
      .get('/communities/mine?perPage=50')
      .set('Authorization', `Bearer ${member.accessToken}`);
    const mine = (
      res.body as {
        data: Array<{ id: string; lastMessage: WireMessage | null }>;
      }
    ).data;
    expect(mine.find((r) => r.id === odd)?.lastMessage?.imageUrl).toBe(link);
  });

  it('the live event carries signed links to the room, and goes to nobody outside it', async () => {
    const sent: Array<{ to: string; frame: LiveEvent }> = [];
    jest.spyOn(connections, 'size', 'get').mockReturnValue(3);
    jest
      .spyOn(connections, 'userIds')
      .mockReturnValue([member.sub, host.sub, outsider.sub]);
    jest.spyOn(connections, 'send').mockImplementation((to, frame) => {
      sent.push({ to, frame: frame as LiveEvent });
    });

    const ids = [
      photo,
      video,
      voice,
      bare,
      victimKyc,
      victimPhoto,
      external,
      wrongField,
    ];
    for (const m of ids) {
      await dispatcher.handle({
        kind: 'community.message',
        communityId: roomId,
        messageId: m.id,
      });
    }

    const byRecipient = (who: string) =>
      new Map(
        sent
          .filter((s) => s.to === who && s.frame.type === 'community.message')
          .map((s) => {
            const message = (
              s.frame as LiveEvent & { type: 'community.message' }
            ).message as unknown as WireMessage;
            return [message.id, message] as const;
          }),
      );
    expect(sent.filter((s) => s.to === outsider.sub)).toHaveLength(0);
    for (const who of [member.sub, host.sub]) {
      const got = byRecipient(who);
      expect(got.size).toBe(8);
      expectRoomMessages(got);
    }
  });

  it('the catch-up page signs the links again, and holds nothing of the room for an outsider', async () => {
    const since = encodeLiveCursor(new Date(Date.now() - 9 * DAY));
    const page = await catchUps.catchUp(member.sub, since, 200);
    const messages = page.events.flatMap((e) =>
      e.type === 'community.message'
        ? [e.message as unknown as WireMessage]
        : [],
    );
    const inMain = messages.filter((m) =>
      [
        photo.id,
        video.id,
        voice.id,
        bare.id,
        victimKyc.id,
        victimPhoto.id,
        external.id,
        wrongField.id,
      ].includes(m.id),
    );
    expect(inMain).toHaveLength(8);
    expectRoomMessages(new Map(inMain.map((m) => [m.id, m])));

    const outside = await catchUps.catchUp(outsider.sub, since, 200);
    expect(
      outside.events.filter((e) => e.type === 'community.message'),
    ).toHaveLength(0);
  });
});
