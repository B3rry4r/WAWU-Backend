import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { AdminContentReviewService } from '../admin-content-review.service';
import { AdminRole, AdminUserStatus } from '../../../../generated/prisma/enums';
import type { AdminUserView } from '../../auth/admin-user-view.type';

/**
 * Coverage for the takedown lever added for content stranded `live` because
 * the creator behind it is gone: `deleteAccount()` (account.service.ts) only
 * removes a creator's content from the moment it runs forward, so an account
 * deleted before that fix shipped left its pieces exactly where they were,
 * with no pending review left to reject them from and no creator left to
 * self-delete them.
 *
 * Runs against a hand-built Prisma double, same style as
 * content-piece/tests/upload-allowance.spec.ts — the rule under test is the
 * status transition and the slot-return bookkeeping, and the DB-backed
 * contract spec (admin-content-review.contract.spec.ts) already covers the
 * wire shape for approve/reject through the same render path.
 */
type ContentRow = Record<string, unknown> & {
  id: string;
  status: string;
  creatorWawuId: string;
};

/**
 * `lostClaims`: how many of the take-down's writes lose a race. A lost write
 * does what a second request would have done a moment before it: it moves the
 * piece to the other of `pending` and `rejected` and changes no row, so the
 * next pass reads a status that is not the one it just tried to change.
 */
function buildService(seed: ContentRow, opts: { lostClaims?: number } = {}) {
  let lostClaims = opts.lostClaims ?? 0;
  const calls = { reads: 0, claims: 0 };
  const content = new Map<string, ContentRow>([[seed.id, { ...seed }]]);
  const reviews: Record<string, unknown>[] = [];
  const creatorStates = new Map<
    string,
    { wawuUserId: string; slotsUsed: number }
  >([[seed.creatorWawuId, { wawuUserId: seed.creatorWawuId, slotsUsed: 3 }]]);

  const tx = {
    contentPiece: {
      // The service reads the piece inside its transaction (TIER-02 round 3,
      // D5), so the transaction double answers the read too.
      findUnique: ({ where }: { where: { id: string } }) => {
        calls.reads += 1;
        const row = content.get(where.id);
        return Promise.resolve(row ? { ...row } : null);
      },
      updateMany: ({
        where,
        data,
      }: {
        where: { id: string; status?: string | { not?: string } };
        data: Record<string, unknown>;
      }) => {
        calls.claims += 1;
        const row = content.get(where.id);
        if (!row) return Promise.resolve({ count: 0 });
        if (lostClaims > 0) {
          lostClaims -= 1;
          row.status = row.status === 'pending' ? 'rejected' : 'pending';
          return Promise.resolve({ count: 0 });
        }
        if (typeof where.status === 'string' && row.status !== where.status) {
          return Promise.resolve({ count: 0 });
        }
        if (
          typeof where.status === 'object' &&
          where.status.not &&
          row.status === where.status.not
        ) {
          return Promise.resolve({ count: 0 });
        }
        Object.assign(row, data);
        return Promise.resolve({ count: 1 });
      },
      findUniqueOrThrow: ({ where }: { where: { id: string } }) => {
        const row = content.get(where.id);
        if (!row) throw new Error(`no such row ${where.id}`);
        return Promise.resolve({ ...row });
      },
    },
    creatorState: {
      updateMany: ({
        where,
        data,
      }: {
        where: { wawuUserId: string; slotsUsed: { gt: number } };
        data: { slotsUsed: { decrement: number } };
      }) => {
        const state = creatorStates.get(where.wawuUserId);
        if (!state || !(state.slotsUsed > where.slotsUsed.gt)) {
          return Promise.resolve({ count: 0 });
        }
        state.slotsUsed -= data.slotsUsed.decrement;
        return Promise.resolve({ count: 1 });
      },
    },
    adminContentReview: {
      create: ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: `review-${reviews.length + 1}`,
          reviewedAt: new Date(),
          ...data,
        };
        reviews.push(row);
        return Promise.resolve(row);
      },
    },
  };

  const prisma = {
    contentPiece: {
      findUnique: ({ where }: { where: { id: string } }) => {
        const row = content.get(where.id);
        return Promise.resolve(row ? { ...row } : null);
      },
    },
    courseLesson: { findMany: () => Promise.resolve([]) },
    purchase: { count: () => Promise.resolve(0) },
    adminContentReview: { findMany: () => Promise.resolve([]) },
    userProfile: { findMany: () => Promise.resolve([]) },
    creatorState: { findMany: () => Promise.resolve([]) },
    kycSubmission: { findMany: () => Promise.resolve([]) },
    $transaction: (fn: (t: typeof tx) => unknown) => Promise.resolve(fn(tx)),
  };

  const notifications = { emit: jest.fn() };
  const storage = {
    signedReadUrl: jest.fn(() =>
      Promise.resolve('https://signed.example/asset'),
    ),
  };

  // The creator context reads what the publishing gate allows (TIER-02); this
  // spec is about the take-down, so nobody is allowed anything.
  const publishing = { ofMany: () => Promise.resolve(new Map()) };

  const service = new AdminContentReviewService(
    prisma as never,
    notifications as never,
    storage as never,
    publishing as never,
  );
  return { service, content, creatorStates, reviews, calls };
}

const ADMIN: AdminUserView = {
  id: 'admin-1',
  email: 'mod@wawu.dev',
  name: 'Mod',
  role: AdminRole.reviewer,
  status: AdminUserStatus.active,
  lastLoginAt: null,
  createdAt: new Date(),
};

function row(overrides: Partial<ContentRow> = {}): ContentRow {
  return {
    id: 'content-1',
    slug: 'stale-video',
    creatorWawuId: 'creator-gone',
    contentType: 'video',
    title: 'Stale Video',
    description: 'desc',
    category: 'general',
    tags: [],
    accessType: 'free',
    price: 0,
    durationLabel: null,
    pageCount: null,
    previewAssetUrl: 'content/preview/creator-gone/a.png',
    fullAssetUrl: null,
    creatorFirstUploadFree: false,
    status: 'live',
    views: 0,
    ratingPct: null,
    commentCount: 0,
    likes: 0,
    createdAt: new Date(),
    ...overrides,
  };
}

describe('admin content takedown', () => {
  it('removes a live piece stranded by a deleted account, and returns the slot', async () => {
    const { service, content, creatorStates, reviews } = buildService(row());

    const result = await service.takeDown(
      'content-1',
      { reason: 'Creator account deleted before content-removal shipped.' },
      ADMIN,
    );

    expect(content.get('content-1')?.status).toBe('removed');
    expect(creatorStates.get('creator-gone')?.slotsUsed).toBe(2);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      decision: 'removed',
      previousStatus: 'live',
      newStatus: 'removed',
      slotReturned: true,
      reviewedByAdminId: ADMIN.id,
    });
    expect(result.content.status).toBe('removed');
  });

  it('does not return a slot for a piece that was already rejected', async () => {
    const { service, creatorStates } = buildService(
      row({ status: 'rejected' }),
    );

    await service.takeDown('content-1', { reason: 'Cleaning up.' }, ADMIN);

    expect(creatorStates.get('creator-gone')?.slotsUsed).toBe(3);
  });

  it('refuses to take down a piece that is already removed', async () => {
    const { service } = buildService(row({ status: 'removed' }));

    await expect(
      service.takeDown('content-1', { reason: 'Cleaning up.' }, ADMIN),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('404s on a piece that does not exist', async () => {
    const { service } = buildService(row());

    await expect(
      service.takeDown('does-not-exist', { reason: 'Cleaning up.' }, ADMIN),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

/**
 * The give-up path (TIER-02 round 4, T9). A take-down whose write changes no
 * row reads the piece again and acts on what is now true, up to three passes;
 * a fourth lost race in a row is not a race but a fight over one piece, and
 * staff are asked to look again with a 409 and nothing written. The verifier's
 * live runs reached this path only under a status storm, so these pin it
 * without luck: the double loses the write as many times as it is told to.
 */
describe('admin content takedown when the piece keeps changing', () => {
  const SENTENCE =
    'This piece changed while you were taking it down. Try again.';

  it('gives up after three lost passes with a 409, a plain sentence and nothing written', async () => {
    const { service, content, creatorStates, reviews, calls } = buildService(
      row({ status: 'pending' }),
      { lostClaims: 3 },
    );

    const err: unknown = await service
      .takeDown('content-1', { reason: 'Cleaning up.' }, ADMIN)
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(ConflictException);
    const conflict = err as ConflictException;
    expect(conflict.getStatus()).toBe(409);
    expect(conflict.message).toBe(SENTENCE);
    expect(conflict.message).not.toMatch(/[—–]/);
    // Exactly three passes: each read the piece once and tried to change it once.
    expect(calls).toEqual({ reads: 3, claims: 3 });
    // Nothing was written: no audit row, no place moved, the piece not removed.
    expect(reviews).toHaveLength(0);
    expect(creatorStates.get('creator-gone')?.slotsUsed).toBe(3);
    expect(content.get('content-1')?.status).not.toBe('removed');
  });

  it('still succeeds on the third pass: two lost races are not given up on', async () => {
    const { service, content, creatorStates, reviews, calls } = buildService(
      row({ status: 'pending' }),
      { lostClaims: 2 },
    );

    const result = await service.takeDown(
      'content-1',
      { reason: 'Cleaning up.' },
      ADMIN,
    );

    expect(calls).toEqual({ reads: 3, claims: 3 });
    expect(content.get('content-1')?.status).toBe('removed');
    expect(result.content.status).toBe('removed');
    // Two flips from pending leave it pending again; the audit row names the
    // status the winning pass really changed, and the place comes back once.
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      decision: 'removed',
      previousStatus: 'pending',
      newStatus: 'removed',
      slotReturned: true,
    });
    expect(creatorStates.get('creator-gone')?.slotsUsed).toBe(2);
  });

  it('a piece that ends up rejected on the winning pass returns no place', async () => {
    // One lost race flips pending to rejected; the next pass acts on that.
    const { service, creatorStates, reviews } = buildService(
      row({ status: 'pending' }),
      { lostClaims: 1 },
    );

    await service.takeDown('content-1', { reason: 'Cleaning up.' }, ADMIN);

    expect(reviews[0]).toMatchObject({
      previousStatus: 'rejected',
      slotReturned: false,
    });
    expect(creatorStates.get('creator-gone')?.slotsUsed).toBe(3);
  });
});
