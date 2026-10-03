import { ForbiddenException } from '@nestjs/common';
import { ContentPieceService } from '../content-piece.service';
import { FREE_UPLOADS, TICK_UPLOADS } from '../../common/creator-allowance';
import type { CreateContentDto } from '../dto/create-content.dto';

/**
 * The publish cap has to hold in the service, not just in the publishing
 * wizard. Before this, create() never touched `slotsUsed` at all and a creator
 * could publish an unlimited number of pieces.
 *
 * The cap used to be a per-tier ladder with a free/paid sub-split. It is now
 * one number per account that a tick raises (R-7: 5 uploads, 25 with a tick),
 * with no free/paid split (R-8: free pieces are allowed and count), so these
 * tests are about that number and the transaction that claims against it.
 *
 * These run against a hand-built Prisma double rather than a database: the
 * rule under test is arithmetic over counts, and the contract spec that needs
 * real Postgres already covers the wire shape.
 */
/** The four stored tick columns on UserProfile (verification-state.ts). */
type TickRow = Record<
  | 'creatorVerifiedAt'
  | 'creatorVerifiedUntil'
  | 'professionalVerifiedAt'
  | 'professionalVerifiedUntil',
  Date | null
>;
const NO_TICK: TickRow = {
  creatorVerifiedAt: null,
  creatorVerifiedUntil: null,
  professionalVerifiedAt: null,
  professionalVerifiedUntil: null,
};
const CREATOR_TICK: TickRow = {
  ...NO_TICK,
  creatorVerifiedAt: new Date('2026-01-01T00:00:00Z'),
  creatorVerifiedUntil: new Date('2099-01-01T00:00:00Z'),
};
const PROFESSIONAL_TICK: TickRow = {
  ...NO_TICK,
  professionalVerifiedAt: new Date('2026-01-01T00:00:00Z'),
  professionalVerifiedUntil: null,
};
const LAPSED_TICK: TickRow = {
  ...NO_TICK,
  creatorVerifiedAt: new Date('2024-01-01T00:00:00Z'),
  creatorVerifiedUntil: new Date('2025-01-01T00:00:00Z'),
};

function buildService(opts: {
  used: number;
  hasState?: boolean;
  /** The creator's UserProfile tick columns; null for no profile row. */
  ticks?: TickRow | null;
}) {
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
    userProfile: {
      findUnique: jest.fn(() =>
        Promise.resolve(opts.ticks === undefined ? NO_TICK : opts.ticks),
      ),
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
  it("caps an account at R-7's numbers: 5 without a tick, 25 with one", () => {
    // The numbers the ruling names. If one moves, this test is what says so
    // before a creator finds out by being refused an upload.
    expect(FREE_UPLOADS).toBe(5);
    expect(TICK_UPLOADS).toBe(25);
  });

  it('claims a slot when the upload is within allowance', async () => {
    const { service, state } = buildService({ used: 1 });
    await service.create('creator-1', dto('paid'));
    expect(state.slotsUsed).toBe(2);
  });

  it('refuses the sixth upload, whatever kind it is', async () => {
    for (const kind of ['free', 'paid'] as const) {
      const { service, state } = buildService({
        used: FREE_UPLOADS,
      });
      await expect(service.create('creator-1', dto(kind))).rejects.toThrow(
        ForbiddenException,
      );
      expect(state.slotsUsed).toBe(FREE_UPLOADS);
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

  it('lets a creator publish a PAID first upload', async () => {
    // The web wizard only sends paid listings, so a free-first rule here
    // meant no new creator could publish at all.
    const { service, state, tx } = buildService({ used: 0 });
    await service.create('creator-1', dto('paid'));
    expect(state.slotsUsed).toBe(1);
    const [arg] = (tx.contentPiece.create as jest.Mock).mock.calls[0] as [
      { data: { accessType: string; creatorFirstUploadFree: boolean } },
    ];
    expect(arg.data.accessType).toBe('paid');
    expect(arg.data.creatorFirstUploadFree).toBe(true);
  });

  it('does not claim a slot when the write is rejected', async () => {
    const { service, tx } = buildService({ used: FREE_UPLOADS });
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
  it('an unticked creator cannot make a 6th upload, and is told what a tick gives', async () => {
    const { service, state, tx } = buildService({ used: 5, ticks: NO_TICK });
    const refusal = await service
      .create('creator-1', dto('paid'))
      .catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ForbiddenException);
    expect((refusal as ForbiddenException).getResponse()).toEqual({
      message:
        'You have used all 5 of your upload slots. Remove an item to free one up.',
      reason: {
        code: 'upload_limit_reached',
        uploadsAllowed: 5,
        tickHeld: false,
        uploadsWithTick: 25,
      },
    });
    expect(state.slotsUsed).toBe(5);
    expect(tx.contentPiece.create).not.toHaveBeenCalled();
  });

  it('a creator with a tick can make a 6th upload and every one up to the 25th', async () => {
    const { service, state } = buildService({ used: 5, ticks: CREATOR_TICK });
    for (let n = 6; n <= 25; n += 1) {
      await service.create('creator-1', dto(n % 2 ? 'free' : 'paid'));
    }
    expect(state.slotsUsed).toBe(25);
  });

  it('a creator with a tick cannot make a 26th upload', async () => {
    const { service, state, tx } = buildService({
      used: 25,
      ticks: CREATOR_TICK,
    });
    const refusal = await service
      .create('creator-1', dto('free'))
      .catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ForbiddenException);
    expect(
      ((refusal as ForbiddenException).getResponse() as { reason: unknown })
        .reason,
    ).toEqual({
      code: 'upload_limit_reached',
      uploadsAllowed: 25,
      tickHeld: true,
      uploadsWithTick: 25,
    });
    expect(state.slotsUsed).toBe(25);
    expect(tx.contentPiece.create).not.toHaveBeenCalled();
  });

  it('a creator with the professional tick gets the same 25 as the creator tick', async () => {
    const { service, state } = buildService({
      used: 24,
      ticks: PROFESSIONAL_TICK,
    });
    await service.create('creator-1', dto('paid'));
    expect(state.slotsUsed).toBe(25);
  });

  it('a creator whose tick has lapsed is held to 5 again', async () => {
    const { service } = buildService({ used: 5, ticks: LAPSED_TICK });
    await expect(service.create('creator-1', dto('paid'))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('a creator with no profile row is held to 5', async () => {
    const { service } = buildService({ used: 5, ticks: null });
    await expect(service.create('creator-1', dto('paid'))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('a creator can publish a FREE piece as their first upload, and it takes a slot', async () => {
    const { service, state, tx } = buildService({ used: 0 });
    const created = await service.create('creator-1', dto('free'));
    expect(created.accessType).toBe('free');
    expect(created.price).toBe(0);
    expect(state.slotsUsed).toBe(1);
    expect(tx.contentPiece.create).toHaveBeenCalledTimes(1);
  });

  it('a creator can publish free pieces after paid ones, and each counts toward the cap', async () => {
    const { service, state } = buildService({ used: 0 });
    await service.create('creator-1', dto('paid'));
    await service.create('creator-1', dto('free'));
    await service.create('creator-1', dto('free'));
    await service.create('creator-1', dto('paid'));
    await service.create('creator-1', dto('free'));
    expect(state.slotsUsed).toBe(5);
    // The 6th is refused whichever kind it is: free pieces used up the cap.
    await expect(service.create('creator-1', dto('free'))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('a creator above the new cap keeps every piece: the refusal changes nothing', async () => {
    // 12 pieces from a lapsed tick, cap now 5. The refusal must not touch
    // the count or write anything; the pieces themselves are never read for
    // deletion on this path at all.
    const { service, state, tx } = buildService({
      used: 12,
      ticks: LAPSED_TICK,
    });
    await expect(service.create('creator-1', dto('paid'))).rejects.toThrow(
      ForbiddenException,
    );
    expect(state.slotsUsed).toBe(12);
    expect(tx.contentPiece.create).not.toHaveBeenCalled();
    expect(Object.keys(tx.contentPiece)).toEqual(['count', 'create']);
  });
});
