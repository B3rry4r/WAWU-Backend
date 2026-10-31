/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- supertest bodies are untyped JSON */
// USER-SUSPEND (R-121), what a suspended person looks like to everyone else. Their profile, pieces, comments, community
// messages and rooms are gone from every list REPORT-UGC filters (the feed in three sorts, following, search, closest, the
// creator shelf, Saved) and from every direct link (404, same words as a missing id), for a signed-in reader, a signed-out
// reader and somebody who bought the piece. The person still sees their own. Lifting puts everything back, and nothing
// was deleted. The whole Hub (AppModule), real database, mock WAWU ID.

import {
  boot,
  type Harness,
  type Who,
} from '../../../test/user-suspension/suspension-harness';

jest.setTimeout(180_000);

describe('USER-SUSPEND: hidden from everyone else', () => {
  let h: Harness;
  let zed: Who; // suspended creator
  let ola: Who; // another creator: the control
  let ana: Who; // a reader who follows zed and saved their piece
  let buyer: Who; // bought zed's piece before
  let pieceOne: string;
  let pieceTwo: string;
  let olaPiece: string;
  let zedComment: string;
  let olaComment: string;
  let olaRoom: string;
  let zedRoom: string;
  let zedMessage: string;
  let olaMessage: string;
  const TAG = `usph${Date.now().toString().slice(-8)}`;

  const as = (w: Who | null) =>
    w ? { Authorization: `Bearer ${w.token}` } : {};
  const get = (w: Who | null, url: string) =>
    h.http().get(`/api/hub${url}`).set(as(w));
  const ids = (res: { body: { data: unknown } }): string[] => {
    const d = res.body.data as
      Array<{ id: string }> | { items: Array<{ id: string }> } | null;
    if (!d) return []; // a 404: nothing there
    return (Array.isArray(d) ? d : d.items).map((i) => i.id);
  };

  /** Everything one reader can meet of zed, as plain values, so before / during / after compare. */
  async function seen(w: Who | null) {
    const q = 'perPage=100';
    const lists: Record<string, string[]> = {
      search: (
        (await get(w, `/search?q=${TAG}&tab=content`).expect(200)).body.data
          .content as Array<{ id: string }>
      ).map((i) => i.id),
      'public shelf': ids(
        await get(null, `/content/public/creator/${zed.sub}/content?${q}`),
      ),
    };
    if (w) {
      // The feed is for signed-in readers.
      lists['feed trending'] = ids(
        await get(w, `/content?${q}&sort=trending`).expect(200),
      );
      lists['feed recent'] = ids(
        await get(w, `/content?${q}&sort=recent`).expect(200),
      );
      lists['feed top'] = ids(
        await get(w, `/content?${q}&sort=top`).expect(200),
      );
      lists.closest = ids(await get(w, `/search/closest?q=${TAG}`).expect(200));
      lists.following = ids(
        await get(w, `/content?${q}&scope=following`).expect(200),
      );
      lists.shelf =
        (await get(w, `/users/${zed.sub}/content?${q}`)).status === 200
          ? ids(await get(w, `/users/${zed.sub}/content?${q}`))
          : [];
      lists.saved = (
        (await get(w, '/me/saved?type=content').expect(200)).body.data
          .items as Array<{ content: { id: string } | null }>
      )
        .map((i) => i.content?.id)
        .filter((x): x is string => !!x);
    }
    const creators = (await get(w, `/search?q=ushzed&tab=creators`).expect(200))
      .body.data.creators as Array<{ wawuUserId: string }>;
    // Comments are for signed-in readers.
    const comments = w
      ? ((await get(w, `/content/${olaPiece}/comments?perPage=100`).expect(200))
          .body.data as Array<{ id: string }>)
      : [];
    const status = async (url: string) => (await get(w, url)).status;
    // The public routes (no sign-in needed) and the directories: the id must not appear anywhere in the answer.
    const mentions = async (url: string, id: string) =>
      JSON.stringify((await get(w, url)).body).includes(id);
    return {
      pub: {
        piece: await status(`/content/public/${pieceOne}`),
        profile: await status(`/users/public/${zed.sub}`),
        publicProfile: w
          ? await status(`/users/${zed.sub}/public-profile`)
          : null, // signed-in only
        featuredHasPiece: await mentions('/content/public/featured', pieceOne),
        exploreCreators: await mentions(
          '/explore/creators?perPage=100',
          zed.sub,
        ),
        exploreFeatured: await mentions('/explore/featured-creators', zed.sub),
        exploreSuggested: await mentions(
          '/explore/suggested-creators',
          zed.sub,
        ),
        people: await mentions('/search/people?q=ushzed', zed.sub),
      },
      lists: Object.fromEntries(
        Object.entries(lists).map(([k, v]) => [
          k,
          v.filter((i) => [pieceOne, pieceTwo].includes(i)).sort(),
        ]),
      ),
      creatorInSearch: creators.some((c) => c.wawuUserId === zed.sub),
      commentIds: comments
        .map((c) => c.id)
        .filter((i) => [zedComment, olaComment].includes(i))
        .sort(),
      links: {
        piece: await status(`/content/${pieceOne}`),
        profile: await status(`/users/${zed.sub}/visitor-profile`),
        fields: await status(`/users/${zed.sub}/profile-fields`),
        shelf: await status(`/users/${zed.sub}/content`),
        comments: await status(`/content/${pieceOne}/comments`),
      },
    };
  }

  async function roomView(w: Who) {
    const room = await get(w, `/communities/${zedRoom}`);
    const msgs = (
      await get(w, `/communities/${olaRoom}/messages?perPage=100`).expect(200)
    ).body.data as Array<{ id: string }>;
    return {
      zedRoom: room.status,
      messages: msgs
        .map((m) => m.id)
        .filter((i) => [zedMessage, olaMessage].includes(i))
        .sort(),
    };
  }

  beforeAll(async () => {
    h = await boot('ush');
    [zed, ola, ana, buyer] = [
      await h.person('zed', 'creator'),
      await h.person('ola', 'creator'),
      await h.person('ana'),
      await h.person('buyer'),
    ];
    const piece = async (creator: Who, n: string) =>
      (
        await h.prisma.contentPiece.create({
          data: {
            slug: `${TAG}-${n}`,
            creatorWawuId: creator.sub,
            contentType: 'video',
            title: `${TAG} ${n}`,
            description: 'fixture',
            category: 'fixture',
            accessType: 'paid',
            price: 100,
            previewAssetUrl: 'https://example.invalid/p.jpg',
            status: 'live',
          },
          select: { id: true },
        })
      ).id;
    pieceOne = await piece(zed, 'one');
    pieceTwo = await piece(zed, 'two');
    olaPiece = await piece(ola, 'ola');
    zedComment = (
      await h.prisma.comment.create({
        data: {
          contentId: olaPiece,
          authorWawuId: zed.sub,
          text: `zed says ${TAG}`,
        },
        select: { id: true },
      })
    ).id;
    olaComment = (
      await h.prisma.comment.create({
        data: {
          contentId: olaPiece,
          authorWawuId: ola.sub,
          text: `ola says ${TAG}`,
        },
        select: { id: true },
      })
    ).id;
    const room = async (host: Who, n: string) =>
      (
        await h.prisma.community.create({
          data: {
            name: `${TAG} ${n}`,
            description: 'x',
            hostWawuId: host.sub,
            kind: 'open',
          },
          select: { id: true },
        })
      ).id;
    olaRoom = await room(ola, 'ola room');
    zedRoom = await room(zed, 'zed room');
    await h.prisma.communityMembership.createMany({
      data: [
        { userWawuId: ana.sub, communityId: olaRoom, status: 'joined' },
        { userWawuId: zed.sub, communityId: olaRoom, status: 'joined' },
        { userWawuId: ana.sub, communityId: zedRoom, status: 'joined' },
      ],
    });
    zedMessage = (
      await h.prisma.communityMessage.create({
        data: {
          communityId: olaRoom,
          senderWawuId: zed.sub,
          text: `zed room msg ${TAG}`,
        },
        select: { id: true },
      })
    ).id;
    olaMessage = (
      await h.prisma.communityMessage.create({
        data: {
          communityId: olaRoom,
          senderWawuId: ola.sub,
          text: `ola room msg ${TAG}`,
        },
        select: { id: true },
      })
    ).id;
    for (const w of [ana]) {
      await h.prisma.followRelationship.create({
        data: { followerWawuId: w.sub, followingWawuId: zed.sub },
      });
      await h.prisma.savedItem.create({
        data: { userWawuId: w.sub, contentId: pieceOne },
      });
    }
    // The buyer bought pieceOne before: a block keeps that copy, a suspension does not.
    await h.prisma.purchase.create({
      data: {
        type: 'content',
        buyerWawuId: buyer.sub,
        contentId: pieceOne,
        creatorWawuId: zed.sub,
        amount: 100,
        commissionRate: 0.15,
        status: 'completed',
        flutterwaveTxRef: `${TAG}-buy`,
      } as never,
    });
  });

  afterAll(async () => {
    if (h) {
      const people = [zed, ola, ana, buyer].filter(Boolean).map((p) => p.sub);
      await h.prisma.purchase.deleteMany({
        where: { buyerWawuId: { in: people } },
      });
      await h.prisma.savedItem.deleteMany({
        where: { userWawuId: { in: people } },
      });
      await h.prisma.followRelationship.deleteMany({
        where: { followerWawuId: { in: people } },
      });
      await h.prisma.communityMessage.deleteMany({
        where: { id: { in: [zedMessage, olaMessage].filter(Boolean) } },
      });
      await h.prisma.communityMembership.deleteMany({
        where: { userWawuId: { in: people } },
      });
      await h.prisma.community.deleteMany({
        where: { name: { startsWith: TAG } },
      });
      await h.prisma.comment.deleteMany({
        where: { id: { in: [zedComment, olaComment].filter(Boolean) } },
      });
      await h.prisma.contentPiece.deleteMany({
        where: { slug: { startsWith: TAG } },
      });
      await h.cleanup();
      await h.stop();
    }
  });

  let before: Awaited<ReturnType<typeof seen>>;
  let beforeRooms: Awaited<ReturnType<typeof roomView>>;

  it('before the suspension, zed is on every surface for a signed-in reader, a signed-out reader and the buyer', async () => {
    before = await seen(ana);
    beforeRooms = await roomView(ana);
    for (const [name, got] of Object.entries(before.lists)) {
      if (name === 'public shelf' || name === 'search') continue;
      // Ana saved only the first piece.
      expect([name, got]).toEqual([
        name,
        name === 'saved' ? [pieceOne] : [pieceOne, pieceTwo].sort(),
      ]);
    }
    expect(before.creatorInSearch).toBe(true);
    expect(before.commentIds).toEqual([olaComment, zedComment].sort());
    expect(before.links).toEqual({
      piece: 200,
      profile: 200,
      fields: 200,
      shelf: 200,
      comments: 200,
    });
    expect(beforeRooms).toEqual({
      zedRoom: 200,
      messages: [olaMessage, zedMessage].sort(),
    });
    const out = await seen(null);
    expect([out.pub.piece, out.pub.profile]).toEqual([200, 200]);
    expect((await seen(ana)).pub.publicProfile).toBe(200);
    expect((await seen(buyer)).links.piece).toBe(200);
  });

  it('a moderator suspends zed', async () => {
    await h
      .http()
      .post(`/api/hub/admin/users/${zed.sub}/suspend`)
      .set({ Authorization: `Bearer ${h.admin('superadmin')}` })
      .send({ reason: 'spam', note: 'hidden spec' })
      .expect(200);
  });

  it('zed leaves every list and every direct link answers 404, for a signed-in reader, a signed-out reader and the buyer', async () => {
    for (const reader of [ana, null, buyer]) {
      const now = await seen(reader);
      for (const [name, got] of Object.entries(now.lists))
        expect([name, got]).toEqual([name, []]);
      expect(now.creatorInSearch).toBe(false);
      if (reader) {
        expect(now.commentIds).toEqual([olaComment]);
        expect(now.links).toEqual({
          piece: 404,
          profile: 404,
          fields: 404,
          shelf: 404,
          comments: 404,
        });
      }
      // The public routes and the directories, signed in or out.
      expect([now.pub.piece, now.pub.profile]).toEqual([404, 404]);
      if (reader) expect(now.pub.publicProfile).toBe(404);
      expect([
        now.pub.featuredHasPiece,
        now.pub.exploreCreators,
        now.pub.exploreFeatured,
        now.pub.exploreSuggested,
        now.pub.people,
      ]).toEqual([false, false, false, false, false]);
    }
    const rooms = await roomView(ana);
    expect(rooms).toEqual({ zedRoom: 404, messages: [olaMessage] });
    // The same words as an id that never existed.
    const missing = await get(
      ana,
      '/content/00000000-0000-4000-8000-0000000000aa',
    );
    const hidden = await get(ana, `/content/${pieceOne}`);
    expect(hidden.body.message).toBe(missing.body.message);
  });

  it('the control (another creator) is untouched', async () => {
    expect((await get(ana, `/content/${olaPiece}`)).status).toBe(200);
    expect((await get(ana, `/users/${ola.sub}/visitor-profile`)).status).toBe(
      200,
    );
  });

  it('zed still sees their own things, and nothing was deleted', async () => {
    const own = await seen(zed);
    expect(own.links.piece).toBe(200);
    expect(own.links.profile).toBe(200);
    expect(own.lists.shelf).toEqual([pieceOne, pieceTwo].sort());
    expect(
      await h.prisma.contentPiece.count({
        where: { id: { in: [pieceOne, pieceTwo] } },
      }),
    ).toBe(2);
    expect(await h.prisma.comment.count({ where: { id: zedComment } })).toBe(1);
    expect(
      await h.prisma.communityMessage.count({ where: { id: zedMessage } }),
    ).toBe(1);
  });

  it('lifting restores everything, exactly as it was', async () => {
    await h
      .http()
      .post(`/api/hub/admin/users/${zed.sub}/lift`)
      .set({ Authorization: `Bearer ${h.admin('support')}` })
      .send({ note: 'hidden spec lift' })
      .expect(200);
    expect(await seen(ana)).toEqual(before);
    expect(await roomView(ana)).toEqual(beforeRooms);
    expect((await seen(buyer)).links.piece).toBe(200);
  });
});
