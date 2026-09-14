import { BadRequestException, NotFoundException } from '@nestjs/common';
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

function buildService(seed: ContentRow) {
  const content = new Map<string, ContentRow>([[seed.id, { ...seed }]]);
  const reviews: Record<string, unknown>[] = [];
  const creatorStates = new Map<
    string,
    { wawuUserId: string; slotsUsed: number }
  >([[seed.creatorWawuId, { wawuUserId: seed.creatorWawuId, slotsUsed: 3 }]]);

  const tx = {
    contentPiece: {
      updateMany: ({
        where,
        data,
      }: {
        where: { id: string; status?: { not?: string } };
        data: Record<string, unknown>;
      }) => {
        const row = content.get(where.id);
        if (!row) return Promise.resolve({ count: 0 });
        if (where.status?.not && row.status === where.status.not) {
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

  const service = new AdminContentReviewService(
    prisma as never,
    notifications as never,
    storage as never,
  );
  return { service, content, creatorStates, reviews };
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
