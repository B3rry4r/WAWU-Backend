import { ContentPieceService } from '../content-piece.service';
import { TICK_UPLOADS } from '../../common/creator-allowance';
import { TierGateError } from '../../plans/tier-gate-error';
import {
  publishingOver,
  publishingTables,
  type PublishingWorld,
} from '../../plans/tests/publishing-fakes';
import type { CreateContentDto } from '../dto/create-content.dto';

/**
 * The publish cap has to hold in the service, not just in the publishing
 * wizard. Before this, create() never touched `slotsUsed` at all and a creator
 * could publish an unlimited number of pieces.
 *
 * TIER-02 (R-43) replaced the number. The cap is no longer 5, or 25 with a
 * tick (R-7): it is what the publishing gate allows. A running tier allows
 * the tier's products plus any extra products bought; a verification tick
 * that has not ended keeps its old 25 for the people who paid for one before
 * tiers; with neither, nothing may be published and the answer is
 * `tier_required`. A free piece is still allowed and still takes a place
 * (R-8). These tests are about that number and the transaction that claims
 * against it.
 *
 * These run against a hand-built Prisma double rather than a database: the
 * rule under test is arithmetic over counts, and the contract spec that needs
 * real Postgres (publishing-gate.contract.spec.ts) covers the wire shape.
 */

function buildService(opts: {
  used: number;
  hasState?: boolean;
  /** A creator tick that does not end, or one that has lapsed. */
  tick?: boolean | 'lapsed';
  tier?: PublishingWorld['tier'];
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

  // The three tables the publishing gate reads, counting as the double does.
  const tables = publishingTables(
    {
      tier: opts.tier,
      tick: opts.tick,
      slotsUsed: () => (hasState ? state.slotsUsed : undefined),
    },
    'creator-1',
  );
  const prisma = {
    ...tables,
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const { gate } = publishingOver(prisma);

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
    // BlockedAccountService (SETTINGS-04) — nothing on the upload path reads
    // a block.
    {} as never,
    gate,
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

/** A running tier of `products`, with `extra` bought on top. */
const tier = (products: number, extra = 0): PublishingWorld['tier'] => ({
  endsInDays: 20,
  productsIncluded: products,
  extraProducts: extra,
});

/** What a refusal carried: the code and the facts, never the offers. */
async function refusal(p: Promise<unknown>): Promise<TierGateError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(TierGateError);
  return e as TierGateError;
}

describe('ContentPieceService upload allowances (TIER-02)', () => {
  it('keeps the old tick cap of 25 for people who paid for a tick before tiers', () => {
    // If it moves, this says so before a creator finds out by being refused.
    expect(TICK_UPLOADS).toBe(25);
  });

  it('claims a place when the publish is within the tier', async () => {
    const { service, state } = buildService({ used: 1, tier: tier(3) });
    await service.create('creator-1', dto('paid'));
    expect(state.slotsUsed).toBe(2);
  });

  it('refuses the 4th product on a 3-product tier, whatever kind it is', async () => {
    for (const kind of ['free', 'paid'] as const) {
      const { service, state, tx } = buildService({
        used: 3,
        tier: tier(3),
      });
      const e = await refusal(service.create('creator-1', dto(kind)));
      expect(e.code).toBe('product_limit_reached');
      expect(e.getStatus()).toBe(402);
      expect(e.facts).toEqual({
        tierState: 'active',
        productsUsed: 3,
        productsAllowed: 3,
      });
      expect(state.slotsUsed).toBe(3);
      expect(tx.contentPiece.create).not.toHaveBeenCalled();
    }
  });

  it('adds the extra products bought to the tier: 3 and 5 extra allow 8, not 9', async () => {
    const { service, state } = buildService({ used: 3, tier: tier(3, 5) });
    for (let n = 4; n <= 8; n += 1)
      await service.create('creator-1', dto('paid'));
    expect(state.slotsUsed).toBe(8);
    const e = await refusal(service.create('creator-1', dto('paid')));
    expect(e.code).toBe('product_limit_reached');
    expect(e.facts.productsAllowed).toBe(8);
    expect(state.slotsUsed).toBe(8);
  });

  it('does not split the cap into free and paid sub-caps', async () => {
    // Four free pieces used to exhaust a "1 free" sub-cap while paid slots
    // sat unused. There is one pool, so a fifth upload of either kind is
    // still allowed on a 6-product tier.
    const { service, state } = buildService({ used: 4, tier: tier(6) });
    await service.create('creator-1', dto('free'));
    expect(state.slotsUsed).toBe(5);
  });

  it('lets a creator publish a PAID first upload', async () => {
    // The web wizard only sends paid listings, so a free-first rule here
    // meant no new creator could publish at all.
    const { service, state, tx } = buildService({ used: 0, tier: tier(3) });
    await service.create('creator-1', dto('paid'));
    expect(state.slotsUsed).toBe(1);
    const [arg] = (tx.contentPiece.create as jest.Mock).mock.calls[0] as [
      { data: { accessType: string; creatorFirstUploadFree: boolean } },
    ];
    expect(arg.data.accessType).toBe('paid');
    expect(arg.data.creatorFirstUploadFree).toBe(true);
  });

  it('does not claim a place when the write is rejected', async () => {
    const { service, tx } = buildService({ used: 3, tier: tier(3) });
    await expect(service.create('creator-1', dto('free'))).rejects.toThrow();
    expect(tx.contentPiece.create).not.toHaveBeenCalled();
  });

  it('lets a creator with no CreatorState row publish their first piece', async () => {
    // Uploading is not bought any more, and the row used to be written only
    // when a subscription was paid for. Requiring one here would be the
    // payment gate under another name.
    const { service, tx } = buildService({
      used: 0,
      hasState: false,
      tier: tier(3),
    });
    await service.create('creator-1', dto('free'));
    expect(tx.creatorState.upsert).toHaveBeenCalled();
    expect(tx.contentPiece.create).toHaveBeenCalled();
  });

  it('a creator with no tier and no tick cannot publish, and is told to pick a tier', async () => {
    const { service, state, tx } = buildService({ used: 0 });
    const e = await refusal(service.create('creator-1', dto('paid')));
    expect(e.code).toBe('tier_required');
    expect(e.getStatus()).toBe(402);
    expect(e.facts).toEqual({
      tierState: 'none',
      productsUsed: 0,
      productsAllowed: 0,
    });
    expect(state.slotsUsed).toBe(0);
    expect(tx.contentPiece.create).not.toHaveBeenCalled();
  });

  it('a creator whose tier has ended cannot publish: tier_required, state ended', async () => {
    const { service, state, tx } = buildService({
      used: 2,
      tier: { endsInDays: -3, productsIncluded: 3 },
    });
    const e = await refusal(service.create('creator-1', dto('paid')));
    expect(e.code).toBe('tier_required');
    expect(e.facts.tierState).toBe('ended');
    expect(state.slotsUsed).toBe(2);
    expect(tx.contentPiece.create).not.toHaveBeenCalled();
  });

  it('a creator with a tick that has not ended keeps the 25: every upload up to the 25th', async () => {
    const { service, state } = buildService({ used: 5, tick: true });
    for (let n = 6; n <= 25; n += 1) {
      await service.create('creator-1', dto(n % 2 ? 'free' : 'paid'));
    }
    expect(state.slotsUsed).toBe(25);
  });

  it('a creator with a tick cannot make a 26th upload', async () => {
    const { service, state, tx } = buildService({ used: 25, tick: true });
    const e = await refusal(service.create('creator-1', dto('free')));
    expect(e.code).toBe('product_limit_reached');
    expect(e.facts.productsAllowed).toBe(25);
    expect(state.slotsUsed).toBe(25);
    expect(tx.contentPiece.create).not.toHaveBeenCalled();
  });

  it('holding both a tier and a tick allows whichever is more, not the sum', async () => {
    const { service, state } = buildService({
      used: 3,
      tick: true,
      tier: tier(3, 5),
    });
    // 8 from the tier, 25 from the tick: the tick's 25 stands.
    await service.create('creator-1', dto('paid'));
    expect(state.slotsUsed).toBe(4);
    const full = buildService({ used: 25, tick: true, tier: tier(3, 5) });
    const e = await refusal(full.service.create('creator-1', dto('paid')));
    expect(e.facts.productsAllowed).toBe(25);
  });

  it('a creator whose tick has lapsed and who has no tier cannot publish', async () => {
    // A lapsed tick is not a tick: holdsTick decides, with the same instant
    // rule the badge uses.
    const { service } = buildService({ used: 5, tick: 'lapsed' });
    const e = await refusal(service.create('creator-1', dto('paid')));
    expect(e.code).toBe('tier_required');
  });

  it('a creator can publish a FREE piece as their first upload, and it takes a place', async () => {
    const { service, state, tx } = buildService({ used: 0, tier: tier(3) });
    const created = await service.create('creator-1', dto('free'));
    expect(created.accessType).toBe('free');
    expect(created.price).toBe(0);
    expect(state.slotsUsed).toBe(1);
    expect(tx.contentPiece.create).toHaveBeenCalledTimes(1);
  });

  it('free pieces after paid ones each count toward the cap', async () => {
    const { service, state } = buildService({ used: 0, tier: tier(5) });
    await service.create('creator-1', dto('paid'));
    await service.create('creator-1', dto('free'));
    await service.create('creator-1', dto('free'));
    await service.create('creator-1', dto('paid'));
    await service.create('creator-1', dto('free'));
    expect(state.slotsUsed).toBe(5);
    // The 6th is refused whichever kind it is: free pieces used up the cap.
    const e = await refusal(service.create('creator-1', dto('free')));
    expect(e.code).toBe('product_limit_reached');
  });

  it('a creator above the cap keeps every piece: the refusal changes nothing', async () => {
    // 12 pieces from a tier that has ended. The refusal must not touch the
    // count or write anything; the pieces themselves are never read for
    // deletion on this path at all.
    const { service, state, tx } = buildService({
      used: 12,
      tier: { endsInDays: -1, productsIncluded: 3 },
    });
    await refusal(service.create('creator-1', dto('paid')));
    expect(state.slotsUsed).toBe(12);
    expect(tx.contentPiece.create).not.toHaveBeenCalled();
    expect(Object.keys(tx.contentPiece)).toEqual(['count', 'create']);
  });

  it('a draft being published is removed in the same transaction, and comes back if the place is lost', async () => {
    const inTransaction = jest.fn(() => Promise.resolve());
    const ok = buildService({ used: 0, tier: tier(3) });
    await ok.service.create('creator-1', dto('paid'), inTransaction);
    expect(inTransaction).toHaveBeenCalledTimes(1);
    // The claim can lose a race the first check did not see: the transaction
    // throws, and the caller's own rollback undoes the draft's deletion.
    const lost = buildService({ used: 0, tier: tier(3) });
    lost.tx.creatorState.updateMany.mockResolvedValueOnce({ count: 0 });
    const hook = jest.fn(() => Promise.resolve());
    const e = await refusal(
      lost.service.create('creator-1', dto('paid'), hook),
    );
    expect(e.code).toBe('product_limit_reached');
    expect(hook).toHaveBeenCalledTimes(1);
    expect(lost.tx.contentPiece.create).not.toHaveBeenCalled();
  });
});
