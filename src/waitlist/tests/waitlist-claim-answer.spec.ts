import type { WawuJwtClaims } from '../../common/auth/wawu-jwt-claims.interface';
import type { PrismaService } from '../../common/prisma/prisma.service';
import type { PlansConfig } from '../../plans/plans-config';
import type { PlansService } from '../../plans/plans.service';
import type { TierGrantService } from '../../plans/tier-grant.service';
import { WaitlistClaimService } from '../waitlist-claim.service';

/**
 * JOIN-03 round 3 (D4): the answer to a repeated claim carries WHEN the code
 * was claimed, from the row's own stamp. The table's CHECK keeps
 * `claimedByWawuId` and `claimedAt` together, so a row with an answer and no
 * stamp cannot be written; the service still treats one as a claim from before
 * the answer was kept rather than invent a time.
 */
describe('the answer to a repeated claim (no database)', () => {
  const ME = 'u-me';
  const claims = {
    sub: ME,
    email: 'ada@example.test',
    phone: '+2348031234567',
    phoneVerified: true,
    emailVerified: true,
  } as unknown as WawuJwtClaims;
  const stored = {
    offerName: 'Verify',
    days: 30,
    extended: false,
    pointsGranted: 100,
    pointsExpireAt: '2027-01-08T10:00:00.000Z',
  };
  const tier = { state: 'active' };

  const service = (row: Record<string, unknown>) =>
    new WaitlistClaimService(
      {
        walletIdentity: { findUnique: () => Promise.resolve(null) },
        waitlistRegistration: {
          findUnique: () =>
            Promise.resolve({
              id: 'r1',
              status: 'paid',
              phone: '+2348031234567',
              email: 'ada@example.test',
              offerId: 'event-spec',
              ...row,
            }),
        },
      } as unknown as PrismaService,
      { eventOffers: [] } as unknown as PlansConfig,
      {} as unknown as TierGrantService,
      { myTier: () => Promise.resolve(tier) } as unknown as PlansService,
    );

  it("answers the claimer with the first claim's time and the tier as it is now", async () => {
    const at = new Date('2026-10-01T09:30:00.000Z');
    const view = await service({
      claimedByWawuId: ME,
      claimedAt: at,
      claimResult: stored,
    }).claim(claims, 'ABCD1234', new Date('2026-10-11T12:00:00.000Z'));
    expect(view).toEqual({
      ...stored,
      claimedAt: '2026-10-01T09:30:00.000Z',
      tier,
    });
  });

  it('is `claimed_by_you` for a row with an answer and no stamp, and never invents a time', async () => {
    await expect(
      service({
        claimedByWawuId: ME,
        claimedAt: null,
        claimResult: stored,
      }).claim(claims, 'ABCD1234'),
    ).rejects.toMatchObject({ code: 'claimed_by_you' });
  });

  it('is `already_claimed` for anybody else, with no time in it', async () => {
    await expect(
      service({
        claimedByWawuId: 'someone-else',
        claimedAt: new Date(),
        claimResult: stored,
      }).claim(claims, 'ABCD1234'),
    ).rejects.toMatchObject({ code: 'already_claimed' });
  });
});
