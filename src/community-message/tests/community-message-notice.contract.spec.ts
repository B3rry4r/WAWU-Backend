import { randomUUID } from 'crypto';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationModule } from '../../notification/notification.module';
import { NotificationService } from '../../notification/notification.service';
import { CommunityPassAccessModule } from '../../community/pass/community-pass-access.module';
import { CommunityPassAccess } from '../../community/pass/community-pass-access.service';
import { PushSenderService } from '../../push/push-sender.service';
import { CommunityMessageService } from '../community-message.service';
import { CommunityMessageNoticeService } from '../community-message-notice.service';

/**
 * FIX-105 (R-81, owner, 24 Oct 2026: "New messages, grouped"). The grouped
 * "new messages" notice, against the real database. Messages are written with
 * a sent time in a window of 2024 that nothing else in the database uses, and
 * the sweep's cursor is placed just before it, so the pass folds exactly these
 * messages and no other spec's. Every row is removed afterwards.
 */
const SETTLE = 1;
const MIN = 60_000;
/** The window the spec lives in: no other spec writes a message then. */
const BASE = Date.UTC(2024, 5, 1, 10, 0, 0);

const at = (minutes: number, seconds = 0): Date =>
  new Date(BASE + minutes * MIN + seconds * 1000);

describe('community message notices (FIX-105)', () => {
  let prisma: PrismaService;
  let notifications: NotificationService;
  let passAccess: CommunityPassAccess;
  let sweep: CommunityMessageNoticeService;

  const run = randomUUID().slice(0, 8);
  const HOST = `fix105-host-${run}`;
  const SENDER = `fix105-c-${run}`;
  const A = `fix105-a-${run}`;
  const B = `fix105-b-${run}`;
  const D = `fix105-d-${run}`;
  const LEFT = `fix105-left-${run}`;
  const PENDING = `fix105-pending-${run}`;
  const fillers = Array.from({ length: 195 }, (_, i) => `fix105-m${i}-${run}`);
  const roomIds: string[] = [];
  const everyone = [HOST, SENDER, A, B, D, LEFT, PENDING, ...fillers];
  let room: string;

  async function post(
    communityId: string,
    sender: string,
    when: Date,
  ): Promise<void> {
    await prisma.communityMessage.create({
      data: {
        communityId,
        senderWawuId: sender,
        text: 'hello',
        costInCredits: 0,
        sentAt: when,
      },
    });
  }

  /**
   * Puts the cursor just before a window and runs one pass whose window ends
   * `windowSeconds` later, as a real window ends soon after its messages (the
   * notices remember how far they counted, so a window must not end long after
   * the messages a spec wrote).
   */
  async function foldWindow(
    from: Date,
    service: CommunityMessageNoticeService = sweep,
    windowSeconds = 90,
  ) {
    await prisma.communityNoticeCursor.upsert({
      where: { id: 1 },
      create: { id: 1, countedUpTo: from, leaseUntil: null },
      update: { countedUpTo: from, leaseUntil: null },
    });
    return service.runOnce(SETTLE, windowSeconds);
  }

  const noticesOf = (userWawuId: string, communityId = room) =>
    prisma.notification.findMany({
      where: {
        userWawuId,
        kind: 'community_messages',
        target: { is: { targetId: communityId } },
      },
      include: { communityMessageNotice: true },
      orderBy: { createdAt: 'asc' },
    });

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [PrismaModule, NotificationModule, CommunityPassAccessModule],
      providers: [CommunityMessageNoticeService],
    }).compile();
    prisma = module.get(PrismaService);
    notifications = module.get(NotificationService);
    passAccess = module.get(CommunityPassAccess);
    sweep = module.get(CommunityMessageNoticeService);
    // The spec owns the cursor row for its run; a sweep from another spec's
    // app must not find it mid-flight.
    await prisma.communityNoticeCursor.deleteMany({});

    const community = await prisma.community.create({
      data: {
        name: `FIX-105 test room ${run}`,
        description: 'A room for a spec.',
        hostWawuId: HOST,
        kind: 'open',
      },
    });
    room = community.id;
    roomIds.push(room);
    // 200 members: the sender, A, B, D, and 195 more. Host is the room's host
    // (no membership row). LEFT has no row at all; PENDING is still waiting.
    const joined = [SENDER, A, B, D, ...fillers];
    await prisma.communityMembership.createMany({
      data: [
        ...joined.map((userWawuId) => ({
          userWawuId,
          communityId: room,
          status: 'joined' as const,
          joinedAt: at(-60),
        })),
        {
          userWawuId: PENDING,
          communityId: room,
          status: 'pending' as const,
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({
      where: { userWawuId: { in: everyone }, kind: 'community_messages' },
    });
    await prisma.communityNoticeCursor.deleteMany({});
    await prisma.communityNoticeRetry.deleteMany({
      where: { communityId: { in: roomIds } },
    });
    await prisma.community.deleteMany({ where: { id: { in: roomIds } } });
    await prisma.notificationSettings.deleteMany({
      where: { userWawuId: { in: everyone } },
    });
    await prisma.blockedAccount.deleteMany({
      where: { userWawuId: { in: everyone } },
    });
    await prisma.pushToken.deleteMany({ where: { userWawuId: A } });
    await prisma.$disconnect();
  });

  it('a room of 200 members: three messages from one person are ONE notice for each other member, and the writes are a handful, not one per member', async () => {
    await post(room, SENDER, at(0, 1));
    await post(room, SENDER, at(0, 2));
    await post(room, SENDER, at(0, 3));

    const writes: Record<string, number> = {};
    const count = <T extends object>(
      target: T,
      key: keyof T,
      label: string,
    ) => {
      const original = (
        target[key] as unknown as (...a: unknown[]) => unknown
      ).bind(target);
      jest.spyOn(target as never, key as never).mockImplementation(((
        ...args: unknown[]
      ) => {
        writes[label] = (writes[label] ?? 0) + 1;
        return original(...args);
      }) as never);
    };
    count(prisma.notification, 'create', 'notification.create');
    count(prisma.notification, 'createMany', 'notification.createMany');
    count(prisma.notification, 'updateMany', 'notification.updateMany');
    count(prisma.notificationTarget, 'createMany', 'target.createMany');
    count(prisma.communityMessageNotice, 'createMany', 'notice.createMany');
    count(prisma, '$executeRaw', '$executeRaw');
    count(prisma, '$transaction', '$transaction');

    const report = await foldWindow(at(-1));
    jest.restoreAllMocks();

    expect(report).toMatchObject({ ran: true, messages: 3, communities: 1 });
    // Everyone but the sender and the two with no right to the room: the host
    // plus 199 members (A, B, D and 195 fillers... the sender is excluded).
    const expectedRecipients = [HOST, A, B, D, ...fillers];
    expect(report.created).toBe(expectedRecipients.length);
    expect(report.updated).toBe(0);
    for (const userWawuId of [HOST, A, B, D, fillers[0], fillers[194]]) {
      const rows = await noticesOf(userWawuId);
      expect(rows).toHaveLength(1);
      expect(rows[0].read).toBe(false);
      expect(rows[0].communityMessageNotice?.messageCount).toBe(3);
      expect(rows[0].body).toBe(
        `There are 3 new messages in “FIX-105 test room ${run}”.`,
      );
      expect(rows[0].actionHref).toBe(`/communities/${room}`);
    }
    // Never for their own messages, never for someone who left or is waiting.
    expect(await noticesOf(SENDER)).toHaveLength(0);
    expect(await noticesOf(LEFT)).toHaveLength(0);
    expect(await noticesOf(PENDING)).toHaveLength(0);

    // Bounded: 200 people, 3 messages, and the whole pass is a fixed handful of
    // statements (one chunk of 500 recipients), never one per member or message.
    expect(writes['notification.create'] ?? 0).toBe(0);
    expect(writes['notification.createMany']).toBe(1);
    expect(writes['target.createMany']).toBe(1);
    expect(writes['notice.createMany']).toBe(1);
    expect(writes['$transaction']).toBe(1);
    // The cursor claim and release are the only raw writes.
    expect(writes['$executeRaw']).toBeLessThanOrEqual(3);
    const total = Object.values(writes).reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(12);
    expect(total).toBeLessThan(expectedRecipients.length / 10);
  });

  it('the request that stores a message writes no notification at all', async () => {
    const before = await prisma.notification.count({
      where: { kind: 'community_messages' },
    });
    const spies = [
      jest.spyOn(notifications, 'emit'),
      jest.spyOn(notifications, 'emitMany'),
      jest.spyOn(notifications, 'emitCommunityMessages'),
      jest.spyOn(prisma.notification, 'create'),
      jest.spyOn(prisma.notification, 'createMany'),
    ];
    const allow = jest.fn().mockResolvedValue(undefined);
    const messages = new CommunityMessageService(
      prisma,
      {} as never,
      notifications,
      {} as never,
      { publish: jest.fn().mockResolvedValue(undefined) } as never,
      {
        assertRoomVisible: allow,
        hiddenFrom: jest.fn().mockResolvedValue([]),
      } as never,
      passAccess,
      { number: () => 0 } as never,
      { bucketLocation: jest.fn().mockResolvedValue(null) } as never,
    );
    for (let i = 0; i < 5; i += 1) {
      const sent = await messages.create(room, A, { text: `hi ${i}` });
      await prisma.communityMessage.delete({ where: { id: sent.message.id } });
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    jest.restoreAllMocks();
    expect(
      await prisma.notification.count({
        where: { kind: 'community_messages' },
      }),
    ).toBe(before);
  });

  it('more messages update the same notice (count and time), they do not add one; folding a window twice counts it once', async () => {
    const [first] = await noticesOf(B);
    await post(room, SENDER, at(1, 1));
    await post(room, D, at(1, 2));

    const report = await foldWindow(at(0, 30));
    // Everyone but the sender gets D's message too; D does not get their own.
    expect(report.messages).toBe(2);
    const [b] = await noticesOf(B);
    expect(await noticesOf(B)).toHaveLength(1);
    expect(b.id).toBe(first.id);
    expect(b.communityMessageNotice?.messageCount).toBe(5);
    expect(b.createdAt.getTime()).toBeGreaterThanOrEqual(
      first.createdAt.getTime(),
    );
    expect(b.body).toBe(
      `There are 5 new messages in “FIX-105 test room ${run}”.`,
    );
    expect(b.read).toBe(false);

    const [d] = await noticesOf(D);
    expect(d.communityMessageNotice?.messageCount).toBe(4); // 3 + the sender's new one, not their own
    const sender = await noticesOf(SENDER);
    expect(sender).toHaveLength(1); // D's message, one notice
    expect(sender[0].communityMessageNotice?.messageCount).toBe(1);

    // The same window again: nothing changes.
    const again = await foldWindow(at(0, 30));
    expect(again.created + again.updated).toBe(0);
    expect((await noticesOf(B))[0].communityMessageNotice?.messageCount).toBe(
      5,
    );
  });

  it('two Hub instances sweeping at once fold a window once', async () => {
    await post(room, SENDER, at(2, 1));
    await prisma.communityNoticeCursor.upsert({
      where: { id: 1 },
      create: { id: 1, countedUpTo: at(1, 30) },
      update: { countedUpTo: at(1, 30), leaseUntil: null },
    });
    const other = new CommunityMessageNoticeService(
      prisma,
      notifications,
      passAccess,
    );
    const [one, two] = await Promise.all([
      sweep.runOnce(SETTLE, 90),
      other.runOnce(SETTLE, 90),
    ]);
    expect([one.ran, two.ran].filter(Boolean)).toHaveLength(1);
    expect((await noticesOf(A))[0].communityMessageNotice?.messageCount).toBe(
      6,
    );
  });

  it('with the Community messages switch off the person gets no notice, and everyone else still does', async () => {
    await prisma.notificationSettings.upsert({
      where: { userWawuId: A },
      create: { userWawuId: A, communityMessages: false },
      update: { communityMessages: false },
    });
    await post(room, SENDER, at(3, 1));
    await foldWindow(at(2, 30));
    // A's notice stays where it was; B's moves on.
    expect((await noticesOf(A))[0].communityMessageNotice?.messageCount).toBe(
      6,
    );
    expect((await noticesOf(B))[0].communityMessageNotice?.messageCount).toBe(
      7,
    );
  });

  it('opening the room closes the notice; the next message starts a new one', async () => {
    await notifications.closeCommunityMessages(B, room);
    const [closed] = await noticesOf(B);
    expect(closed.read).toBe(true);

    await post(room, SENDER, at(4, 1));
    await foldWindow(at(3, 30));
    const rows = await noticesOf(B);
    expect(rows).toHaveLength(2);
    expect(rows[0].communityMessageNotice?.messageCount).toBe(7);
    expect(rows[0].read).toBe(true);
    expect(rows[1].communityMessageNotice?.messageCount).toBe(1);
    expect(rows[1].read).toBe(false);
  });

  it('a person who read the notice (or opened the room by the read mark) is not counted onto it again', async () => {
    const [open] = (await noticesOf(D)).filter((n) => !n.read);
    // D read the room after the notice's newest message, and the app did not close the notice.
    await prisma.communityReadMarker.upsert({
      where: { userWawuId_communityId: { userWawuId: D, communityId: room } },
      create: { userWawuId: D, communityId: room, lastReadAt: at(5) },
      update: { lastReadAt: at(5) },
    });
    await post(room, SENDER, at(6, 1));
    await foldWindow(at(5, 30));
    const rows = await noticesOf(D);
    const old = rows.find((n) => n.id === open.id)!;
    expect(old.read).toBe(true); // closed by the sweep
    const fresh = rows.filter((n) => !n.read);
    expect(fresh).toHaveLength(1);
    expect(fresh[0].communityMessageNotice?.messageCount).toBe(1);
  });

  it('a message from someone the person blocked (or who blocked them) does not count', async () => {
    await prisma.blockedAccount.create({
      data: { userWawuId: fillers[0], blockedWawuId: SENDER },
    });
    const before = (await noticesOf(fillers[1]))[0].communityMessageNotice!
      .messageCount;
    await post(room, SENDER, at(7, 1));
    await foldWindow(at(6, 30));
    expect(
      (await noticesOf(fillers[1]))[0].communityMessageNotice?.messageCount,
    ).toBe(before + 1);
    expect(
      (await noticesOf(fillers[0]))[0].communityMessageNotice?.messageCount,
    ).toBe(before);
  });

  it('a room that sells a pass: a member whose pass has ended is not told, the host is', async () => {
    const paid = await prisma.community.create({
      data: {
        name: `FIX-105 pass room ${run}`,
        description: 'A paid room for a spec.',
        hostWawuId: HOST,
        kind: 'private',
      },
    });
    roomIds.push(paid.id);
    await prisma.communityPassPrice.create({
      data: { communityId: paid.id, priceKobo: 100000n },
    });
    await prisma.communityMembership.createMany({
      data: [A, B, SENDER].map((userWawuId) => ({
        userWawuId,
        communityId: paid.id,
        status: 'joined' as const,
        joinedAt: at(-60),
      })),
    });
    await prisma.communityPass.create({
      data: {
        communityId: paid.id,
        userWawuId: B,
        startsAt: at(-60),
        endsAt: new Date(Date.now() + 10 * MIN * 60),
        priceKobo: 100000n,
        walletPaymentId: `fix105-pay-${run}`,
      },
    });
    await post(paid.id, SENDER, at(8, 1));
    await foldWindow(at(7, 30));
    expect(await noticesOf(HOST, paid.id)).toHaveLength(1);
    expect(await noticesOf(B, paid.id)).toHaveLength(1);
    expect(await noticesOf(A, paid.id)).toHaveLength(0); // no pass running
  });

  it('a notice is pushed once, when it is written; an update does not buzz the phone again', async () => {
    await prisma.pushToken.create({
      data: {
        userWawuId: A,
        expoPushToken: `ExponentPushToken[fix105-${run}]`,
        platform: 'android',
        createdAt: at(-120),
      },
    });
    // A's switch is off in this spec; turn it back on for the push check.
    await prisma.notificationSettings.update({
      where: { userWawuId: A },
      data: { communityMessages: true },
    });
    const pusher = new PushSenderService(
      prisma,
      notifications,
      {} as never,
      {} as never,
    );
    const quiet = await prisma.notification.findMany({
      where: { userWawuId: A, kind: 'community_messages' },
    });
    const before = await prisma.pushDelivery.count({
      where: { userWawuId: A, notificationId: { in: quiet.map((n) => n.id) } },
    });
    await pusher.enqueue();
    const after = await prisma.pushDelivery.count({
      where: { userWawuId: A, notificationId: { in: quiet.map((n) => n.id) } },
    });
    expect(after).toBeGreaterThan(before);
    expect(after - before).toBeLessThanOrEqual(quiet.length);
    // Another message updates the notice; the next enqueue adds nothing for it.
    await post(room, SENDER, at(9, 1));
    await foldWindow(at(8, 30));
    await pusher.enqueue();
    const final = await prisma.pushDelivery.count({
      where: { userWawuId: A, notificationId: { in: quiet.map((n) => n.id) } },
    });
    expect(final).toBe(after);
  });
  // ---------------------------------------------------------------------------
  // Round 2 (verifier finding H1): the count is exact whatever is replayed, and
  // one failing room never holds the others.
  // ---------------------------------------------------------------------------
  const P = fillers[2];
  const Q = fillers[3];

  async function makeRoom(label: string, members: string[]): Promise<string> {
    const made = await prisma.community.create({
      data: {
        name: `FIX-105 ${label} room ${run}`,
        description: 'A room for a spec.',
        hostWawuId: HOST,
        kind: 'open',
      },
    });
    roomIds.push(made.id);
    await prisma.communityMembership.createMany({
      data: members.map((userWawuId) => ({
        userWawuId,
        communityId: made.id,
        status: 'joined' as const,
        joinedAt: at(-60),
      })),
    });
    return made.id;
  }

  const countsOf = async (
    userWawuId: string,
    communityId: string,
  ): Promise<Array<number | undefined>> =>
    (await noticesOf(userWawuId, communityId)).map(
      (n) => n.communityMessageNotice?.messageCount,
    );

  it('a window folded again that ends later counts each message once, even for a notice already read (H1)', async () => {
    const r = await makeRoom('replay', [SENDER, P, Q]);
    await post(r, SENDER, at(40, 1));
    await post(r, SENDER, at(40, 2));
    await foldWindow(at(39, 30), sweep, 60); // the window ends at 40:30
    expect(await countsOf(P, r)).toEqual([2]);
    expect(await countsOf(HOST, r)).toEqual([2]);

    // A third message lands after that window. The Hub stopped before the
    // cursor moved, so the same start is folded again and now ends later.
    await post(r, SENDER, at(40, 45));
    const again = await foldWindow(at(39, 30), sweep, 120); // ends at 41:30
    expect(again.messages).toBe(3);
    expect(await countsOf(P, r)).toEqual([3]);
    expect(await countsOf(Q, r)).toEqual([3]);
    expect(await countsOf(HOST, r)).toEqual([3]);
    expect((await noticesOf(P, r))[0].body).toBe(
      `There are 3 new messages in “FIX-105 replay room ${run}”.`,
    );

    // P read the notice from the list (not by opening the room), and the
    // window is folded yet again: no new notice, no new count.
    await prisma.notification.updateMany({
      where: {
        userWawuId: P,
        kind: 'community_messages',
        target: { is: { targetId: r } },
      },
      data: { read: true },
    });
    const third = await foldWindow(at(39, 30), sweep, 150);
    expect(third.created + third.updated).toBe(0);
    expect(await noticesOf(P, r)).toHaveLength(1);
    expect(await countsOf(Q, r)).toEqual([3]);
  });

  it('a Hub that stops after writing the notices and before it moves the cursor counts nothing twice (H1)', async () => {
    const r = await makeRoom('crash', [SENDER, P, Q]);
    await post(r, SENDER, at(50, 1));
    await post(r, SENDER, at(50, 2));
    jest
      .spyOn(sweep as never, 'release' as never)
      .mockRejectedValueOnce(new Error('the Hub stopped') as never);
    await expect(foldWindow(at(49, 30), sweep, 60)).rejects.toThrow(
      'the Hub stopped',
    );
    jest.restoreAllMocks();
    // The notices are written; the cursor did not move and the claim is still held.
    expect(await countsOf(P, r)).toEqual([2]);
    const cursor = await prisma.communityNoticeCursor.findUnique({
      where: { id: 1 },
    });
    expect(cursor?.countedUpTo.getTime()).toBe(at(49, 30).getTime());

    // Another message, then the next Hub folds from the old cursor to a later end.
    await post(r, SENDER, at(50, 50));
    await foldWindow(at(49, 30), sweep, 120);
    expect(await countsOf(P, r)).toEqual([3]);
    expect(await countsOf(Q, r)).toEqual([3]);
    expect(await countsOf(HOST, r)).toEqual([3]);
    expect(await noticesOf(P, r)).toHaveLength(1);
  });

  it('one room that fails is put on a retry list and tried again; it never stops another room, however long it fails (H1)', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const bad = await makeRoom('failing', [SENDER, P]);
    const good = await makeRoom('healthy', [SENDER, Q]);
    const real = notifications.emitCommunityMessages.bind(notifications);
    jest
      .spyOn(notifications, 'emitCommunityMessages')
      .mockImplementation((community, entries, upTo) =>
        community.id === bad
          ? Promise.reject(new Error('this room cannot be written'))
          : real(community, entries, upTo),
      );

    await post(bad, SENDER, at(60, 1));
    await post(good, SENDER, at(60, 2));
    const first = await foldWindow(at(59, 30), sweep, 60); // ends at 60:30
    expect(first.ran).toBe(true);
    expect(await countsOf(Q, good)).toEqual([1]);
    expect(await noticesOf(P, bad)).toHaveLength(0);
    // The cursor moved past the window and the failing room is listed.
    const cursor = await prisma.communityNoticeCursor.findUnique({
      where: { id: 1 },
    });
    expect(cursor?.countedUpTo.getTime()).toBe(at(60, 30).getTime());
    const listed = await prisma.communityNoticeRetry.findUnique({
      where: { communityId: bad },
    });
    expect(listed?.fromAt.getTime()).toBe(at(59, 30).getTime());
    expect(listed?.attempts).toBe(1);

    // It fails again when its turn comes, and the healthy room still gets its notice.
    await prisma.communityNoticeRetry.update({
      where: { communityId: bad },
      data: { retryAt: new Date(0) },
    });
    await post(good, SENDER, at(61, 1));
    await post(bad, SENDER, at(61, 2));
    await foldWindow(at(60, 30), sweep, 60); // ends at 61:30
    expect(await countsOf(Q, good)).toEqual([2]);
    expect(await noticesOf(P, bad)).toHaveLength(0);
    const second = await prisma.communityNoticeRetry.findUnique({
      where: { communityId: bad },
    });
    expect(second?.attempts).toBe(2);
    expect(second?.retryAt.getTime()).toBeGreaterThan(Date.now());
    expect(second?.fromAt.getTime()).toBe(at(59, 30).getTime());

    // The room can be written again: its turn comes and it is folded from where it
    // failed, each message once.
    jest.restoreAllMocks();
    await prisma.communityNoticeRetry.update({
      where: { communityId: bad },
      data: { retryAt: new Date(0) },
    });
    await post(good, SENDER, at(62, 1));
    await foldWindow(at(61, 30), sweep, 60); // ends at 62:30
    expect(await countsOf(Q, good)).toEqual([3]);
    expect(await countsOf(P, bad)).toEqual([2]); // 60:01 and 61:02
    expect(await countsOf(HOST, bad)).toEqual([2]);
    expect(
      await prisma.communityNoticeRetry.findUnique({
        where: { communityId: bad },
      }),
    ).toBeNull();
    // Folded once more from the same start, nothing is counted twice.
    await foldWindow(at(61, 30), sweep, 60);
    expect(await countsOf(P, bad)).toEqual([2]);
  });

  it('a person who switched the notice off keeps an unread notice exactly as it was (L1)', async () => {
    const r = await makeRoom('muted', [SENDER, P, Q]);
    await post(r, SENDER, at(70, 1));
    await foldWindow(at(69, 30), sweep, 60);
    expect(await countsOf(P, r)).toEqual([1]);

    await prisma.notificationSettings.upsert({
      where: { userWawuId: P },
      create: { userWawuId: P, communityMessages: false },
      update: { communityMessages: false },
    });
    await post(r, SENDER, at(70, 50));
    await foldWindow(at(70, 30), sweep, 60);
    const [mine] = await noticesOf(P, r);
    expect(mine.read).toBe(false); // not marked read behind their back
    expect(mine.communityMessageNotice?.messageCount).toBe(1);
    expect(await noticesOf(P, r)).toHaveLength(1);
    expect(await countsOf(Q, r)).toEqual([2]); // others are counted as ever
  });
});
