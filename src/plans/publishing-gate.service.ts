import { Injectable } from '@nestjs/common';
import {
  PublishingAllowanceService,
  type PublishingAllowance,
} from './publishing-allowance.service';
import {
  TierGateError,
  productLimitMessage,
  tierRequiredMessage,
} from './tier-gate-error';

/**
 * The publishing gate (TIER-02, R-43): "Publishing, or uploading any file,
 * needs an active tier, and published products never exceed the tier's
 * products plus any extra products bought."
 *
 * Every route that publishes a piece of content, or accepts a file for one,
 * asks here, so they cannot disagree. It refuses with a `TierGateError` (402,
 * `tier_required` or `product_limit_reached`); the route's
 * `PublishingOffersInterceptor` adds the offers.
 *
 * Nothing here moves or hides anything already published: an ended tier, or a
 * limit lowered by the end of a tick, only stops the NEXT publish or upload.
 */
@Injectable()
export class PublishingGate {
  constructor(private readonly allowance: PublishingAllowanceService) {}

  /**
   * A file may be accepted, or an edit that carries one: the person must be
   * able to publish at all (a running tier or a held tick). It does not ask
   * for room, because the piece being edited already has its place.
   */
  async assertMayUpload(wawuUserId: string): Promise<PublishingAllowance> {
    const allowance = await this.allowance.of(wawuUserId);
    if (allowance.basis === 'none') throw this.tierRequired(allowance);
    return allowance;
  }

  /**
   * One more product may be published (or a file for a new one accepted):
   * the person must be able to publish, and have a place free. The returned
   * allowance carries the number the claim in the caller's transaction is
   * made against, so the check and the claim read the same figure.
   */
  async assertRoomForProduct(wawuUserId: string): Promise<PublishingAllowance> {
    const allowance = await this.assertMayUpload(wawuUserId);
    if (allowance.productsUsed >= allowance.productsAllowed)
      throw this.limitReached(allowance);
    return allowance;
  }

  /**
   * The refusal for a claim that lost: the conditional update found no free
   * place (a second publish got there first, or the person was at the limit).
   * Re-reads, so the numbers in the answer are the ones that refused it.
   */
  async limitReachedFor(wawuUserId: string): Promise<TierGateError> {
    const allowance = await this.allowance.of(wawuUserId);
    return allowance.basis === 'none'
      ? this.tierRequired(allowance)
      : this.limitReached(allowance);
  }

  private tierRequired(allowance: PublishingAllowance): TierGateError {
    return new TierGateError(
      'tier_required',
      tierRequiredMessage(allowance.tierState),
      {
        tierState: allowance.tierState,
        productsUsed: allowance.productsUsed,
        productsAllowed: allowance.productsAllowed,
      },
    );
  }

  private limitReached(allowance: PublishingAllowance): TierGateError {
    return new TierGateError(
      'product_limit_reached',
      productLimitMessage(allowance.productsUsed, allowance.productsAllowed),
      {
        tierState: allowance.tierState,
        productsUsed: allowance.productsUsed,
        productsAllowed: allowance.productsAllowed,
      },
    );
  }
}
