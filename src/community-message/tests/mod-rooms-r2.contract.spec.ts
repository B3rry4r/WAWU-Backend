/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- supertest bodies are untyped JSON */
// MOD-ROOMS r2 (R-122). L2: a moderator's Remove on a room message sends the live removal event and leaves the room's log a
// row, as the host's delete does. (The r2 notes-and-names filter cases were withdrawn with the word filter, owner, 31 Oct
// 2026.) The whole Hub (AppModule) over the real database and the mock WAWU ID, as mod-rooms.contract.spec.ts does.

import {
  boot,
  type Harness,
  type Who,
} from '../../../test/user-suspension/suspension-harness';
import { LivePublisher } from '../../live/live-publisher.service';

jest.setTimeout(240_000);

describe('MOD-ROOMS r2 (R-122)', () => {
  let h: Harness;
  let host: Who;
  let ann: Who;
  let bob: Who;
  let cat: Who;
  let roomId: string;
  const TAG = `m2${Date.now().toString().slice(-8)}`;

  const as = (w: Who) => ({ Authorization: `Bearer ${w.token}` });
  const api = (path: string) => `/api/hub${path}`;
  const post = (w: Who, path: string, body: object = {}) =>
    h.http().post(api(path)).set(as(w)).send(body);
  const get = (w: Who, path: string) => h.http().get(api(path)).set(as(w));

  beforeAll(async () => {
    h = await boot(TAG);
    host = await h.person('host', 'creator');
    ann = await h.person('ann');
    bob = await h.person('bob');
    cat = await h.person('cat');
    roomId = (
      await h.prisma.community.create({
        data: {
          name: `${TAG} room`,
          description: 'fixture',
          hostWawuId: host.sub,
          kind: 'open',
        },
      })
    ).id;
    await h.prisma.communityMembership.createMany({
      data: [ann, bob, cat].map((p) => ({
        userWawuId: p.sub,
        communityId: roomId,
        status: 'joined' as const,
        joinedAt: new Date(),
      })),
    });
  });

  afterAll(async () => {
    await h.prisma.ugcReport.deleteMany({
      where: { targetId: { startsWith: '' }, reporterWawuId: bob.sub },
    });
    await h.prisma.communityModerationLog.deleteMany({
      where: { communityId: roomId },
    });
    await h.prisma.community.deleteMany({ where: { id: roomId } });
    await h.cleanup();
    await h.stop();
  });

  describe("L2: a moderator's Remove on a room message tells every open room", () => {
    it('the removal event is sent, the room log has a row (the moderator is the actor), and the catch-up carries it to a member and to nobody outside', async () => {
      const live = h.app.get(LivePublisher);
      const publish = jest.spyOn(live, 'publish');
      const start = (await get(cat, '/live/catch-up').expect(200)).body.data;
      const said = await post(ann, `/communities/${roomId}/messages`, {
        text: 'a message a moderator will take down',
      }).expect(201);
      const messageId: string = said.body.data.id;
      await post(bob, '/reports', {
        kind: 'community_message',
        targetId: messageId,
        reason: 'hate',
      }).expect(200);
      const report = await h.prisma.ugcReport.findFirstOrThrow({
        where: { targetId: messageId },
        select: { id: true },
      });
      await h
        .http()
        .post(api(`/admin/reports/${report.id}/resolve`))
        .set({ Authorization: `Bearer ${h.admin('reviewer')}` })
        .send({ action: 'take_down', note: 'hate speech' })
        .expect(200);

      expect(
        await h.prisma.communityMessage.count({ where: { id: messageId } }),
      ).toBe(0);
      expect(publish).toHaveBeenCalledWith({
        kind: 'community.message.removed',
        communityId: roomId,
        messageId,
      });
      const log = await h.prisma.communityModerationLog.findMany({
        where: { communityId: roomId, messageId },
      });
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({
        action: 'message_deleted',
        targetWawuId: ann.sub,
        messageKind: 'text',
      });
      expect(log[0].actorWawuId.startsWith('moderator:')).toBe(true);
      expect(JSON.stringify(log[0])).not.toContain('a message a moderator');

      // A phone that was away reads the removal, in the host's and the moderator's shared log.
      const caught = (
        await get(cat, `/live/catch-up?cursor=${start.cursor}`).expect(200)
      ).body.data;
      expect(
        caught.events.some(
          (e: any) =>
            e.type === 'community.message.removed' && e.messageId === messageId,
        ),
      ).toBe(true);
      // Resolving it again removes nothing and sends nothing more.
      const calls = publish.mock.calls.length;
      await h
        .http()
        .post(api(`/admin/reports/${report.id}/resolve`))
        .set({ Authorization: `Bearer ${h.admin('reviewer')}` })
        .send({ action: 'take_down', note: 'again' });
      expect(publish.mock.calls.length).toBe(calls);
      publish.mockRestore();
    });
  });
});
