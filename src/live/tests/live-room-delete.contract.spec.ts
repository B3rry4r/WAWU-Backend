// MOD-ROOMS r1 (R-122). A message the host of a room deletes disappears from every member's open room at once, through the
// same live channel new messages use (`community.message.removed`), and from the catch-up a phone reads when it was away.
// Real sockets and real tokens from the local mock WAWU ID, as live.contract.spec.ts does. The room list and its preview
// read the table, so they lose the message with the row; that is asserted here too, on the same room.
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
import type { CommunityMessage } from '../../common/types';

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

type Removed = LiveEvent & { type: 'community.message.removed' };
const removalOf =
  (messageId: string) =>
  (e: LiveEvent): boolean =>
    e.type === 'community.message.removed' && e.messageId === messageId;

describe('A host deletes a room message: live (MOD-ROOMS r1, R-122)', () => {
  let app: INestApplication<App>;
  let port: number;
  let prisma: PrismaService;
  let mockWawuId: ChildProcess | undefined;

  let host: Person;
  let ann: Person; // joined member
  let bob: Person; // joined member, blocked the host's writer below
  let pat: Person; // pending request
  let eve: Person; // stranger
  let roomId: string;
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
    del: (url: string) =>
      request(app.getHttpServer())
        .delete(url)
        .set('Authorization', `Bearer ${who.token}`),
  });
  const say = async (who: Person, text: string): Promise<string> =>
    data<CommunityMessage>(
      await as(who)
        .post(`/communities/${roomId}/messages`, { text })
        .expect(201),
    ).id;
  const remove = (messageId: string, who: Person = host) =>
    as(who).del(`/communities/${roomId}/messages/${messageId}`);
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
    host = await registerPerson('RDHost');
    ann = await registerPerson('RDAnn');
    bob = await registerPerson('RDBob');
    pat = await registerPerson('RDPat');
    eve = await registerPerson('RDEve');

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
          handle: `rdspec_${p.sub.slice(0, 8)}`,
          bio: 'Fixture for live-room-delete.contract.spec.ts.',
          interests: [],
        },
      });
    }
    const room = await prisma.community.create({
      data: {
        name: 'Live delete spec room',
        description: 'Fixture for live-room-delete.contract.spec.ts.',
        hostWawuId: host.sub,
        kind: 'open',
      },
    });
    roomId = room.id;
    await prisma.communityMembership.createMany({
      data: [
        {
          userWawuId: ann.sub,
          communityId: roomId,
          status: 'joined',
          joinedAt: new Date(),
        },
        {
          userWawuId: bob.sub,
          communityId: roomId,
          status: 'joined',
          joinedAt: new Date(),
        },
        { userWawuId: pat.sub, communityId: roomId, status: 'pending' },
      ],
    });
  }, 90000);

  afterAll(async () => {
    for (const c of opened) c.ws.terminate();
    if (prisma) {
      const ids = [host, ann, bob, pat, eve].map((p) => p.sub);
      await prisma.communityModerationLog.deleteMany({
        where: { communityId: roomId },
      });
      await prisma.community.deleteMany({ where: { id: roomId } });
      await prisma.blockedAccount.deleteMany({
        where: {
          OR: [{ userWawuId: { in: ids } }, { blockedWawuId: { in: ids } }],
        },
      });
      await prisma.userProfile.deleteMany({
        where: { wawuUserId: { in: ids } },
      });
    }
    if (app) await app.close();
    mockWawuId?.kill();
  });

  it('reaches the host (their other phone) and every joined member within two seconds, with the id and no words; a pending request and a stranger get nothing', async () => {
    const [hostPhone, annPhone, bobPhone, patPhone, evePhone] =
      await Promise.all([
        open(host),
        open(ann),
        open(bob),
        open(pat),
        open(eve),
      ]);
    const id = await say(ann, 'a message the host will delete');
    await annPhone.event((e) => e.type === 'community.message');
    await remove(id).expect(200);
    const started = Date.now();
    const got = await annPhone.event<Removed>(removalOf(id));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(got).toMatchObject({
      type: 'community.message.removed',
      communityId: roomId,
      messageId: id,
    });
    expect(typeof got.cursor).toBe('string');
    expect(JSON.stringify(got)).not.toContain('a message the host');
    await hostPhone.event(removalOf(id));
    await bobPhone.event(removalOf(id));
    await settle();
    expect(patPhone.events().some(removalOf(id))).toBe(false);
    expect(evePhone.events()).toEqual([]);
    // Exactly once each.
    expect(annPhone.events().filter(removalOf(id))).toHaveLength(1);
    for (const c of [hostPhone, annPhone, bobPhone, patPhone, evePhone])
      c.close();
  });

  it('a second delete of the same message is a 404 and sends nothing; a member cannot delete and nothing is sent', async () => {
    const annPhone = await open(ann);
    const id = await say(ann, 'deleted once only');
    await remove(id, bob).expect(403);
    await settle(200);
    expect(annPhone.events().some(removalOf(id))).toBe(false);
    await remove(id).expect(200);
    await annPhone.event(removalOf(id));
    await remove(id).expect(404);
    await settle(300);
    expect(annPhone.events().filter(removalOf(id))).toHaveLength(1);
    annPhone.close();
  });

  it('a member who blocked the writer still drops the message (it names an id, never words); a member who left does not hear of it', async () => {
    await as(bob)
      .post('/settings/privacy/blocked', { blockedWawuId: ann.sub })
      .expect(201);
    const bobPhone = await open(bob);
    const annPhone = await open(ann);
    const id = await say(ann, 'written by the person bob blocked');
    await annPhone.event((e) => e.type === 'community.message');
    await settle(200);
    // Bob never received the words (a block), and still drops the id.
    expect(bobPhone.events().some((e) => e.type === 'community.message')).toBe(
      false,
    );
    await remove(id).expect(200);
    await bobPhone.event(removalOf(id));
    await prisma.blockedAccount.deleteMany({
      where: { userWawuId: bob.sub, blockedWawuId: ann.sub },
    });
    // Ann leaves; the next delete is not sent to her any more, the socket still open.
    await prisma.communityMembership.update({
      where: {
        userWawuId_communityId: { userWawuId: ann.sub, communityId: roomId },
      },
      data: { status: 'pending' },
    });
    const later = await say(host, 'after ann left');
    await remove(later).expect(200);
    await bobPhone.event(removalOf(later));
    await settle(300);
    expect(annPhone.events().some(removalOf(later))).toBe(false);
    await prisma.communityMembership.update({
      where: {
        userWawuId_communityId: { userWawuId: ann.sub, communityId: roomId },
      },
      data: { status: 'joined' },
    });
    bobPhone.close();
    annPhone.close();
  });

  it('a phone that was away reads the delete from the catch-up (the message is not in it), and pages through several', async () => {
    const start = data<LiveCatchUp>(
      await as(bob).get('/live/catch-up').expect(200),
    );
    await settle(50);
    const keep = await say(host, 'stays');
    const a = await say(ann, 'gone one');
    const b = await say(ann, 'gone two');
    const c = await say(ann, 'gone three');
    for (const id of [a, b, c]) {
      await remove(id).expect(200);
      await settle(5);
    }

    const all = await catchUp(bob, start.cursor);
    const removed = all.events
      .filter((e): e is Removed => e.type === 'community.message.removed')
      .map((e) => e.messageId);
    expect(removed).toEqual(expect.arrayContaining([a, b, c]));
    const posted = all.events
      .filter((e) => e.type === 'community.message')
      .map((e) => e.message.id);
    // The deleted rows are gone, so they are not replayed; the one that stayed is.
    expect(posted).toContain(keep);
    for (const id of [a, b, c]) expect(posted).not.toContain(id);
    expect(all.events.find(removalOf(a)) as Removed).toMatchObject({
      communityId: roomId,
      messageId: a,
    });

    // One event to a page: the cursor carries the 'd' position and the pages lose none.
    const seen: string[] = [];
    let cursor = start.cursor;
    for (let guard = 0; guard < 40; guard += 1) {
      const page = await catchUp(bob, cursor, 1);
      for (const e of page.events) {
        if (e.type === 'community.message.removed') seen.push(e.messageId);
      }
      cursor = page.cursor;
      if (!page.hasMore) break;
    }
    expect(seen).toEqual(expect.arrayContaining([a, b, c]));

    // Another room's people and a stranger never hear of it.
    const stranger = await catchUp(eve, start.cursor);
    expect(stranger.events.some(removalOf(a))).toBe(false);
  });

  it('the room list has lost the message too (the room preview in "my communities" is read in mod-rooms.contract.spec.ts)', async () => {
    const id = await say(ann, 'the newest message, about to go');
    const before = await as(bob)
      .get(`/communities/${roomId}/messages`)
      .expect(200);
    expect(
      (before.body as { data: CommunityMessage[] }).data.map((m) => m.id),
    ).toContain(id);
    await remove(id).expect(200);
    const after = await as(bob)
      .get(`/communities/${roomId}/messages`)
      .expect(200);
    expect(
      (after.body as { data: CommunityMessage[] }).data.map((m) => m.id),
    ).not.toContain(id);
  });
});
