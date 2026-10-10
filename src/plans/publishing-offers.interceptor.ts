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
import { TierGateErrorEnvelope } from './dto/tier-gate-error.dto';
import { PlansService } from './plans.service';
import { PublishingAllowanceService } from './publishing-allowance.service';
import { TierGateError, type TierGateOffers } from './tier-gate-error';

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
          mergeMap((offers) =>
            throwError(() => (offers ? err.withOffers(offers) : err)),
          ),
        );
      }),
    );
  }

  private async offersFor(
    user: WawuJwtClaims,
    err: TierGateError,
  ): Promise<TierGateOffers | null> {
    try {
      const [plan, allowance] = await Promise.all([
        this.plans.plansFor(user.sub, {
          phone: user.phone,
          country: user.country,
        }),
        this.allowance.of(user.sub),
      ]);
      // A held tick that allows more than any tier leaves nothing to buy
      // that would add a product; so does a person with no running tier
      // asking for extras (they need a tier first).
      const byTier = allowance.basis === 'tier';
      return {
        currency: plan.currency,
        tiers:
          err.code === 'tier_required'
            ? plan.tiers
            : byTier
              ? plan.tiers.filter(
                  (t) => t.products > allowance.runningTierProducts,
                )
              : [],
        extraProducts: byTier ? plan.extraProducts : null,
      };
    } catch {
      return null;
    }
  }
}

/**
 * On every route that publishes a piece of content or accepts a file for one:
 * the 402 answers carry the offers, and the contract documents the body.
 * `publishing-gate-coverage.spec.ts` lists the routes that carry it.
 */
export function GatesPublishing(): MethodDecorator {
  return applyDecorators(
    UseInterceptors(PublishingOffersInterceptor),
    ApiResponse({
      status: 402,
      description: 'reason.code: tier_required, product_limit_reached',
      type: TierGateErrorEnvelope,
    }),
  );
}
