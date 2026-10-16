import { randomUUID } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AdminRole, AdminUserStatus } from '../../../../generated/prisma/enums';
import type { AdminUserView } from '../../auth/admin-user-view.type';
import { AdminContentReviewModule } from '../admin-content-review.module';
import { AdminContentReviewService } from '../admin-content-review.service';

/**
 * TIER-02 round 3, D5: an admin's take-down, reject or approve changes a
 * piece's status and may move the creator's place counter (`slotsUsed`) with
 * it. The counter must stay equal to the pieces that hold a place (not
 * rejected, not removed) however the staff, the creator and a second
 * request interleave.
 *
 * On the real database. The interleavings are made on purpose, not hoped
 * for: a second transaction takes the piece's row lock and holds it, the
 * admin's request is started and waits until the database says it is blocked
 * on that lock (so it has already read the piece), and only then the
 * competing change is written and committed. What the request does next is
 * exactly what a request that lost a real race does.
 *
 * Every person and piece is this spec's own (fresh ids) and is removed in
 * afterAll.
 */

const STORAGE_ENV: Record<string, string> = {
  ADMIN_JWT_SECRET: 'status-race-access-secret-0123456789',
  ADMIN_JWT_REFRESH_SECRET: 'status-race-refresh-secret-0123456789',
  STORAGE_ENDPOINT: 'https://bucket.example-storage.dev',
  STORAGE_ACCESS_KEY_ID: 'status-race-key',
  STORAGE_SECRET_ACCESS_KEY: 'status-race-secret',
  STORAGE_BUCKET: 'status-race-bucket',
  STORAGE_REGION: 'auto',
};

const ADMIN: AdminUserView = {
  id: randomUUID(),
  email: 'status-race@admin.test.wawu.dev',
  name: 'Status Race',
  role: AdminRole.superadmin,
  status: AdminUserStatus.active,
  lastLoginAt: null,
  createdAt: new Date(),
};

type Status = 'pending' | 'live' | 'rejected' | 'removed';

describe('Admin status changes keep the creator places true (TIER-02 round 3, D5)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let service: AdminContentReviewService;
  const envSnapshot: Record<string, string | undefined> = {};
  const people: string[] = [];
  let seq = 0;

  /** A creator holding exactly the places their pieces hold. */
  async function creatorWith(statuses: Status[]) {
    const wawuUserId = randomUUID();
    people.push(wawuUserId);
    const pieces: { id: string }[] = [];
    for (const status of statuses) {
      seq += 1;
      pieces.push(
        await prisma.contentPiece.create({
          data: {
            slug: `status-race-${randomUUID()}`,
            creatorWawuId: wawuUserId,
            contentType: 'video',
            title: `Status race ${seq}`,
            description: 'A piece the status race spec makes.',
            category: 'status-race-spec',
            accessType: 'paid',
            price: 1500,
            previewAssetUrl: 'https://cdn.example.com/p.jpg',
            fullAssetUrl: 'https://cdn.example.com/f.mp4',
            status,
          },
        }),
      );
    }
    await prisma.creatorState.create({
      data: { wawuUserId, slotsUsed: holding(statuses) },
    });
    return { wawuUserId, pieces };
  }
  const holding = (statuses: Status[]) =>
    statuses.filter((s) => s === 'pending' || s === 'live').length;
  const slots = async (wawuUserId: string) =>
    (
      await prisma.creatorState.findUniqueOrThrow({
        where: { wawuUserId },
      })
    ).slotsUsed;
  const held = (wawuUserId: string) =>
    prisma.contentPiece.count({
      where: {
        creatorWawuId: wawuUserId,
        status: { in: ['pending', 'live'] },
      },
    });
  const reviewsOf = (contentId: string) =>
    prisma.adminContentReview.findMany({
      where: { contentId },
      orderBy: { reviewedAt: 'asc' },
    });
  const statusOf = async (id: string) =>
    (await prisma.contentPiece.findUniqueOrThrow({ where: { id } })).status;

  /** What the creator's own change does to a piece and the counter, in one transaction. */
  type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];
  const flip = async (
    tx: Tx,
    id: string,
    from: Status,
    to: Status,
    wawuUserId: string,
    placeChange: -1 | 0 | 1,
  ) => {
    const changed = await tx.contentPiece.updateMany({
      where: { id, status: from },
      data: { status: to },
    });
    expect(changed.count).toBe(1);
    if (placeChange !== 0)
      await tx.creatorState.updateMany({
        where: { wawuUserId },
        data: { slotsUsed: { increment: placeChange } },
      });
  };

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** Until a request of this database is waiting on a lock another holds. */
  async function untilSomeoneWaitsOnALock(): Promise<void> {
    for (let i = 0; i < 400; i += 1) {
      const rows = await prisma.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      if (Number(rows[0].n) > 0) return;
      await sleep(25);
    }
    throw new Error('no request ever waited on the row lock');
  }

  /**
   * Holds the piece's row lock, starts `request`, waits until the request is
   * blocked on that lock (it has read the piece by then), then lets `change`
   * write and commit and the request go on. Returns what the request did.
   */
  async function raceAgainst<T>(
    pieceId: string,
    change: (tx: Tx) => Promise<void>,
    request: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
    let locked!: () => void;
    const hasLock = new Promise<void>((r) => (locked = r));
    let release!: () => void;
    const mayWrite = new Promise<void>((r) => (release = r));
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "ContentPiece" WHERE id = ${pieceId} FOR UPDATE`;
        locked();
        await mayWrite;
        await change(tx);
      },
      { timeout: 30_000, maxWait: 30_000 },
    );
    await hasLock;
    const pending = request().then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await untilSomeoneWaitsOnALock();
    release();
    await holder;
    return pending;
  }

  beforeAll(async () => {
    for (const [k, v] of Object.entries(STORAGE_ENV)) {
      envSnapshot[k] = process.env[k];
      process.env[k] = v;
    }
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
        AdminContentReviewModule,
      ],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    service = moduleRef.get(AdminContentReviewService);
  });

  afterAll(async () => {
    const pieces = await prisma.contentPiece.findMany({
      where: { creatorWawuId: { in: people } },
      select: { id: true },
    });
    const ids = pieces.map((p) => p.id);
    await prisma.adminContentReview.deleteMany({
      where: { contentId: { in: ids } },
    });
    await prisma.contentPiece.deleteMany({ where: { id: { in: ids } } });
    await prisma.creatorState.deleteMany({
      where: { wawuUserId: { in: people } },
    });
    await moduleRef.close();
    for (const [k, v] of Object.entries(envSnapshot)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  describe('take-down', () => {
    it('a take-down that read a waiting piece before an admin turned it down returns no second place', async () => {
      const { wawuUserId, pieces } = await creatorWith(['pending', 'pending']);
      const [target] = pieces;
      expect(await slots(wawuUserId)).toBe(2);

      const result = await raceAgainst(
        target.id,
        // The other admin's reject: the piece is turned down and its place
        // goes back, in one transaction.
        (tx) => flip(tx, target.id, 'pending', 'rejected', wawuUserId, -1),
        () => service.takeDown(target.id, { reason: 'Taken down.' }, ADMIN),
      );

      expect(result.ok).toBe(true);
      expect(await statusOf(target.id)).toBe('removed');
      // One place back (the reject's), not two: one piece is still waiting.
      expect(await slots(wawuUserId)).toBe(1);
      expect(await held(wawuUserId)).toBe(1);
      const [row] = await reviewsOf(target.id);
      expect(row).toMatchObject({
        decision: 'removed',
        previousStatus: 'rejected',
        newStatus: 'removed',
        slotReturned: false,
      });
    });

    it('a take-down that read a turned-down piece before the creator sent it again takes the place back', async () => {
      const { wawuUserId, pieces } = await creatorWith(['rejected', 'pending']);
      const [target] = pieces;
      expect(await slots(wawuUserId)).toBe(1);

      const result = await raceAgainst(
        target.id,
        // The creator's "Send again": the piece is waiting again and takes a
        // place, in one transaction.
        (tx) => flip(tx, target.id, 'rejected', 'pending', wawuUserId, 1),
        () => service.takeDown(target.id, { reason: 'Taken down.' }, ADMIN),
      );

      expect(result.ok).toBe(true);
      expect(await statusOf(target.id)).toBe('removed');
      // The place the resubmit took is back: the other piece holds the one.
      expect(await slots(wawuUserId)).toBe(1);
      expect(await held(wawuUserId)).toBe(1);
      const [row] = await reviewsOf(target.id);
      expect(row).toMatchObject({
        decision: 'removed',
        previousStatus: 'pending',
        slotReturned: true,
      });
    });

    it('a take-down that read a live piece before the creator removed it is told it is gone, and returns nothing', async () => {
      const { wawuUserId, pieces } = await creatorWith(['live', 'live']);
      const [target] = pieces;

      const result = await raceAgainst(
        target.id,
        (tx) => flip(tx, target.id, 'live', 'removed', wawuUserId, -1),
        () => service.takeDown(target.id, { reason: 'Taken down.' }, ADMIN),
      );

      expect(result.ok).toBe(false);
      expect((result as { error: unknown }).error).toBeInstanceOf(
        BadRequestException,
      );
      expect(await slots(wawuUserId)).toBe(1);
      expect(await held(wawuUserId)).toBe(1);
      expect(await reviewsOf(target.id)).toHaveLength(0);
    });

    it('a take-down that read a waiting piece before an admin approved it takes the live piece down and returns its place', async () => {
      const { wawuUserId, pieces } = await creatorWith(['pending', 'live']);
      const [target] = pieces;

      const result = await raceAgainst(
        target.id,
        (tx) => flip(tx, target.id, 'pending', 'live', wawuUserId, 0),
        () => service.takeDown(target.id, { reason: 'Taken down.' }, ADMIN),
      );

      expect(result.ok).toBe(true);
      expect(await statusOf(target.id)).toBe('removed');
      expect(await slots(wawuUserId)).toBe(1);
      expect(await held(wawuUserId)).toBe(1);
      const [row] = await reviewsOf(target.id);
      expect(row).toMatchObject({ previousStatus: 'live', slotReturned: true });
    });

    it('six take-downs of one piece sent together: one wins, five are told it is gone, one place comes back, one audit row', async () => {
      const { wawuUserId, pieces } = await creatorWith(['live', 'live']);
      const [target] = pieces;

      const results = await Promise.allSettled(
        Array.from({ length: 6 }, () =>
          service.takeDown(target.id, { reason: 'Taken down.' }, ADMIN),
        ),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const refused = results.filter((r) => r.status === 'rejected');
      expect(refused).toHaveLength(5);
      for (const r of refused)
        expect(r.reason).toBeInstanceOf(BadRequestException);
      expect(await slots(wawuUserId)).toBe(1);
      expect(await reviewsOf(target.id)).toHaveLength(1);
    });
  });

  describe('reject and approve', () => {
    it('a reject that read a waiting piece before another admin took it down is refused and returns no place', async () => {
      const { wawuUserId, pieces } = await creatorWith(['pending', 'pending']);
      const [target] = pieces;

      const result = await raceAgainst(
        target.id,
        (tx) => flip(tx, target.id, 'pending', 'removed', wawuUserId, -1),
        () => service.reject(target.id, { reason: 'Not suitable.' }, ADMIN),
      );

      expect(result.ok).toBe(false);
      expect((result as { error: unknown }).error).toBeInstanceOf(
        BadRequestException,
      );
      expect(await statusOf(target.id)).toBe('removed');
      // The take-down's one place, and nothing from the reject.
      expect(await slots(wawuUserId)).toBe(1);
      expect(await held(wawuUserId)).toBe(1);
      expect(await reviewsOf(target.id)).toHaveLength(0);
    });

    it('an approve that read a waiting piece before the creator removed it is refused and the piece stays removed', async () => {
      const { wawuUserId, pieces } = await creatorWith(['pending', 'pending']);
      const [target] = pieces;

      const result = await raceAgainst(
        target.id,
        (tx) => flip(tx, target.id, 'pending', 'removed', wawuUserId, -1),
        () => service.approve(target.id, ADMIN),
      );

      expect(result.ok).toBe(false);
      expect(await statusOf(target.id)).toBe('removed');
      expect(await slots(wawuUserId)).toBe(1);
      expect(await reviewsOf(target.id)).toHaveLength(0);
    });

    it('two rejects of one piece sent together return one place and write one audit row', async () => {
      const { wawuUserId, pieces } = await creatorWith(['pending', 'pending']);
      const [target] = pieces;

      const results = await Promise.allSettled([
        service.reject(target.id, { reason: 'One.' }, ADMIN),
        service.reject(target.id, { reason: 'Two.' }, ADMIN),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await slots(wawuUserId)).toBe(1);
      expect(await reviewsOf(target.id)).toHaveLength(1);
    });
  });

  describe('sent together', () => {
    it('a reject and a take-down of one waiting piece, twenty times over: the places always equal the pieces held', async () => {
      for (let round = 0; round < 20; round += 1) {
        const { wawuUserId, pieces } = await creatorWith([
          'pending',
          'pending',
          'pending',
        ]);
        const [target] = pieces;
        const calls = [
          () => service.reject(target.id, { reason: 'No.' }, ADMIN),
          () => service.takeDown(target.id, { reason: 'Down.' }, ADMIN),
        ];
        if (round % 2) calls.reverse();
        await Promise.allSettled(calls.map((c) => c()));

        expect(await slots(wawuUserId)).toBe(await held(wawuUserId));
        expect(await held(wawuUserId)).toBe(2);
        // The audit rows tell the same story as the counter: the places that
        // came back are the rows that say so.
        const rows = await reviewsOf(target.id);
        expect(rows.filter((r) => r.slotReturned)).toHaveLength(1);
      }
    });
  });
});
