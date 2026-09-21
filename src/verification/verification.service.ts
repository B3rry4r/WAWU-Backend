import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { WawuIdClient } from '../common/auth/wawu-id.client';
import {
  FLUTTERWAVE_CLIENT,
  type FlutterwaveClient,
} from '../content-piece/flutterwave-client.interface';
import {
  deriveVerificationState,
  oneYearFrom,
  unverified,
  VERIFICATION_KINDS,
  type VerificationColumns,
  type VerificationKindValue,
  type VerificationState,
} from '../common/verification/verification-state';
import { VerificationPricingService } from '../common/verification/verification-pricing';
import type {
  MyVerificationView,
  TickPurchaseEligibility,
  VerificationCheckoutView,
  VerificationGrantView,
} from './verification-view.type';
import type {
  StartVerificationPurchaseDto,
  VerifyVerificationPurchaseDto,
} from './dto/verification-purchase.dto';

/**
 * THE TWO TICKS: buying one, holding one, losing one.
 *
 * Two independent, annual, paid verifications. Creator is purple at
 * NGN 4,999 a year, professional is green at NGN 9,999 a year, and neither
 * outranks the other: somebody who is both a creator and a practising
 * professional holds both, and both render. There is no ladder here and
 * nothing in this file compares the two kinds for rank.
 *
 * ── WHO MAY BUY WHICH ────────────────────────────────────────────────────
 * The creator tick needs a creator account. The professional tick needs an
 * approved ProfessionalProfile. A buyer account holds neither and can buy
 * neither, which is what makes "a buyer can never host an event" true at the
 * root rather than at the event endpoint alone.
 *
 * ── THE MONEY PATH ───────────────────────────────────────────────────────
 * Exactly the shape content unlock uses, because a second payment idiom is a
 * second set of replay bugs: init a charge, write a pending row keyed by its
 * tx_ref, and grant nothing until a server-side verify has confirmed the
 * amount and the reference with Flutterwave. The FlutterwaveClient is
 * content-piece's, imported rather than copied - there are already five
 * hand-copied versions of that interface in this repo and the forks gate is
 * right about them.
 *
 * ── WHO IS THE SOURCE OF TRUTH ───────────────────────────────────────────
 * WAWU ID. Every grant and every revoke writes there FIRST, through
 * WawuIdClient.setVerification, and only then mirrors onto this backend's own
 * UserProfile columns. If the identity call fails, nothing has been granted
 * here and the payment is simply re-verifiable. The reverse order would leave
 * a tick that identity has never heard of.
 */
@Injectable()
export class VerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wawuId: WawuIdClient,
    private readonly pricing: VerificationPricingService,
    @Inject(FLUTTERWAVE_CLIENT)
    private readonly flutterwave: FlutterwaveClient,
  ) {}

  private async loadColumns(
    wawuUserId: string,
  ): Promise<VerificationColumns | null> {
    return this.prisma.userProfile.findUnique({
      where: { wawuUserId },
      select: {
        creatorVerifiedAt: true,
        creatorVerifiedUntil: true,
        professionalVerifiedAt: true,
        professionalVerifiedUntil: true,
      },
    });
  }

  /** The caller's own ticks. One read, derived in the one place it is derived. */
  async stateFor(wawuUserId: string): Promise<VerificationState> {
    return deriveVerificationState(await this.loadColumns(wawuUserId));
  }

  /**
   * Whether this account may buy each tick, with the reason when it may not.
   *
   * Computed for BOTH kinds every time rather than only the one being bought,
   * because this is also what the pricing screen renders, and a screen that
   * only learns about a refusal by attempting the purchase is how people end
   * up at a payment sheet they were never allowed to complete.
   */
  private async eligibility(
    wawuUserId: string,
  ): Promise<TickPurchaseEligibility[]> {
    const [profile, professional, prices, columns] = await Promise.all([
      this.prisma.userProfile.findUnique({
        where: { wawuUserId },
        select: { accountType: true },
      }),
      this.prisma.professionalProfile.findFirst({
        where: { wawuUserId, status: 'approved' },
        select: { id: true },
      }),
      this.pricing.prices(),
      this.loadColumns(wawuUserId),
    ]);
    const state = deriveVerificationState(columns);

    return VERIFICATION_KINDS.map((kind) => {
      const priceNgn =
        kind === 'creator' ? prices.creator : prices.professional;

      if (state[kind].verified && state[kind].expiresAt === null) {
        return {
          kind,
          allowed: false,
          priceNgn,
          // A perpetual tick was granted by hand and has nothing to renew.
          reason:
            kind === 'creator'
              ? 'You already hold the creator tick, and it does not expire.'
              : 'You already hold the professional tick, and it does not expire.',
        };
      }
      if (kind === 'creator' && profile?.accountType !== 'creator') {
        return {
          kind,
          allowed: false,
          priceNgn,
          reason:
            'The creator tick is for creator accounts. Switch your account to a creator account in Settings first.',
        };
      }
      if (kind === 'professional' && !professional) {
        return {
          kind,
          allowed: false,
          priceNgn,
          reason:
            'The professional tick needs an approved professional profile. Submit your credentials first, then come back.',
        };
      }
      return { kind, allowed: true, priceNgn, reason: null };
    });
  }

  /** GET /verification/me. */
  async me(wawuUserId: string): Promise<MyVerificationView> {
    const [verification, pricing, eligibility] = await Promise.all([
      this.stateFor(wawuUserId),
      this.pricing.prices(),
      this.eligibility(wawuUserId),
    ]);
    return { verification, pricing, eligibility };
  }

  /** GET /verification/pricing. */
  async prices() {
    return this.pricing.prices();
  }

  /**
   * POST /verification/purchase.
   *
   * Writes the pending row before returning the checkout config, so that a
   * verify arriving from a browser that then closed still has something to
   * settle against. The price is snapshotted onto that row: verification
   * enforces `paid >= priceNgn`, and reading the configured price again at
   * verify time would let a price change between the two calls decide whether
   * somebody's completed payment counted.
   */
  async startPurchase(
    wawuUserId: string,
    dto: StartVerificationPurchaseDto,
  ): Promise<VerificationCheckoutView> {
    const kind = dto.kind;
    const eligibility = await this.eligibility(wawuUserId);
    const mine = eligibility.find((e) => e.kind === kind);
    if (!mine) {
      throw new BadRequestException('That is not a verification we sell.');
    }
    if (!mine.allowed) {
      throw new ForbiddenException(mine.reason ?? 'You cannot buy that one.');
    }

    const existingPending = await this.prisma.verificationPurchase.findFirst({
      where: { wawuUserId, kind, status: 'pending' },
      select: { id: true },
    });
    if (existingPending) {
      // Not an error worth blocking on: an abandoned checkout leaves one of
      // these behind, and refusing the next attempt would strand the person
      // until the row aged out. The old row is failed off instead, so only
      // one attempt per kind is ever settleable.
      await this.prisma.verificationPurchase.updateMany({
        where: { wawuUserId, kind, status: 'pending' },
        data: { status: 'failed' },
      });
    }

    const charge = this.flutterwave.initCharge({
      amount: mine.priceNgn,
      purpose: `verification-${kind}`,
      wawuUserId,
    });

    await this.prisma.verificationPurchase.create({
      data: {
        wawuUserId,
        kind,
        priceNgn: mine.priceNgn,
        flutterwaveTxRef: charge.txRef,
        status: 'pending',
      },
    });

    return {
      flutterwaveConfig: {
        txRef: charge.txRef,
        amount: charge.amount,
        currency: charge.currency,
        publicKey: charge.publicKey,
      },
      kind,
      priceNgn: mine.priceNgn,
    };
  }

  /**
   * POST /verification/purchase/verify - the grant.
   *
   * A renewal extends from whichever is later, now or the current expiry, so
   * renewing a month early does not throw away the month already paid for.
   */
  async verifyPurchase(
    wawuUserId: string,
    dto: VerifyVerificationPurchaseDto,
  ): Promise<VerificationGrantView> {
    const purchase = await this.prisma.verificationPurchase.findFirst({
      where: { flutterwaveTxRef: dto.tx_ref, wawuUserId },
    });
    if (!purchase) {
      throw new NotFoundException(
        'No matching verification payment found for this reference.',
      );
    }
    if (purchase.status === 'completed') {
      // Idempotent: a second verify on a settled payment returns the tick it
      // already bought rather than charging or granting anything again.
      return {
        kind: purchase.kind,
        verification: await this.stateFor(wawuUserId),
      };
    }
    if (purchase.status === 'failed') {
      throw new BadRequestException(
        'That payment attempt already failed verification. Start a new one.',
      );
    }

    const result = await this.flutterwave.verifyCharge({
      transactionId: dto.transaction_id,
      txRef: dto.tx_ref,
    });

    const verified =
      result.status === 'successful' &&
      result.currency === 'NGN' &&
      result.txRef === purchase.flutterwaveTxRef &&
      result.amount >= purchase.priceNgn;

    if (!verified) {
      await this.prisma.verificationPurchase.update({
        where: { id: purchase.id },
        data: { status: 'failed', flutterwaveTxId: result.transactionId },
      });
      throw new BadRequestException('Payment verification failed.');
    }

    const now = new Date();
    const columns = await this.loadColumns(wawuUserId);
    const current = deriveVerificationState(columns, now);
    const kind = purchase.kind;

    const currentUntil =
      kind === 'creator'
        ? (columns?.creatorVerifiedUntil ?? null)
        : (columns?.professionalVerifiedUntil ?? null);
    const base =
      current[kind].verified && currentUntil !== null && currentUntil > now
        ? currentUntil
        : now;
    const until = oneYearFrom(base);

    const currentAt =
      kind === 'creator'
        ? (columns?.creatorVerifiedAt ?? null)
        : (columns?.professionalVerifiedAt ?? null);
    // The grant date is when this tick was FIRST held, not when it was last
    // renewed. Overwriting it on every renewal would erase how long somebody
    // has been verified, which is the one thing the date is good for.
    const grantedAt = currentAt ?? now;

    await this.writeTick(wawuUserId, kind, grantedAt, until);

    // Conditional flip, same shape as the content unlock: two concurrent
    // verifies both read `pending` above, and only one may settle the row.
    await this.prisma.verificationPurchase.updateMany({
      where: { id: purchase.id, status: 'pending' },
      data: {
        status: 'completed',
        flutterwaveTxId: result.transactionId,
        grantedUntil: until,
        settledAt: now,
      },
    });

    return { kind, verification: await this.stateFor(wawuUserId) };
  }

  /**
   * An admin grant, with no payment behind it.
   *
   * `until = null` is a PERPETUAL tick, which is what the accounts
   * grandfathered off the old ladder carry. Pass a date for a comped annual
   * term instead.
   */
  async grant(
    wawuUserId: string,
    kind: VerificationKindValue,
    until: Date | null,
  ): Promise<VerificationState> {
    const profile = await this.prisma.userProfile.findUnique({
      where: { wawuUserId },
      select: { creatorVerifiedAt: true, professionalVerifiedAt: true },
    });
    if (!profile) {
      throw new NotFoundException(
        'That account has no profile on this service.',
      );
    }
    const existingAt =
      kind === 'creator'
        ? profile.creatorVerifiedAt
        : profile.professionalVerifiedAt;
    await this.writeTick(wawuUserId, kind, existingAt ?? new Date(), until);
    return this.stateFor(wawuUserId);
  }

  /**
   * Take a tick away.
   *
   * Both dates are cleared, which is the whole of the state and therefore the
   * whole of the revocation. Identity is written first, as on a grant: a tick
   * revoked here but still live at WAWU ID is the failure that matters, since
   * identity is what every other service asks.
   *
   * The VerificationPurchase rows are left alone. They are the record of a
   * payment that really happened, and a revocation does not un-happen it.
   */
  async revoke(
    wawuUserId: string,
    kind: VerificationKindValue,
  ): Promise<VerificationState> {
    const profile = await this.prisma.userProfile.findUnique({
      where: { wawuUserId },
      select: { wawuUserId: true },
    });
    if (!profile) {
      throw new NotFoundException(
        'That account has no profile on this service.',
      );
    }
    await this.writeTick(wawuUserId, kind, null, null);
    return this.stateFor(wawuUserId);
  }

  /**
   * WAWU ID first, this backend's mirror second. Every grant and revoke goes
   * through here so that ordering exists in exactly one place.
   */
  private async writeTick(
    wawuUserId: string,
    kind: VerificationKindValue,
    verifiedAt: Date | null,
    verifiedUntil: Date | null,
  ): Promise<void> {
    await this.wawuId.setVerification(wawuUserId, kind, {
      verifiedAt,
      verifiedUntil,
    });
    await this.prisma.userProfile.update({
      where: { wawuUserId },
      data:
        kind === 'creator'
          ? {
              creatorVerifiedAt: verifiedAt,
              creatorVerifiedUntil: verifiedUntil,
            }
          : {
              professionalVerifiedAt: verifiedAt,
              professionalVerifiedUntil: verifiedUntil,
            },
    });
  }

  /** What an account with no profile row on this service carries. */
  static none(): VerificationState {
    return unverified();
  }
}
