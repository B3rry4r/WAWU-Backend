import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ContentPieceService } from '../content-piece.service';
import { MAX_ITEMS_PER_ACCOUNT } from '../../common/creator-allowance';
import type { CreateContentDto } from '../dto/create-content.dto';

/**
 * The publish cap has to hold in the service, not just in the publishing
 * wizard. Before this, create() never touched `slotsUsed` at all and a creator
 * could publish an unlimited number of pieces.
 *
 * The cap used to be a per-tier ladder with a free/paid sub-split. It is now
 * one flat number per account (build brief B2, "Maximum 5 items per account"),
 * counted across products, content AND services, so these tests are about that
 * one number and the transaction that claims against it.
 *
 * These run against a hand-built Prisma double rather than a database: the
 * rule under test is arithmetic over counts, and the contract spec that needs
 * real Postgres already covers the wire shape.
 */
function buildService(opts: { used: number; hasState?: boolean }) {
  const state = {
    wawuUserId: 'creator-1',
    slotsUsed: opts.used,
  };
  const hasState = opts.hasState ?? true;
  const created: Record<string, unknown>[] = [];
  const upserted: unknown[] = [];

  const tx = {
    contentPiece: {
      count: jest.fn(() => Promise.resolve(opts.used)),
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
      // The row is created on demand, so a creator's first upload does not
      // depend on one already existing.
      upsert: jest.fn((args: unknown) => {
        upserted.push(args);
        return Promise.resolve(state);
      }),
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
    creatorState: {
      findUnique: jest.fn(() => Promise.resolve(hasState ? state : null)),
    },
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };

  const service = new ContentPieceService(
    prisma as never,
    { verifyTransaction: jest.fn() } as never,
    // NotificationService — the upload path emits nothing; only the paid
    // unlock settlement does (see ContentPieceService.verifyUnlock).
    { emit: jest.fn() } as never,
    // StorageService — toResponse() re-signs asset URLs on the way out;
    // these tests assert on upload-slot arithmetic, not URL signing, so the
    // fake just hands back whatever it was given.
    {
      freshUrlFor: jest.fn((url: string | null) => Promise.resolve(url)),
    } as never,
  );
  return { service, state, tx, created, upserted };
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
  };
}

describe('ContentPieceService upload allowances', () => {
  it('caps an account at the flat per-account limit', () => {
    // The one number the brief names. If it moves, this test is what says so
    // before a creator finds out by being refused an upload.
    expect(MAX_ITEMS_PER_ACCOUNT).toBe(5);
  });

  it('claims a slot when the upload is within allowance', async () => {
    const { service, state } = buildService({ used: 1 });
    await service.create('creator-1', dto('paid'));
    expect(state.slotsUsed).toBe(2);
  });

  it('refuses the sixth upload, whatever kind it is', async () => {
    for (const kind of ['free', 'paid'] as const) {
      const { service, state } = buildService({
        used: MAX_ITEMS_PER_ACCOUNT,
      });
      await expect(service.create('creator-1', dto(kind))).rejects.toThrow(
        ForbiddenException,
      );
      expect(state.slotsUsed).toBe(MAX_ITEMS_PER_ACCOUNT);
    }
  });

  it('does not split the cap into free and paid sub-caps', async () => {
    // Four free pieces used to exhaust a "1 free" sub-cap while paid slots
    // sat unused. There is one pool now, so a fifth upload of either kind is
    // still allowed.
    const { service, state } = buildService({ used: 4 });
    await service.create('creator-1', dto('free'));
    expect(state.slotsUsed).toBe(5);
  });

  it('still requires the first upload to be free', async () => {
    const { service, state } = buildService({ used: 0 });
    await expect(service.create('creator-1', dto('paid'))).rejects.toThrow(
      BadRequestException,
    );
    expect(state.slotsUsed).toBe(0);
  });

  it('does not claim a slot when the write is rejected', async () => {
    const { service, tx } = buildService({ used: MAX_ITEMS_PER_ACCOUNT });
    await expect(service.create('creator-1', dto('free'))).rejects.toThrow();
    expect(tx.contentPiece.create).not.toHaveBeenCalled();
  });

  it('lets a creator with no CreatorState row publish their first piece', async () => {
    // Uploading is not bought any more, and the row used to be written only
    // when a subscription was paid for. Requiring one here would be the
    // payment gate under another name.
    const { service, tx } = buildService({ used: 0, hasState: false });
    await service.create('creator-1', dto('free'));
    expect(tx.creatorState.upsert).toHaveBeenCalled();
    expect(tx.contentPiece.create).toHaveBeenCalled();
  });
});
