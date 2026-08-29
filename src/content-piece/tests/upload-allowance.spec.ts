import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ContentPieceService } from '../content-piece.service';
import { UPLOAD_ALLOWANCE_BY_TIER } from '../../common/creator-tier-allowance';
import type { CreateContentDto } from '../dto/create-content.dto';

/**
 * Upload slots are a paid entitlement, so the cap has to hold in the service,
 * not just in the publishing wizard. Before this, create() checked only
 * `subscriptionPaid` and never touched `slotsUsed` — a Basic creator could
 * publish an unlimited number of pieces, all of them paid.
 *
 * These run against a hand-built Prisma double rather than a database: the
 * rule under test is arithmetic over counts, and the contract spec that needs
 * real Postgres already covers the wire shape.
 */
type Counts = { free: number; paid: number };

function buildService(tier: 'basic' | 'pro' | 'pro_max', counts: Counts) {
  const state = {
    wawuUserId: 'creator-1',
    tier,
    subscriptionPaid: true,
    slotsUsed: counts.free + counts.paid,
  };
  const created: Record<string, unknown>[] = [];

  const tx = {
    contentPiece: {
      count: jest.fn(({ where }: { where: { accessType?: string } }) =>
        Promise.resolve(where.accessType === 'free' ? counts.free : counts.paid),
      ),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return Promise.resolve({
          ...data,
          id: 'new-id',
          views: 0,
          likes: 0,
          commentCount: 0,
          ratingPct: null,
          durationLabel: null,
          pageCount: null,
          createdAt: new Date(0),
        });
      }),
    },
    creatorState: {
      updateMany: jest.fn(
        ({ where }: { where: { slotsUsed: { lt: number } } }) => {
          if (state.slotsUsed < where.slotsUsed.lt) {
            state.slotsUsed += 1;
            return Promise.resolve({ count: 1 });
          }
          return Promise.resolve({ count: 0 });
        },
      ),
    },
  };

  const prisma = {
    creatorState: { findUnique: jest.fn(() => Promise.resolve(state)) },
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };

  const service = new ContentPieceService(
    prisma as never,
    { verifyTransaction: jest.fn() } as never,
    // NotificationService — the upload path emits nothing; only the paid
    // unlock settlement does (see ContentPieceService.verifyUnlock).
    { emit: jest.fn() } as never,
  );
  return { service, state, tx, created };
}

function dto(accessType: 'free' | 'paid'): CreateContentDto {
  return {
    contentType: 'video',
    title: 'A piece',
    description: 'Description',
    category: 'business_entrepreneurship',
    tags: [],
    accessType,
    price: accessType === 'paid' ? 2000 : 0,
    previewAsset: 'https://cdn.example.com/preview.jpg',
    fullAsset: 'https://cdn.example.com/full.mp4',
  } as CreateContentDto;
}

describe('ContentPieceService upload allowances', () => {
  it('matches the tiers advertised on the pricing card', () => {
    expect(UPLOAD_ALLOWANCE_BY_TIER.basic).toEqual({ free: 1, paid: 5, total: 6 });
    expect(UPLOAD_ALLOWANCE_BY_TIER.pro).toEqual({ free: 2, paid: 13, total: 15 });
  });

  it('claims a slot when the upload is within allowance', async () => {
    const { service, state } = buildService('basic', { free: 1, paid: 0 });
    await service.create('creator-1', dto('paid'));
    expect(state.slotsUsed).toBe(2);
  });

  it('refuses a second free upload on Basic (1 free slot)', async () => {
    const { service, state } = buildService('basic', { free: 1, paid: 0 });
    await expect(service.create('creator-1', dto('free'))).rejects.toThrow(
      ForbiddenException,
    );
    expect(state.slotsUsed).toBe(1);
  });

  it('refuses a sixth paid upload on Basic (5 paid slots)', async () => {
    const { service, state } = buildService('basic', { free: 1, paid: 5 });
    await expect(service.create('creator-1', dto('paid'))).rejects.toThrow(
      ForbiddenException,
    );
    expect(state.slotsUsed).toBe(6);
  });

  it('allows Pro a second free upload where Basic is capped', async () => {
    const { service, state } = buildService('pro', { free: 1, paid: 0 });
    await service.create('creator-1', dto('free'));
    expect(state.slotsUsed).toBe(2);
  });

  it('refuses a fourteenth paid upload on Pro (13 paid slots)', async () => {
    const { service } = buildService('pro', { free: 2, paid: 13 });
    await expect(service.create('creator-1', dto('paid'))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('still requires the first upload to be free', async () => {
    const { service, state } = buildService('basic', { free: 0, paid: 0 });
    await expect(service.create('creator-1', dto('paid'))).rejects.toThrow(
      BadRequestException,
    );
    expect(state.slotsUsed).toBe(0);
  });

  it('does not claim a slot when the write is rejected', async () => {
    const { service, tx } = buildService('basic', { free: 1, paid: 5 });
    await expect(service.create('creator-1', dto('free'))).rejects.toThrow();
    expect(tx.contentPiece.create).not.toHaveBeenCalled();
  });

  it('refuses uploads without a paid subscription', async () => {
    const { service, state } = buildService('basic', { free: 0, paid: 0 });
    state.subscriptionPaid = false;
    await expect(service.create('creator-1', dto('free'))).rejects.toThrow(
      ForbiddenException,
    );
  });
});
