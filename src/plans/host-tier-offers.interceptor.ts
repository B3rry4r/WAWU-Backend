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
import { HostTierErrorEnvelope } from './dto/host-tier-error.dto';
import { HostTierRequiredError, type HostTierOffer } from './host-tier-error';
import { PlansService } from './plans.service';

/**
 * Adds the lowest tier to a `HostTierRequiredError` on its way out (EVENTS-12).
 *
 * The event service knows the person's tier state; only the route knows whose
 * token asked, and the token decides the billing currency (a person with no
 * purchase yet is billed by their phone and country, TIER-01). So the service
 * throws the bare refusal and this fills in the cheapest tier from
 * `PlansService`, the same figures `GET /plans` answers, in the person's
 * currency only. The error then goes on to the one global filter that writes
 * the envelope.
 *
 * If the plan cannot be read (the database is unreachable), the refusal goes
 * out without the offer rather than turning into a 500.
 */
@Injectable()
export class HostTierOffersInterceptor implements NestInterceptor {
  constructor(private readonly plans: PlansService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((err: unknown) => {
        if (!(err instanceof HostTierRequiredError) || err.offer)
          return throwError(() => err);
        const user = context
          .switchToHttp()
          .getRequest<Request & { user?: WawuJwtClaims }>().user;
        if (!user) return throwError(() => err);
        return from(this.offerFor(user)).pipe(
          mergeMap((offer) =>
            throwError(() => (offer ? err.withOffer(offer) : err)),
          ),
        );
      }),
    );
  }

  private async offerFor(user: WawuJwtClaims): Promise<HostTierOffer | null> {
    try {
      const plan = await this.plans.plansFor(user.sub, {
        phone: user.phone,
        country: user.country,
      });
      const lowest = plan.tiers.reduce<(typeof plan.tiers)[number] | null>(
        (best, t) =>
          best === null || t.priceMinor < best.priceMinor ? t : best,
        null,
      );
      return {
        currency: plan.currency,
        lowestTier: lowest
          ? { id: lowest.id, name: lowest.name, priceMinor: lowest.priceMinor }
          : null,
      };
    } catch {
      return null;
    }
  }
}

/**
 * On every route that hosts an event or changes an event's tickets: the 403
 * `tier_required` answer carries the lowest tier, and the contract documents
 * the body. `host-tier-coverage.spec.ts` lists the routes that carry it.
 *
 * The same routes still answer 403 `account_type_required` for an account
 * that is neither a creator nor a professional.
 */
export function GatesHosting(): MethodDecorator {
  return applyDecorators(
    UseInterceptors(HostTierOffersInterceptor),
    ApiResponse({
      status: 403,
      description: 'reason.code: tier_required, account_type_required',
      type: HostTierErrorEnvelope,
    }),
  );
}
