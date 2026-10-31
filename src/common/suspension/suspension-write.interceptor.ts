import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { Observable, from, mergeMap } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import {
  isSuspended,
  suspendedRefusal,
  writeAllowedWhileSuspended,
} from './user-suspension';

/**
 * USER-SUSPEND (R-121). The write guard: a signed-in person who is suspended cannot write, except the few writes in
 * `WRITES_ALLOWED_WHILE_SUSPENDED`. They get one clear refusal in words (403, `reason.code` `account_suspended`).
 *
 * It is a global interceptor, not a guard, because a global guard runs before the route's own auth guard has put the
 * person on the request; an interceptor runs after every guard, so `request.user` is there. A request with no person
 * on it (a webhook, a public read, an admin call: admins sign in on their own guard and have no `request.user`) is
 * untouched, and so is every read.
 *
 * For everyone who is not suspended this adds one indexed read to a write and changes no answer.
 */
@Injectable()
export class SuspensionWriteInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: { sub?: string } }>();
    const who = request.user?.sub;
    if (!who) return next.handle();
    const route = (request.route as { path?: string } | undefined)?.path;
    if (writeAllowedWhileSuspended(request.method, route ?? request.path)) {
      return next.handle();
    }
    return from(isSuspended(this.prisma, who)).pipe(
      mergeMap((suspended) => {
        if (suspended) throw suspendedRefusal();
        return next.handle();
      }),
    );
  }
}
