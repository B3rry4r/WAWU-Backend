import { ForbiddenException } from '@nestjs/common';
import { CreatorStateService } from '../creator-state.service';

/**
 * WHO IS ALLOWED TO BE A CREATOR, when there is no CreatorState row yet.
 *
 * This gate decides whether a signed-in account sees the app as a creator or
 * as a reader. Getting it wrong does not throw anything a user can see: the
 * client clears their creator state and quietly renders plain user mode, with
 * no error on any screen. So the cases below are the whole point.
 */
describe('creator state gate, with no row yet', () => {
  function build(opts: {
    accountType?: string | null;
    subscriptions?: number;
    tier?: string;
    status?: string;
  }) {
    const prisma = {
      creatorState: { findUnique: jest.fn().mockResolvedValue(null) },
      kycSubmission: { count: jest.fn().mockResolvedValue(0) },
      userProfile: {
        findUnique: jest.fn().mockResolvedValue(
          opts.accountType === undefined ? null : { accountType: opts.accountType },
        ),
      },
      creatorSubscription: {
        findUnique: jest.fn().mockResolvedValue(
          opts.subscriptions
            ? { tier: opts.tier ?? 'basic', status: opts.status ?? 'active' }
            : null,
        ),
      },
    };
    return new CreatorStateService(prisma as never);
  }

  it('answers a creator who has not subscribed yet', async () => {
    const state = await build({ accountType: 'creator' }).getState('u1');
    expect(state.subscriptionPaid).toBe(false);
    expect(state.tier).toBe('basic');
  });

  it('answers somebody who PAID, even if the profile flag says user', async () => {
    // The reported bug: one lost write at signup leaves accountType saying
    // "user" for a real creator, and they are shown the app as a reader.
    // A subscription is proof; nobody buys a creator plan by accident.
    const state = await build({ accountType: 'user', subscriptions: 1 }).getState('u1');
    expect(state.tier).toBe('basic');
  });

  it('does not ask somebody who has already paid to pay again', async () => {
    // An active subscription with no CreatorState row is a creator whose
    // entitlement row was lost. Reporting them unpaid sends someone who has
    // been charged back to the paywall to buy the plan they already hold.
    const state = await build({
      accountType: 'creator',
      subscriptions: 1,
      tier: 'pro',
      status: 'active',
    }).getState('u1');
    expect(state.subscriptionPaid).toBe(true);
    expect(state.tier).toBe('pro');
  });

  it('treats a cancelled subscription as unpaid, but still a creator', async () => {
    const state = await build({
      accountType: 'user',
      subscriptions: 1,
      status: 'cancelled',
    }).getState('u1');
    expect(state.subscriptionPaid).toBe(false);
    expect(state.tier).toBe('basic');
  });

  it('answers somebody who paid whose profile row is missing entirely', async () => {
    const state = await build({ accountType: undefined, subscriptions: 1 }).getState('u1');
    expect(state.tier).toBe('basic');
  });

  it('still refuses a plain reader', async () => {
    // The gate must keep meaning something: a user with no claim and no
    // payment has no business on a creator surface.
    await expect(build({ accountType: 'user' }).getState('u1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('still refuses an account with no profile and no payment', async () => {
    await expect(build({ accountType: undefined }).getState('u1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
