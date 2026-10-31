// MOD-ROOMS r2 (R-122, M3). A host's mute or unmute reaches that member's open room at once, through the same live channel
// new messages and deletes use (`community.mute.changed`), and the catch-up carries it for a phone that was away. Real
// sockets and real tokens from the local mock WAWU ID, as live-room-delete.contract.spec.ts does.
//
// Every identity is a throwaway registered by this spec and every row it writes is removed in afterAll.

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { ChildProcess, spawn } from 'child_process';
import type { AddressInfo } from 'net';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { BlockedAccountModule } from '../../blocked-account/blocked-account.module';
import { LiveModule } from '../live.module';
import type { LiveCatchUp, LiveEvent } from '../live-event.type';

import {
  Client,
  data,
  MOCK_DIR,
  MOCK_WAWU_ID_BASE,
  MOCK_WAWU_ID_PORT,
  registerPerson,
  settle,
  waitForHealth,
  type Person,
} from './live-test-kit.test';

type Muted = LiveEvent & { type: 'community.mute.changed' };
const muteEvent = (e: LiveEvent): e is Muted =>
  e.type === 'community.mute.changed';

describe('A host mutes and unmutes a member: live (MOD-ROOMS r2, M3, R-122)', () => {
  let app: INestApplication<App>;
  let port: number;
  let prisma: PrismaService;
  let mockWawuId: ChildProcess | undefined;

  let host: Person;
  let ann: Person; // joined member, the one who is muted
  let bob: Person; // joined member, bystander
  let pat: Person; // pending request
  let eve: Person; // stranger
  let roomId: string;
  let otherRoomId: string;
  const opened: Client[] = [];

  const open = async (who: Person) => {
    const c = await Client.open(port, who.token);
    opened.push(c);
    return c;
  };
  const as = (who: Person) => ({
    get: (url: string) =>
      request(app.getHttpServer())
        .get(url)
        .set('Authorization', `Bearer ${who.token}`),
    post: (url: string, body: object = {}) =>
      request(app.getHttpServer())
        .post(url)
        .set('Authorization', `Bearer ${who.token}`)
        .send(body),
    put: (url: string) =>
      request(app.getHttpServer())
        .put(url)
        .set('Authorization', `Bearer ${who.token}`),
    del: (url: string) =>
      request(app.getHttpServer())
        .delete(url)
        .set('Authorization', `Bearer ${who.token}`),
  });
  const mute = (target: Person, by: Person = host, room: string = roomId) =>
    as(by).put(`/communities/${room}/mutes/${target.sub}`);
  const unmute = (target: Person, by: Person = host, room: string = roomId) =>
    as(by).del(`/communities/${room}/mutes/${target.sub}`);
  const mutes = (events: LiveEvent[]): Muted[] => events.filter(muteEvent);
  const catchUp = async (who: Person, cursor: string, limit?: number) =>
    data<LiveCatchUp>(
      await as(who)
        .get(`/live/catch-up?cursor=${cursor}${limit ? `&limit=${limit}` : ''}`)
        .expect(200),
    );

  beforeAll(async () => {
    if (!(await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`, 1000))) {
      mockWawuId = spawn('node', ['server.js'], {
        cwd: MOCK_DIR,
        env: { ...process.env, MOCK_WAWU_ID_PORT },
        stdio: 'ignore',
      });
      if (!(await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`))) {
        throw new Error('mock-wawu-id did not become healthy in time');
      }
    }
    host = await registerPerson('RMHost');
    ann = await registerPerson('RMAnn');
    bob = await registerPerson('RMBob');
    pat = await registerPerson('RMPat');
    eve = await registerPerson('RMEve');

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        BlockedAccountModule,
        LiveModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication<INestApplication<App>>();
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
    await app.listen(0);
    port = (
      (app.getHttpServer() as { address(): unknown }).address() as AddressInfo
    ).port;
    prisma = app.get(PrismaService);

    for (const p of [host, ann, bob]) {
      await prisma.userProfile.create({
        data: {
          wawuUserId: p.sub,
          accountType: 'user',
          handle: `rmspec_${p.sub.slice(0, 8)}`,
          bio: 'Fixture for live-room-mute.contract.spec.ts.',
          interests: [],
        },
      });
    }
    const make = async (name: string) =>
      (
        await prisma.community.create({
          data: {
            name,
            description: 'Fixture for live-room-mute.contract.spec.ts.',
            hostWawuId: host.sub,
            kind: 'open',
          },
        })
      ).id;
    roomId = await make('Live mute spec room');
    otherRoomId = await make('Live mute spec other room');
    for (const room of [roomId, otherRoomId]) {
      await prisma.communityMembership.createMany({
        data: [
          {
            userWawuId: ann.sub,
            communityId: room,
            status: 'joined',
            joinedAt: new Date(),
          },
          {
            userWawuId: bob.sub,
            communityId: room,
            status: 'joined',
            joinedAt: new Date(),
          },
          { userWawuId: pat.sub, communityId: room, status: 'pending' },
        ],
      });
    }
  }, 90000);

  afterAll(async () => {
    for (const c of opened) c.ws.terminate();
    if (prisma) {
      const ids = [host, ann, bob, pat, eve].map((p) => p.sub);
      const rooms = [roomId, otherRoomId].filter(Boolean);
      await prisma.communityModerationLog.deleteMany({
        where: { communityId: { in: rooms } },
      });
      await prisma.community.deleteMany({ where: { id: { in: rooms } } });
      await prisma.userProfile.deleteMany({
        where: { wawuUserId: { in: ids } },
      });
    }
    if (app) await app.close();
    mockWawuId?.kill();
  });

  it('a mute reaches the muted member on every phone they have open within two seconds; nobody else hears it; an unmute does the same', async () => {
    const [hostPhone, annPhone, annSecond, bobPhone, patPhone, evePhone] =
      await Promise.all([
        open(host),
        open(ann),
        open(ann),
        open(bob),
        open(pat),
        open(eve),
      ]);
    const started = Date.now();
    await mute(ann).expect(200);
    const got = await annPhone.event<Muted>(
      (e) => muteEvent(e) && e.muted === true,
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(got).toMatchObject({
      type: 'community.mute.changed',
      communityId: roomId,
      muted: true,
    });
    expect(typeof got.cursor).toBe('string');
    // No names, no words: only the room and the state.
    expect(Object.keys(got).sort()).toEqual([
      'communityId',
      'cursor',
      'muted',
      'type',
    ]);
    // The other phone of the same person, too.
    await annSecond.event((e) => muteEvent(e) && e.muted === true);

    await unmute(ann).expect(200);
    const back = await annPhone.event<Muted>(
      (e) => muteEvent(e) && e.muted === false,
    );
    expect(back).toMatchObject({ communityId: roomId, muted: false });
    await settle();

    // Exactly once each, in the order the host did them.
    expect(mutes(annPhone.events()).map((e) => e.muted)).toEqual([true, false]);
    // The host, a bystander, a pending request and a stranger are told nothing.
    for (const phone of [hostPhone, bobPhone, patPhone, evePhone]) {
      expect(mutes(phone.events())).toEqual([]);
    }
    for (const c of [
      hostPhone,
      annPhone,
      annSecond,
      bobPhone,
      patPhone,
      evePhone,
    ])
      c.close();
  });

  it('a repeated mute or unmute changes nothing and sends nothing; a member cannot mute and nothing is sent; a mute in another room reaches only that room', async () => {
    const annPhone = await open(ann);
    await mute(ann).expect(200);
    await annPhone.event((e) => muteEvent(e) && e.muted === true);
    await mute(ann).expect(200);
    await mute(ann, bob).expect(403);
    await unmute(ann, bob).expect(403);
    await settle(300);
    expect(mutes(annPhone.events()).map((e) => e.muted)).toEqual([true]);

    await unmute(ann).expect(200);
    await annPhone.event((e) => muteEvent(e) && e.muted === false);
    await unmute(ann).expect(200);
    await settle(300);
    expect(mutes(annPhone.events()).map((e) => e.muted)).toEqual([true, false]);

    // The other room: the event names it, so the app changes that room only.
    await mute(ann, host, otherRoomId).expect(200);
    const other = await annPhone.event<Muted>(
      (e) => muteEvent(e) && e.communityId === otherRoomId,
    );
    expect(other.muted).toBe(true);
    await unmute(ann, host, otherRoomId).expect(200);
    await annPhone.event(
      (e) => muteEvent(e) && e.communityId === otherRoomId && !e.muted,
    );
    annPhone.close();
  });

  it('the state the event announces is the state the Hub holds: moderation says muted, a send is refused, and it clears with the unmute', async () => {
    const annPhone = await open(ann);
    await mute(ann).expect(200);
    await annPhone.event((e) => muteEvent(e) && e.muted === true);
    const view = data<{ muted: boolean }>(
      await as(ann).get(`/communities/${roomId}/moderation`).expect(200),
    );
    expect(view.muted).toBe(true);
    const refused = await as(ann)
      .post(`/communities/${roomId}/messages`, { text: 'hello' })
      .expect(403);
    expect(JSON.stringify(refused.body)).toContain('muted_in_room');
    await unmute(ann).expect(200);
    await annPhone.event((e) => muteEvent(e) && e.muted === false);
    await as(ann)
      .post(`/communities/${roomId}/messages`, { text: 'hello again' })
      .expect(201);
    annPhone.close();
  });

  it('a member who left does not hear of the unmute, the socket still open; the mute survives leaving and is still theirs on return', async () => {
    const annPhone = await open(ann);
    await mute(ann).expect(200);
    await annPhone.event((e) => muteEvent(e) && e.muted === true);
    await prisma.communityMembership.update({
      where: {
        userWawuId_communityId: { userWawuId: ann.sub, communityId: roomId },
      },
      data: { status: 'pending' },
    });
    await unmute(ann).expect(200);
    await settle(300);
    expect(mutes(annPhone.events()).map((e) => e.muted)).toEqual([true]);
    await prisma.communityMembership.update({
      where: {
        userWawuId_communityId: { userWawuId: ann.sub, communityId: roomId },
      },
      data: { status: 'joined' },
    });
    annPhone.close();
  });

  it('a phone that was away reads the mutes and unmutes from the catch-up, in order, and only its own; pages one event at a time', async () => {
    const start = data<LiveCatchUp>(
      await as(ann).get('/live/catch-up').expect(200),
    );
    // A cursor with no row is read 10 s behind, so the mutes of the earlier tests are in this window too: count them first.
    const prior = mutes((await catchUp(ann, start.cursor)).events).filter(
      (e) => e.communityId === roomId,
    ).length;
    await settle(50);
    await mute(ann).expect(200);
    await settle(5);
    await unmute(ann).expect(200);
    await settle(5);
    await mute(ann).expect(200);
    await settle(5);
    await mute(bob).expect(200);

    const all = await catchUp(ann, start.cursor);
    expect(
      mutes(all.events)
        .filter((e) => e.communityId === roomId)
        .map((e) => e.muted)
        .slice(prior),
    ).toEqual([true, false, true]);
    // Cursors only go forward.
    const times = mutes(all.events).map(
      (e) => Buffer.from(e.cursor, 'base64').toString().split('|')[0],
    );
    expect(times).toEqual([...times].sort());

    // One event to a page: the cursor carries the 'u' position and the pages lose none.
    const seen: boolean[] = [];
    let cursor = start.cursor;
    for (let guard = 0; guard < 40; guard += 1) {
      const page = await catchUp(ann, cursor, 1);
      for (const e of mutes(page.events)) {
        if (e.communityId === roomId) seen.push(e.muted);
      }
      cursor = page.cursor;
      if (!page.hasMore) break;
    }
    expect(seen.slice(prior)).toEqual([true, false, true]);

    // Bob heard only about bob; the host, a pending request and a stranger hear nothing.
    const bobs = mutes((await catchUp(bob, start.cursor)).events);
    expect(bobs.map((e) => e.muted)).toEqual([true]);
    for (const who of [host, pat, eve]) {
      expect(mutes((await catchUp(who, start.cursor)).events)).toEqual([]);
    }
    await unmute(ann).expect(200);
    await unmute(bob).expect(200);
  });
});
