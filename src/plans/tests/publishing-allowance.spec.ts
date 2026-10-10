import {
  TICK_STORAGE_BYTES,
  TICK_UPLOADS,
} from '../../common/creator-allowance';
import { FREE_STORAGE_BYTES } from '../../common/creator-allowance';
import { TierGateError } from '../tier-gate-error';
import {
  publishingOver,
  publishingTables,
  type PublishingWorld,
} from './publishing-fakes';

/**
 * TIER-02: what a person may publish, and the gate built on it. These are the
 * rules, over hand-made worlds, with the real services. The HTTP spec
 * (publishing-gate.contract.spec.ts) proves the same on a real database.
 */

const gateOf = (world: PublishingWorld) => {
  const prisma = publishingTables(world, 'p1');
  return publishingOver(prisma);
};

describe('PublishingAllowanceService (TIER-02)', () => {
  it('a person with no tier and no tick may publish nothing', async () => {
    const { allowance } = gateOf({});
    await expect(allowance.of('p1')).resolves.toMatchObject({
      basis: 'none',
      productsAllowed: 0,
      productsUsed: 0,
      tierState: 'none',
      runningTierId: null,
      tickHeld: false,
      storageBytes: FREE_STORAGE_BYTES,
    });
  });

  it('a running tier allows its own products plus the extras bought', async () => {
    const { allowance } = gateOf({
      tier: {
        tierId: 'verify',
        endsInDays: 20,
        productsIncluded: 3,
        extraProducts: 5,
      },
      slotsUsed: 2,
    });
    await expect(allowance.of('p1')).resolves.toMatchObject({
      basis: 'tier',
      productsAllowed: 8,
      productsUsed: 2,
      tierState: 'active',
      runningTierId: 'verify',
      runningTierProducts: 3,
      storageBytes: TICK_STORAGE_BYTES,
    });
  });

  it('a tier in its last days still allows publishing, and counts as ending', async () => {
    const { allowance } = gateOf({
      tier: { endsInDays: 2, productsIncluded: 3 },
    });
    await expect(allowance.of('p1')).resolves.toMatchObject({
      basis: 'tier',
      tierState: 'ending',
      productsAllowed: 3,
    });
  });

  it('an ended tier allows nothing, and the people who held it keep what they published', async () => {
    const { allowance } = gateOf({
      tier: { endsInDays: -1, productsIncluded: 3, extraProducts: 5 },
      slotsUsed: 7,
    });
    await expect(allowance.of('p1')).resolves.toMatchObject({
      basis: 'none',
      tierState: 'ended',
      productsAllowed: 0,
      // Still counted: nothing is unpublished, and renewing puts them back.
      productsUsed: 7,
      runningTierId: null,
    });
  });

  it('a verification tick that has not ended keeps the old 25', async () => {
    const { allowance } = gateOf({ tick: true, slotsUsed: 4 });
    await expect(allowance.of('p1')).resolves.toMatchObject({
      basis: 'tick',
      productsAllowed: TICK_UPLOADS,
      tickHeld: true,
      storageBytes: TICK_STORAGE_BYTES,
    });
  });

  it('a tick that has lapsed is not a tick', async () => {
    const { allowance } = gateOf({ tick: 'lapsed' });
    await expect(allowance.of('p1')).resolves.toMatchObject({
      basis: 'none',
      productsAllowed: 0,
      tickHeld: false,
    });
  });

  it('holding both allows the larger, not the sum, and names the one that gives it', async () => {
    const small = gateOf({
      tick: true,
      tier: { endsInDays: 10, productsIncluded: 3, extraProducts: 5 },
    });
    await expect(small.allowance.of('p1')).resolves.toMatchObject({
      basis: 'tick',
      productsAllowed: TICK_UPLOADS,
    });
    // A tier bigger than the tick (extras bought in bulk) is the basis.
    const big = gateOf({
      tick: true,
      tier: { endsInDays: 10, productsIncluded: 10, extraProducts: 20 },
    });
    await expect(big.allowance.of('p1')).resolves.toMatchObject({
      basis: 'tier',
      productsAllowed: 30,
    });
  });

  it('reads a tier the config no longer names by what was bought', async () => {
    const { allowance } = gateOf({
      tier: { tierId: 'retired-tier', endsInDays: 10, productsIncluded: 4 },
    });
    await expect(allowance.of('p1')).resolves.toMatchObject({
      basis: 'tier',
      productsAllowed: 4,
      runningTierId: 'retired-tier',
    });
  });

  it('answers many people in one pass, each from their own rows', async () => {
    const { allowance } = gateOf({
      tier: { endsInDays: 20, productsIncluded: 6 },
      slotsUsed: 1,
    });
    const all = await allowance.ofMany(['p1', 'someone-else', 'p1']);
    expect([...all.keys()].sort()).toEqual(['p1', 'someone-else']);
    expect(all.get('p1')?.productsAllowed).toBe(6);
    // The double only holds p1's rows: someone else has nothing.
    expect(all.get('someone-else')).toMatchObject({
      basis: 'none',
      productsAllowed: 0,
      productsUsed: 0,
    });
  });
});

describe('PublishingGate (TIER-02)', () => {
  const refusal = async (p: Promise<unknown>) => {
    const e = await p.then(
      () => null,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(TierGateError);
    return e as TierGateError;
  };

  it('asks for a tier before it asks for room', async () => {
    const { gate } = gateOf({ slotsUsed: 0 });
    const e = await refusal(gate.assertRoomForProduct('p1'));
    expect(e.code).toBe('tier_required');
    expect(e.getStatus()).toBe(402);
    const body = e.getResponse() as { reason: Record<string, unknown> };
    expect(body.reason).toMatchObject({
      code: 'tier_required',
      tierState: 'none',
      productsUsed: 0,
      productsAllowed: 0,
    });
  });

  it('a file or an edit with a file needs a way to publish, not a free place', async () => {
    const full = gateOf({
      tier: { endsInDays: 10, productsIncluded: 3 },
      slotsUsed: 3,
    });
    // At the limit, an edit to a piece that already has its place is fine.
    await expect(full.gate.assertMayUpload('p1')).resolves.toMatchObject({
      basis: 'tier',
    });
    // But a NEW product is not.
    const e = await refusal(full.gate.assertRoomForProduct('p1'));
    expect(e.code).toBe('product_limit_reached');
    const none = gateOf({});
    expect((await refusal(none.gate.assertMayUpload('p1'))).code).toBe(
      'tier_required',
    );
  });

  it('says tier_required with an ended tier, in words that say the products stay up', async () => {
    const { gate } = gateOf({
      tier: { endsInDays: -2, productsIncluded: 3 },
      slotsUsed: 3,
    });
    const e = await refusal(gate.assertRoomForProduct('p1'));
    expect(e.code).toBe('tier_required');
    expect(e.facts.tierState).toBe('ended');
    const message = (e.getResponse() as { message: string }).message;
    expect(message).toMatch(/ended/i);
    expect(message).toMatch(/stays up/i);
  });

  it('never writes an em-dash into a sentence a person reads', async () => {
    const worlds: PublishingWorld[] = [
      {},
      { tier: { endsInDays: -2, productsIncluded: 3 } },
      { tier: { endsInDays: 5, productsIncluded: 3 }, slotsUsed: 3 },
    ];
    for (const w of worlds) {
      const { gate } = gateOf(w);
      const e = await refusal(gate.assertRoomForProduct('p1'));
      const body = e.getResponse() as {
        message: string;
        reason: { message: string };
      };
      expect(body.message).not.toContain('—');
      expect(body.reason.message).toBe(body.message);
    }
  });

  it('re-reads after a lost claim, so the answer carries the numbers that refused it', async () => {
    let used = 2;
    const { gate } = gateOf({
      tier: { endsInDays: 10, productsIncluded: 3 },
      slotsUsed: () => used,
    });
    await expect(gate.assertRoomForProduct('p1')).resolves.toBeDefined();
    used = 3; // another publish got the last place first
    const e = await gate.limitReachedFor('p1');
    expect(e.code).toBe('product_limit_reached');
    expect(e.facts).toEqual({
      tierState: 'active',
      productsUsed: 3,
      productsAllowed: 3,
    });
  });

  it('carries the offers only once the route adds them, flat in reason', () => {
    const bare = new TierGateError('tier_required', 'x', {
      tierState: 'none',
      productsUsed: 0,
      productsAllowed: 0,
    });
    expect(
      (bare.getResponse() as { reason: object }).reason,
    ).not.toHaveProperty('tiers');
    const full = bare.withOffers({
      currency: 'NGN',
      tiers: [],
      extraProducts: null,
    });
    expect((full.getResponse() as { reason: object }).reason).toMatchObject({
      code: 'tier_required',
      currency: 'NGN',
      tiers: [],
      extraProducts: null,
    });
  });
});
