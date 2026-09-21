import { ForbiddenException } from '@nestjs/common';
import { CreatorStateService } from '../creator-state.service';
import { MAX_ITEMS_PER_ACCOUNT } from '../../common/creator-allowance';

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
  function build(opts: { accountType?: string | null; submissions?: number }) {
    const prisma = {
      creatorState: { findUnique: jest.fn().mockResolvedValue(null) },
      kycSubmission: {
        count: jest.fn().mockResolvedValue(opts.submissions ?? 0),
      },
      userProfile: {
        findUnique: jest
          .fn()
          .mockResolvedValue(
            opts.accountType === undefined
              ? null
              : { accountType: opts.accountType },
          ),
      },
    };
    return new CreatorStateService(prisma as never);
  }

  it('answers a creator who has not published anything yet', async () => {
    const state = await build({ accountType: 'creator' }).getState('u1');
    expect(state.slotsUsed).toBe(0);
    expect(state.slotsTotal).toBe(MAX_ITEMS_PER_ACCOUNT);
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
