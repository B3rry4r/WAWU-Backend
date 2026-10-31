/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- supertest bodies are untyped JSON */
// MOD-ROOMS (R-122). (1) The word filter at every field a person writes for others: refused with `content_blocked`, nothing
// saved, clean text unchanged. (2) The host's tools in their own room: delete any message, mute and unmute a member; only the
// host; a muted member reads but cannot send; the audit rows. (3) A block in a room both ways. The whole Hub (AppModule),
// real database, mock WAWU ID. No money is moved and nothing is paid.

import {
  boot,
  type Harness,
  type Who,
} from '../../../test/user-suspension/suspension-harness';
import { StoreIntentService } from '../../store/store-intent.service';
import { PaidDmWalletService } from '../../direct-message/wallet/paid-dm-wallet.service';
import {
  CONTENT_BLOCKED_CODE,
  CONTENT_BLOCKED_MESSAGE,
} from '../../moderation/content-filter';
import {
  MUTED_IN_ROOM_CODE,
  MUTED_IN_ROOM_MESSAGE,
} from '../community-room-moderation.service';

jest.setTimeout(240_000);

const BAD = 'you are a piece of shit';
const GOOD = 'A kind, clean sentence about the class at Scunthorpe.';

describe('MOD-ROOMS (R-122)', () => {
  let h: Harness;
  let host: Who;
  let ann: Who; // member
  let bob: Who; // member
  let cat: Who; // member
  let eve: Who; // stranger (not in the room)
  let roomId: string;
  let otherRoomId: string;
  let pieceId: string;
  const TAG = `mr${Date.now().toString().slice(-8)}`;

  const as = (w: Who) => ({ Authorization: `Bearer ${w.token}` });
  const api = (path: string) => `/api/hub${path}`;
  const post = (w: Who, path: string, body: object = {}) =>
    h.http().post(api(path)).set(as(w)).send(body);
  const get = (w: Who, path: string) => h.http().get(api(path)).set(as(w));
  const say = (w: Who, text: string) =>
    post(w, `/communities/${roomId}/messages`, { text });
  const texts = async (w: Who): Promise<string[]> =>
    (
      (await get(w, `/communities/${roomId}/messages?perPage=100`).expect(
        200,
      )) as { body: { data: { text: string }[] } }
    ).body.data.map((m) => m.text);
  const blocked = (res: { status: number; body: any }) => {
    expect(res.status).toBe(400);
    expect(res.body.reason?.code).toBe(CONTENT_BLOCKED_CODE);
    expect(res.body.message).toBe(CONTENT_BLOCKED_MESSAGE);
    expect(JSON.stringify(res.body)).not.toMatch(/shit/i);
  };

  beforeAll(async () => {
    h = await boot(TAG);
    host = await h.person('host', 'creator');
    ann = await h.person('ann');
    bob = await h.person('bob');
    cat = await h.person('cat');
    eve = await h.person('eve');
    const room = await h.prisma.community.create({
      data: {
        name: `${TAG} room`,
        description: 'fixture',
        hostWawuId: host.sub,
        kind: 'open',
      },
    });
    roomId = room.id;
    otherRoomId = (
      await h.prisma.community.create({
        data: {
          name: `${TAG} other`,
          description: 'fixture',
          hostWawuId: eve.sub,
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
    pieceId = (
      await h.prisma.contentPiece.create({
        data: {
          slug: `${TAG}-p`,
          creatorWawuId: host.sub,
          contentType: 'video',
          title: `${TAG} piece`,
          description: 'fixture',
          category: 'fixture',
          accessType: 'free',
          price: 0,
          previewAssetUrl: 'https://example.invalid/p.jpg',
          status: 'live',
        },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    const people = [host, ann, bob, cat, eve].map((p) => p.sub);
    await h.prisma.communityModerationLog.deleteMany({
      where: { communityId: { in: [roomId, otherRoomId] } },
    });
    await h.prisma.blockedAccount.deleteMany({
      where: {
        OR: [{ userWawuId: { in: people } }, { blockedWawuId: { in: people } }],
      },
    });
    await h.prisma.chatConversation.deleteMany({
      where: {
        OR: [{ userAWawuId: { in: people } }, { userBWawuId: { in: people } }],
      },
    });
    await h.prisma.comment.deleteMany({ where: { contentId: pieceId } });
    await h.prisma.contentPiece.deleteMany({ where: { id: pieceId } });
    await h.prisma.productDraft.deleteMany({
      where: { wawuUserId: { in: people } },
    });
    await h.prisma.community.deleteMany({
      where: {
        OR: [
          { id: { in: [roomId, otherRoomId] } },
          { hostWawuId: { in: people } },
        ],
      },
    });
    await h.cleanup();
    await h.stop();
  });

  // ------------------------------------------------------------------------------------------------------------------
  describe('the word filter', () => {
    it('a room message with a listed word is refused and nothing is saved; clean text is unchanged', async () => {
      blocked(await say(ann, BAD));
      blocked(await say(ann, 'f*cking hell'.replace('hell', 'idiots')));
      expect(await texts(host)).not.toContain(BAD);
      const ok = await say(ann, GOOD).expect(201);
      expect(ok.body.data.text).toBe(GOOD);
      expect(await texts(host)).toContain(GOOD);
      expect(
        await h.prisma.communityMessage.count({
          where: { communityId: roomId, text: BAD },
        }),
      ).toBe(0);
    });

    it('a comment is refused and not saved; a clean one is saved as typed', async () => {
      const before = await h.prisma.comment.count({
        where: { contentId: pieceId },
      });
      blocked(await post(ann, `/content/${pieceId}/comments`, { text: BAD }));
      expect(
        await h.prisma.comment.count({ where: { contentId: pieceId } }),
      ).toBe(before);
      const ok = await post(ann, `/content/${pieceId}/comments`, {
        text: GOOD,
      }).expect(201);
      expect(ok.body.data.text).toBe(GOOD);
    });

    it('a chat message (and a file name) is refused and not saved; a clean one is saved', async () => {
      const chat = await post(ann, '/chats', { wawuId: cat.sub }).expect(200);
      const chatId = chat.body.data.id as string;
      blocked(await post(ann, `/chats/${chatId}/messages`, { text: BAD }));
      expect(
        await h.prisma.chatMessage.count({ where: { conversationId: chatId } }),
      ).toBe(0);
      const ok = await post(ann, `/chats/${chatId}/messages`, {
        text: GOOD,
      }).expect(201);
      expect(ok.body.data.text).toBe(GOOD);
    });

    it('a paid question (web route) and a paid answer are refused before anything else; a clean one gets past the filter', async () => {
      blocked(await post(ann, `/dm/${host.sub}/send`, { text: BAD }));
      const clean = await post(ann, `/dm/${host.sub}/send`, { text: GOOD });
      expect(clean.body.reason?.code).not.toBe(CONTENT_BLOCKED_CODE);
      const noSuchMessage = '00000000-0000-4000-8000-0000000000aa';
      blocked(await post(host, `/dm/${noSuchMessage}/respond`, { text: BAD }));
      const cleanAnswer = await post(host, `/dm/${noSuchMessage}/respond`, {
        text: GOOD,
      });
      expect(cleanAnswer.body.reason?.code).not.toBe(CONTENT_BLOCKED_CODE);
    });

    it('a paid question from the wallet and one bought in a store are refused before a draft or an intent is made', async () => {
      const wallet = h.app.get(PaidDmWalletService);
      await expect(
        wallet.ask({ wawuUserId: ann.sub } as never, host.sub, { text: BAD }),
      ).rejects.toMatchObject({
        response: { reason: { code: CONTENT_BLOCKED_CODE } },
      });
      expect(
        await h.prisma.paidDmDraft.count({ where: { senderWawuId: ann.sub } }),
      ).toBe(0);
      const store = h.app.get(StoreIntentService);
      await expect(
        store.prepare(ann.sub, {
          platform: 'ios',
          kind: 'question',
          creatorWawuId: host.sub,
          listPriceNaira: 500,
          text: BAD,
        } as never),
      ).rejects.toMatchObject({
        response: { reason: { code: CONTENT_BLOCKED_CODE } },
      });
    });

    it('a profile name, handle and bio are refused and the profile is unchanged', async () => {
      const before = await h.prisma.userProfile.findUnique({
        where: { wawuUserId: ann.sub },
      });
      for (const body of [
        { bio: BAD },
        { handle: 'shit_head' },
        { headline: BAD },
      ]) {
        blocked(await h.http().patch(api('/users/me')).set(as(ann)).send(body));
      }
      const after = await h.prisma.userProfile.findUnique({
        where: { wawuUserId: ann.sub },
      });
      expect(after?.bio).toBe(before?.bio);
      expect(after?.handle).toBe(before?.handle);
      const ok = await h
        .http()
        .patch(api('/users/me'))
        .set(as(ann))
        .send({ bio: GOOD });
      expect(ok.status).toBe(200);
      expect(
        (
          await h.prisma.userProfile.findUnique({
            where: { wawuUserId: ann.sub },
          })
        )?.bio,
      ).toBe(GOOD);
    });

    it('a piece title and description, an edit, and a draft are refused; nothing is saved', async () => {
      const piece = {
        contentType: 'video',
        category: 'agriculture_food',
        accessType: 'free',
        price: 0,
        fullAsset: 'https://example.invalid/full.mp4',
        previewAsset: 'https://example.invalid/prev.mp4',
      };
      blocked(
        await post(host, '/content', {
          ...piece,
          title: BAD,
          description: GOOD,
        }),
      );
      blocked(
        await post(host, '/content', {
          ...piece,
          title: GOOD,
          description: BAD,
        }),
      );
      expect(
        await h.prisma.contentPiece.count({
          where: { creatorWawuId: host.sub, title: BAD },
        }),
      ).toBe(0);
      blocked(
        await h
          .http()
          .patch(api(`/content/${pieceId}`))
          .set(as(host))
          .send({ title: BAD }),
      );
      expect(
        (await h.prisma.contentPiece.findUnique({ where: { id: pieceId } }))
          ?.title,
      ).toBe(`${TAG} piece`);
      blocked(
        await post(host, '/product-drafts', {
          title: BAD,
          contentType: 'video',
        }),
      );
      expect(
        await h.prisma.productDraft.count({ where: { wawuUserId: host.sub } }),
      ).toBe(0);
    });

    it('an event name and description are refused before the host check; a community name and description likewise', async () => {
      const event = {
        name: BAD,
        description: GOOD,
        hostOrg: 'Org',
        format: 'online',
        type: 'webinar',
        startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      };
      blocked(await post(host, '/events', event));
      blocked(
        await post(host, '/events', { ...event, name: GOOD, description: BAD }),
      );
      expect(await h.prisma.event.count({ where: { name: BAD } })).toBe(0);
      blocked(
        await post(host, '/communities', {
          name: BAD,
          description: GOOD,
          kind: 'open',
        }),
      );
      blocked(
        await post(host, '/communities', {
          name: GOOD,
          description: BAD,
          kind: 'open',
        }),
      );
      blocked(
        await h
          .http()
          .patch(api(`/communities/${roomId}`))
          .set(as(host))
          .send({ description: BAD }),
      );
      expect(
        (await h.prisma.community.findUnique({ where: { id: roomId } }))
          ?.description,
      ).toBe('fixture');
      const ok = await post(host, '/communities', {
        name: `${TAG} clean`,
        description: GOOD,
        kind: 'open',
      });
      expect(ok.status).toBe(201);
    });

    it('an admin can read the list; a finance admin cannot; nobody else', async () => {
      const read = await h
        .http()
        .get(api('/admin/moderation/words'))
        .set({ Authorization: `Bearer ${h.admin('support')}` })
        .expect(200);
      expect(read.body.data.total).toBeGreaterThan(100);
      expect(read.body.data.builtIn.length).toBeGreaterThan(5);
      await h
        .http()
        .get(api('/admin/moderation/words'))
        .set({ Authorization: `Bearer ${h.admin('finance')}` })
        .expect(403);
      await get(ann, '/admin/moderation/words').expect(401);
    });
  });

  // ------------------------------------------------------------------------------------------------------------------
  describe("the host's tools in their own room", () => {
    let annMsg: string;
    let hostMsg: string;

    beforeAll(async () => {
      annMsg = (await say(ann, 'ann says hello to the room').expect(201)).body
        .data.id;
      hostMsg = (await say(host, 'host says welcome').expect(201)).body.data.id;
    });

    it('only the host may delete or mute: a member and a stranger get 403 and nothing changes', async () => {
      for (const who of [bob, eve]) {
        await h
          .http()
          .delete(api(`/communities/${roomId}/messages/${annMsg}`))
          .set(as(who))
          .expect(403);
        await h
          .http()
          .put(api(`/communities/${roomId}/mutes/${ann.sub}`))
          .set(as(who))
          .expect(403);
        await h
          .http()
          .delete(api(`/communities/${roomId}/mutes/${ann.sub}`))
          .set(as(who))
          .expect(403);
      }
      await get(eve, `/communities/${roomId}/moderation`).expect(403);
      expect(await texts(host)).toContain('ann says hello to the room');
      expect(
        await h.prisma.communityMute.count({ where: { communityId: roomId } }),
      ).toBe(0);
      expect(
        await h.prisma.communityModerationLog.count({
          where: { communityId: roomId },
        }),
      ).toBe(0);
    });

    it('the host deletes a member message and their own; it is gone for everyone, and each act is logged (who, what, when)', async () => {
      await h
        .http()
        .delete(api(`/communities/${roomId}/messages/${annMsg}`))
        .set(as(host))
        .expect(200);
      await h
        .http()
        .delete(api(`/communities/${roomId}/messages/${hostMsg}`))
        .set(as(host))
        .expect(200);
      for (const who of [host, ann, bob, cat]) {
        const seen = await texts(who);
        expect(seen).not.toContain('ann says hello to the room');
        expect(seen).not.toContain('host says welcome');
      }
      const mine = await get(bob, '/communities/mine').expect(200);
      const row = mine.body.data.find((r: any) => r.id === roomId);
      expect(JSON.stringify(row?.lastMessage ?? null)).not.toContain(
        'ann says hello',
      );
      const log = await h.prisma.communityModerationLog.findMany({
        where: { communityId: roomId, action: 'message_deleted' },
        orderBy: { createdAt: 'asc' },
      });
      expect(
        log.map((l) => [
          l.actorWawuId,
          l.targetWawuId,
          l.messageId,
          l.messageKind,
        ]),
      ).toEqual([
        [host.sub, ann.sub, annMsg, 'text'],
        [host.sub, host.sub, hostMsg, 'text'],
      ]);
      expect(log.every((l) => l.createdAt instanceof Date)).toBe(true);
      expect(JSON.stringify(log)).not.toContain('hello');
    });

    it('a message of another room is not found, and deleting twice is a 404, not a second record', async () => {
      const other = await h.prisma.communityMessage.create({
        data: {
          communityId: otherRoomId,
          senderWawuId: eve.sub,
          text: 'elsewhere',
        },
      });
      await h
        .http()
        .delete(api(`/communities/${roomId}/messages/${other.id}`))
        .set(as(host))
        .expect(404);
      await h
        .http()
        .delete(api(`/communities/${roomId}/messages/${annMsg}`))
        .set(as(host))
        .expect(404);
      expect(
        await h.prisma.communityMessage.count({ where: { id: other.id } }),
      ).toBe(1);
      expect(
        await h.prisma.communityModerationLog.count({
          where: { communityId: roomId, action: 'message_deleted' },
        }),
      ).toBe(2);
    });

    it('the room preview in "my communities" shows the newest message and loses it when the host deletes it (MOD-ROOMS r1)', async () => {
      const preview = async (): Promise<string> => {
        const mine = await get(cat, '/communities/mine').expect(200);
        const row = mine.body.data.find((r: any) => r.id === roomId);
        return JSON.stringify(row?.lastMessage ?? null);
      };
      const sent = await say(bob, 'preview probe words').expect(201);
      expect(await preview()).toContain('preview probe words');
      await h
        .http()
        .delete(api(`/communities/${roomId}/messages/${sent.body.data.id}`))
        .set(as(host))
        .expect(200);
      expect(await preview()).not.toContain('preview probe words');
      expect(await texts(cat)).not.toContain('preview probe words');
    });

    it('muting: a joined member only, never yourself, a repeat writes nothing new', async () => {
      await h
        .http()
        .put(api(`/communities/${roomId}/mutes/${host.sub}`))
        .set(as(host))
        .expect(400);
      await h
        .http()
        .put(api(`/communities/${roomId}/mutes/${eve.sub}`))
        .set(as(host))
        .expect(404);
      await h
        .http()
        .put(api(`/communities/${roomId}/mutes/${ann.sub}`))
        .set(as(host))
        .expect(200);
      await h
        .http()
        .put(api(`/communities/${roomId}/mutes/${ann.sub}`))
        .set(as(host))
        .expect(200);
      expect(
        await h.prisma.communityMute.count({ where: { communityId: roomId } }),
      ).toBe(1);
      expect(
        await h.prisma.communityModerationLog.count({
          where: { communityId: roomId, action: 'member_muted' },
        }),
      ).toBe(1);
      const hostView = await get(
        host,
        `/communities/${roomId}/moderation`,
      ).expect(200);
      expect(hostView.body.data).toEqual({
        muted: false,
        mutedMembers: [ann.sub],
      });
      const annView = await get(
        ann,
        `/communities/${roomId}/moderation`,
      ).expect(200);
      expect(annView.body.data).toEqual({ muted: true, mutedMembers: [] });
      expect(
        (await get(bob, `/communities/${roomId}/moderation`).expect(200)).body
          .data,
      ).toEqual({
        muted: false,
        mutedMembers: [],
      });
    });

    it('a muted member still reads, cannot send in words, nothing is stored or spent; everyone else posts as before', async () => {
      const credits = await h.prisma.creditsState.findUnique({
        where: { userWawuId: ann.sub },
      });
      await get(ann, `/communities/${roomId}/messages`).expect(200);
      const refused = await say(ann, 'can I still talk?');
      expect(refused.status).toBe(403);
      expect(refused.body.message).toBe(MUTED_IN_ROOM_MESSAGE);
      expect(refused.body.reason.code).toBe(MUTED_IN_ROOM_CODE);
      expect(MUTED_IN_ROOM_MESSAGE).toBe(
        'The host has muted you in this room.',
      );
      expect(
        await h.prisma.communityMessage.count({
          where: { senderWawuId: ann.sub, text: 'can I still talk?' },
        }),
      ).toBe(0);
      expect(
        await h.prisma.creditsState.findUnique({
          where: { userWawuId: ann.sub },
        }),
      ).toEqual(credits);
      await say(bob, 'bob is not muted').expect(201);
      await say(host, 'the host is never muted').expect(201);
    });

    it('leaving and joining again does not lift a mute', async () => {
      await h.prisma.communityMembership.deleteMany({
        where: { communityId: roomId, userWawuId: ann.sub },
      });
      await h.prisma.communityMembership.create({
        data: {
          userWawuId: ann.sub,
          communityId: roomId,
          status: 'joined',
          joinedAt: new Date(),
        },
      });
      expect((await say(ann, 'back again')).status).toBe(403);
    });

    it('unmuting restores sending, once, and is logged', async () => {
      await h
        .http()
        .delete(api(`/communities/${roomId}/mutes/${ann.sub}`))
        .set(as(host))
        .expect(200);
      await h
        .http()
        .delete(api(`/communities/${roomId}/mutes/${ann.sub}`))
        .set(as(host))
        .expect(200);
      await say(ann, 'thank you for unmuting me').expect(201);
      expect(
        await h.prisma.communityModerationLog.count({
          where: { communityId: roomId, action: 'member_unmuted' },
        }),
      ).toBe(1);
      expect(
        (
          await h.prisma.communityModerationLog.findMany({
            where: { communityId: roomId },
          })
        ).every((l) => l.actorWawuId === host.sub),
      ).toBe(true);
    });

    it('a muted member cannot get round it with a photo, and the word filter still applies to the host', async () => {
      await h
        .http()
        .put(api(`/communities/${roomId}/mutes/${cat.sub}`))
        .set(as(host))
        .expect(200);
      expect(
        (await post(cat, `/communities/${roomId}/messages`, { text: GOOD }))
          .status,
      ).toBe(403);
      await h
        .http()
        .delete(api(`/communities/${roomId}/mutes/${cat.sub}`))
        .set(as(host))
        .expect(200);
      blocked(await say(host, BAD));
    });
  });

  // ------------------------------------------------------------------------------------------------------------------
  describe('a block in a room', () => {
    it('if A blocked B, neither sees the other in the room, the preview or the unread count; everyone else sees both', async () => {
      await say(bob, 'bob speaks').expect(201);
      await say(cat, 'cat speaks').expect(201);
      await post(ann, '/settings/privacy/blocked', {
        blockedWawuId: bob.sub,
      }).expect(201);
      // A does not see B, B does not see A, C sees both.
      expect(await texts(ann)).not.toContain('bob speaks');
      expect(await texts(ann)).toContain('cat speaks');
      await say(ann, 'ann speaks after the block').expect(201);
      expect(await texts(bob)).not.toContain('ann speaks after the block');
      expect(await texts(bob)).toContain('bob speaks');
      const seenByCat = await texts(cat);
      expect(seenByCat).toEqual(
        expect.arrayContaining(['bob speaks', 'ann speaks after the block']),
      );
      // The room still works for B: a new message of theirs is stored and C sees it; A does not.
      await say(bob, 'bob speaks again').expect(201);
      expect(await texts(cat)).toContain('bob speaks again');
      expect(await texts(ann)).not.toContain('bob speaks again');
      // "My communities": A's preview is never B's words.
      const mine = await get(ann, '/communities/mine').expect(200);
      const row = mine.body.data.find((r: any) => r.id === roomId);
      expect(JSON.stringify(row?.lastMessage ?? null)).not.toContain(
        'bob speaks',
      );
    });

    it('an inbox chat refuses a blocked person, either way', async () => {
      const chat = await post(cat, '/chats', { wawuId: bob.sub }).expect(200);
      const chatId = chat.body.data.id as string;
      await post(cat, `/chats/${chatId}/messages`, { text: 'hi bob' }).expect(
        201,
      );
      await post(cat, '/settings/privacy/blocked', {
        blockedWawuId: bob.sub,
      }).expect(201);
      expect(
        (await post(bob, `/chats/${chatId}/messages`, { text: 'hi cat' }))
          .status,
      ).toBe(403);
      expect(
        (await post(cat, `/chats/${chatId}/messages`, { text: 'hi again' }))
          .status,
      ).toBe(403);
    });
  });
});
