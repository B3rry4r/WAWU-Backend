import { ForbiddenException } from '@nestjs/common';
import { CreatorStateService } from '../creator-state.service';
import { TICK_UPLOADS } from '../../common/creator-allowance';
import {
  publishingOver,
  publishingTables,
  type PublishingWorld,
} from '../../plans/tests/publishing-fakes';

/**
 * WHO IS ALLOWED TO BE A CREATOR, when there is no CreatorState row yet.
 *
 * This gate decides whether a signed-in account sees the app as a creator or
 * as a reader. Getting it wrong does not throw anything a user can see: the
 * client clears their creator state and quietly renders plain user mode, with
 * no error on any screen. So the cases below are the whole point.
 *
 * `UserProfile.accountType` is now the only test. It used to have a second
 * arm: an existing CreatorSubscription counted as proof of a creator account
 * when the flag had been lost at signup. Subscriptions are gone and nothing
 * replaced that evidence, so the gate recognises FEWER accounts than before,
 * never more. The refusal cases below are what hold that line.
 */
describe('creator state gate, with no row yet', () => {
  // TIER-02: the cap a creator sees is what the publishing gate allows: a
  // running tier, or a tick that has not ended (R-43). The four stored tick
  // columns, as UserProfile holds them, for a creator with no tick and for
  // one whose creator tick runs to 2099.
  const NO_TICK: Record<
    | 'creatorVerifiedAt'
    | 'creatorVerifiedUntil'
    | 'professionalVerifiedAt'
    | 'professionalVerifiedUntil',
    Date | null
  > = {
    creatorVerifiedAt: null,
    creatorVerifiedUntil: null,
    professionalVerifiedAt: null,
    professionalVerifiedUntil: null,
  };
  const CREATOR_TICK = {
    ...NO_TICK,
    creatorVerifiedAt: new Date('2026-01-01T00:00:00Z'),
    creatorVerifiedUntil: new Date('2099-01-01T00:00:00Z'),
  };

  function build(opts: {
    accountType?: string | null;
    submissions?: number;
    ticks?: typeof NO_TICK;
    tier?: PublishingWorld['tier'];
  }) {
    // The three tables the allowance reads, for the same person.
    const tables = publishingTables(
      { tick: opts.ticks !== undefined, tier: opts.tier },
      'u1',
    );
    const prisma = {
      makerTier: tables.makerTier,
      creatorState: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: tables.creatorState.findMany,
      },
      kycSubmission: {
        count: jest.fn().mockResolvedValue(opts.submissions ?? 0),
      },
      userProfile: {
        findMany: tables.userProfile.findMany,
        findUnique: jest
          .fn()
          .mockResolvedValue(
            opts.accountType === undefined
              ? null
              : { accountType: opts.accountType, ...(opts.ticks ?? NO_TICK) },
          ),
      },
    };
    return new CreatorStateService(
      prisma as never,
      publishingOver(prisma).allowance,
      // PriceListService (PRICE-LIST round 3) — only the DM settings write asks it.
      {} as never,
    );
  }

  it('answers a creator who has not published anything yet', async () => {
    const state = await build({ accountType: 'creator' }).getState('u1');
    expect(state.slotsUsed).toBe(0);
    // No tier and no tick: nothing may be published until they have one.
    expect(state.slotsTotal).toBe(0);
  });

  it('shows a creator with a tick that has not ended the tick-era 25 slots', async () => {
    const state = await build({
      accountType: 'creator',
      ticks: CREATOR_TICK,
    }).getState('u1');
    expect(state.slotsTotal).toBe(TICK_UPLOADS);
    expect(TICK_UPLOADS).toBe(25);
  });

  it('shows a creator on a running tier the products of the tier plus the extras bought', async () => {
    const state = await build({
      accountType: 'creator',
      tier: { endsInDays: 20, productsIncluded: 3, extraProducts: 5 },
    }).getState('u1');
    expect(state.slotsTotal).toBe(8);
  });

  it('shows a creator whose tier has ended no slots', async () => {
    const state = await build({
      accountType: 'creator',
      tier: { endsInDays: -1, productsIncluded: 3, extraProducts: 5 },
    }).getState('u1');
    expect(state.slotsTotal).toBe(0);
  });

  it('reports the KYC gate as not_started before anything is submitted', async () => {
    // KYC is untouched by the subscription teardown and still gates EARNING.
    // `not_started` and `pending` are different states and the creator is
    // shown the difference.
    const state = await build({ accountType: 'creator' }).getState('u1');
    expect(state.kycStatus).toBe('not_started');
  });

  it('reports the KYC gate as pending once a submission exists', async () => {
    const state = await build({
      accountType: 'creator',
      submissions: 1,
    }).getState('u1');
    expect(state.kycStatus).toBe('pending');
  });

  it('still refuses a plain reader', async () => {
    // The gate must keep meaning something: a user with no creator account
    // type has no business on a creator surface.
    await expect(
      build({ accountType: 'user' }).getState('u1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('still refuses an account with no profile at all', async () => {
    await expect(
      build({ accountType: undefined }).getState('u1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
