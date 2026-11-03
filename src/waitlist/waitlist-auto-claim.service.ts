import { Injectable, Logger } from '@nestjs/common';
import { WaitlistStatus } from '../../generated/prisma/enums';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { PrismaService } from '../common/prisma/prisma.service';
import { WaitlistClaimCore } from './waitlist-claim-core';
import {
  holdsRegisteredContact,
  verifiedContactsOf,
} from './waitlist-claim-proof';
import { normaliseEmail, normalisePhone } from './waitlist-contact';

/**
 * THE AUTOMATIC CLAIM (JOIN-TIERS-HUB, R-125; owner, 3 Nov 2026: "No code
 * needed. Someone signs into the app or website with the same email or phone
 * ... the server finds their payment and gives them the tier automatically").
 *
 * When a signed-in person reads their tier (`GET /me/tier`, and the tier offer
 * the app reads on every start), every PAID, UNCLAIMED registration whose email
 * or phone is one THEIR ACCOUNT HAS PROVEN is claimed for them, through the same
 * transaction the access code uses (WaitlistClaimCore). "Proven" is exactly the
 * manual claim's proof (waitlist-claim-proof.ts): the token's `emailVerified` or
 * `phoneVerified`, or the Hub's BVN-checked wallet phone. A typed, unproven
 * contact never matches, and nobody's registration is claimed by a stranger.
 *
 * The registrations are claimed in the order they were paid, so a person with
 * two is given them as if they had bought them in that order: a bigger tier
 * moves them up, a smaller or equal one adds its days (the store's rule).
 *
 * Once, and safe to repeat or race: the claim is a conditional UPDATE on the
 * row, so two reads at once claim it once, and a claimed row is never a
 * candidate again. The route that reads is never failed by this: an error here
 * is logged and the read goes on. The old phones that call the same reads (no
 * app update) get the tier, because the grant is made before the read answers.
 */
@Injectable()
export class WaitlistAutoClaimService {
  private readonly logger = new Logger(WaitlistAutoClaimService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly core: WaitlistClaimCore,
  ) {}

  /** Claims what the caller's proven contacts hold; returns how many registrations were claimed. */
  async run(user: WawuJwtClaims, now: Date = new Date()): Promise<number> {
    try {
      return await this.claimAll(user, now);
    } catch (e) {
      this.logger.warn(
        `Automatic claim failed for an account: ${e instanceof Error ? e.name : 'error'}`,
      );
      return 0;
    }
  }

  private async claimAll(user: WawuJwtClaims, now: Date): Promise<number> {
    const phone =
      typeof user.phone === 'string' ? normalisePhone(user.phone) : null;
    const email =
      typeof user.email === 'string' ? normaliseEmail(user.email) : null;
    const contacts = [
      ...(phone === null ? [] : [{ phone }]),
      ...(email === null ? [] : [{ email }]),
    ];
    if (contacts.length === 0) return 0;

    // The cheap question first, on the indexed phone and email: is there a
    // paid registration nobody has claimed that carries one of the caller's
    // contacts? Almost every read ends here.
    const candidates = await this.prisma.waitlistRegistration.findMany({
      where: {
        status: WaitlistStatus.paid,
        claimedByWawuId: null,
        OR: contacts,
      },
      orderBy: [{ paidAt: 'asc' }, { id: 'asc' }],
    });
    if (candidates.length === 0) return 0;

    const identity = await this.prisma.walletIdentity.findUnique({
      where: { wawuUserId: user.sub },
      select: { verifiedPhone: true, bvnVerifiedAt: true },
    });
    const proven = verifiedContactsOf(user, identity);
    let claimed = 0;
    for (const row of candidates) {
      if (!holdsRegisteredContact(proven, row)) continue;
      const goods = this.core.goodsOf(row);
      if (goods === null) continue;
      const outcome = await this.core.claimRow(
        user.sub,
        row,
        goods,
        'auto',
        now,
      );
      if (outcome.kind === 'claimed') {
        claimed += 1;
        this.logger.log(`Registration ${row.id} claimed automatically.`);
      }
    }
    return claimed;
  }
}
