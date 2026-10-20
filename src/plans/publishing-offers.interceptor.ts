import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  UseInterceptors,
  applyDecorators,
} from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import type { Request } from 'express';
import { Observable, catchError, from, mergeMap, throwError } from 'rxjs';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { IdentityPausedErrorEnvelope } from './dto/identity-paused-error.dto';
import { TierGateErrorEnvelope } from './dto/tier-gate-error.dto';
import { limitOffers, tierRequiredOffers } from './limit-offers';
import { PlansService } from './plans.service';
import { PublishingAllowanceService } from './publishing-allowance.service';
import {
  TierGateError,
  type EndedTier,
  type TierGateOffers,
} from './tier-gate-error';

/**
 * Adds the offers to a `TierGateError` on its way out (TIER-02).
 *
 * The services that gate know the facts (the tier state, used and allowed);
 * only the route knows whose token asked, and the token decides the billing
 * currency (a person with no purchase yet is billed by their phone and
 * country, TIER-01). So the services throw the bare refusal and this fills in
 * the tiers and the extra products, from `PlansService`, the same figures
 * `GET /plans` answers. The error then goes on to the one global filter that
 * writes the envelope, so no route builds an error body by hand.
 *
 * If the offers cannot be built (the database is unreachable), the refusal
 * goes out without them rather than turning into a 500.
 */
@Injectable()
export class PublishingOffersInterceptor implements NestInterceptor {
  constructor(
    private readonly plans: PlansService,
    private readonly allowance: PublishingAllowanceService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((err: unknown) => {
        if (!(err instanceof TierGateError) || err.offers)
          return throwError(() => err);
        const user = context
          .switchToHttp()
          .getRequest<Request & { user?: WawuJwtClaims }>().user;
        if (!user) return throwError(() => err);
        return from(this.offersFor(user, err)).pipe(
          mergeMap((found) =>
            throwError(() =>
              found ? err.withOffers(found.offers, found.endedTier) : err,
            ),
          ),
        );
      }),
    );
  }

  private async offersFor(
    user: WawuJwtClaims,
    err: TierGateError,
  ): Promise<{ offers: TierGateOffers; endedTier: EndedTier | null } | null> {
    try {
      const [plan, allowance] = await Promise.all([
        this.plans.plansFor(user.sub, {
          phone: user.phone,
          country: user.country,
        }),
        this.allowance.of(user.sub),
      ]);
      // Both refusals offer only what would let another product go up: the
      // tiers that leave more places than the person has products published
      // (TIER-02 round 4, D7), which is every tier for someone with nothing
      // up and nothing for a person above every allowance. `tier_required`
      // never offers the extras (they need a tier first).
      const offers =
        err.code === 'tier_required'
          ? tierRequiredOffers(allowance, plan)
          : limitOffers(allowance, plan);
      // The tier that ended, named from the plan, so the `tier_required`
      // sentence says "Renew it" only when that tier is among the offers
      // (round 5, D8). Only the wording uses it, never the body.
      const endedTier: EndedTier | null =
        allowance.endedTierId === null
          ? null
          : {
              id: allowance.endedTierId,
              name:
                plan.tiers.find((t) => t.id === allowance.endedTierId)?.name ??
                null,
            };
      return { offers: { currency: plan.currency, ...offers }, endedTier };
    } catch {
      return null;
    }
  }
}

/**
 * On every route that publishes a piece of content or accepts a file for one:
 * the 402 answers carry the offers, and the contract documents the body.
 * `publishing-gate-coverage.spec.ts` lists the routes that carry it.
 *
 * The same routes answer 403 `identity_paused` while the person's identity
 * check is paused (S7 round 2, F3); it carries no offers.
 */
export function GatesPublishing(): MethodDecorator {
  return applyDecorators(
    UseInterceptors(PublishingOffersInterceptor),
    ApiResponse({
      status: 402,
      description: 'reason.code: tier_required, product_limit_reached',
      type: TierGateErrorEnvelope,
    }),
    ApiResponse({
      status: 403,
      description: 'reason.code: identity_paused',
      type: IdentityPausedErrorEnvelope,
    }),
  );
}
