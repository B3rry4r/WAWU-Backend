import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { Observable, from, mergeMap } from 'rxjs';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { WaitlistAutoClaimService } from './waitlist-auto-claim.service';

/**
 * Runs the automatic claim of a paid /join registration before a signed-in
 * tier read answers (`GET /me/tier`, `GET /me/tier-offer`), so the answer
 * already carries the tier the person paid for. It never fails the read: the
 * service swallows and logs its own errors. Added to a route's answer shape
 * and contract by nothing: the routes are unchanged to the app.
 */
@Injectable()
export class WaitlistAutoClaimInterceptor implements NestInterceptor {
  constructor(private readonly auto: WaitlistAutoClaimService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const user = context
      .switchToHttp()
      .getRequest<Request & { user?: WawuJwtClaims }>().user;
    if (!user || typeof user.sub !== 'string') return next.handle();
    return from(this.auto.run(user)).pipe(mergeMap(() => next.handle()));
  }
}
