import { Inject, Injectable, Logger } from '@nestjs/common';
import { WaitlistStatus } from '../../generated/prisma/enums';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { PrismaService } from '../common/prisma/prisma.service';
import { PLANS_CONFIG, type PlansConfig } from '../plans/plans-config';
import { PlansService } from '../plans/plans.service';
import { TierGrantService } from '../plans/tier-grant.service';
import {
  holdsRegisteredContact,
  readAccessCode,
  verifiedContactsOf,
} from './waitlist-claim-proof';
import { WaitlistError } from './waitlist-error';
import type { WaitlistClaimView } from './waitlist-view.type';

/** The words a refused claim gives. No em-dash, nothing the caller sent, nobody else's details. */
const WORDS = {
  invalid: 'Type the 8 letters and numbers of your access code.',
  notFound:
    'We could not match that code to you. Check the code, and sign in with the phone number or email you registered with.',
  notVerified:
    'Confirm your phone number or email first, then try your code again.',
  refunded:
    'That code is from an extra payment, which is being refunded, so it cannot be used. Use the code from your first payment.',
  claimed: 'That code has already been used.',
  claimedByYou: 'You have already claimed that code.',
  offerGone:
    'The offer for that code is no longer available. Email support@wawuafrica.com with your code.',
} as const;

/**
 * THE CLAIM (JOIN-03, R-48): a signed-in person turns what they paid for on
 * the registration page into the plan, with the access code that page showed.
 *
 * ── WHO MAY CLAIM ────────────────────────────────────────────────────────
 * The code alone is never enough. The caller must hold a phone or an email
 * their WAWU ID account has PROVEN (waitlist-claim-proof.ts) that is the one
 * the registration was made with. A code that does not exist, is not paid, or
 * belongs to a registration whose contacts the caller has not proven all
 * answer the same `code_not_found`, so the route cannot be used to learn which
 * codes exist, and no answer carries anyone's name, phone, email or reference.
 * Only after the match does the caller learn more about THEIR OWN
 * registration: that it is a refunded extra payment, or already claimed.
 *
 * ── WHAT IT GIVES ────────────────────────────────────────────────────────
 * What the offer's tier gives (what Verify gives, R-48), its days counted
 * from the claim, through TierGrantService: the one place a plan is granted.
 * A `failed` row (a second payment kept for a refund) is refused.
 *
 * ── ONCE ─────────────────────────────────────────────────────────────────
 * The first statement of the transaction marks the row claimed with a
 * conditional UPDATE (`status` paid and not yet claimed). Two taps at once, on
 * one server or two, queue on that row in Postgres: the second finds it
 * claimed (READ COMMITTED re-checks the condition), changes nothing, and is
 * refused. The grant is in the same transaction, so a grant that fails leaves
 * the code unclaimed, and a claim is never marked without its grant. The
 * grant's own references (`join:<registration id>`) are unique too.
 */
@Injectable()
export class WaitlistClaimService {
  private readonly logger = new Logger(WaitlistClaimService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PLANS_CONFIG) private readonly plans: PlansConfig,
    private readonly grants: TierGrantService,
    private readonly tiers: PlansService,
  ) {}

  /** POST /waitlist/claims. */
  async claim(
    user: WawuJwtClaims,
    rawCode: string,
    now: Date = new Date(),
  ): Promise<WaitlistClaimView> {
    const code = readAccessCode(rawCode);
    if (code === null) throw new WaitlistError('code_invalid', WORDS.invalid);

    const proven = verifiedContactsOf(user);
    if (proven.phone === null && proven.email === null)
      throw new WaitlistError('contact_not_verified', WORDS.notVerified);

    const row = await this.prisma.waitlistRegistration.findUnique({
      where: { accessCode: code },
    });
    // Unknown, still unpaid, or somebody else's: one answer for all three.
    if (
      row === null ||
      row.status === WaitlistStatus.pending ||
      !holdsRegisteredContact(proven, row)
    )
      throw new WaitlistError('code_not_found', WORDS.notFound);

    // From here the caller has proven the registration is theirs.
    if (row.status === WaitlistStatus.failed)
      throw new WaitlistError('code_refunded', WORDS.refunded);
    if (row.claimedByWawuId !== null) throw this.alreadyClaimed(user, row);

    const offer = this.plans.eventOffers.find((o) => o.id === row.offerId);
    if (offer === undefined)
      throw new WaitlistError('offer_unavailable', WORDS.offerGone);

    const granted = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.waitlistRegistration.updateMany({
        where: {
          id: row.id,
          status: WaitlistStatus.paid,
          claimedByWawuId: null,
        },
        data: { claimedByWawuId: user.sub, claimedAt: now },
      });
      if (claimed.count === 0) {
        // Lost the race to another tap: say who has it, exactly as above.
        const now2 = await tx.waitlistRegistration.findUniqueOrThrow({
          where: { id: row.id },
        });
        throw this.alreadyClaimed(user, now2);
      }
      return this.grants.grant(tx, {
        wawuUserId: user.sub,
        tierId: offer.tier,
        sourceRef: `join:${row.id}`,
        days: offer.tierDays,
        now,
      });
    });

    this.logger.log(`Registration ${row.id} claimed by an account.`);
    return {
      offerName: offer.name,
      days: granted.daysAdded,
      extended: granted.extended,
      pointsGranted: granted.pointsGranted,
      pointsExpireAt: granted.pointsExpireAt?.toISOString() ?? null,
      tier: await this.tiers.myTier(user.sub, now),
    };
  }

  private alreadyClaimed(
    user: WawuJwtClaims,
    row: { claimedByWawuId: string | null },
  ): WaitlistError {
    return row.claimedByWawuId === user.sub
      ? new WaitlistError('claimed_by_you', WORDS.claimedByYou)
      : new WaitlistError('already_claimed', WORDS.claimed);
  }
}
