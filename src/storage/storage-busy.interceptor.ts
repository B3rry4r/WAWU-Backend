import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Response } from 'express';
import { Observable, catchError, throwError } from 'rxjs';
import { StorageBusyException } from './storage-lock';

/**
 * Adds the `Retry-After` header to the 429 a person gets when they already
 * have storage requests running and waiting (`StorageBusyException`, see
 * storage-lock.ts). The exception carries the seconds; a filter cannot be
 * changed for one route (src/common is fenced), so the route's interceptor
 * sets the header on the way out and lets the same exception go on. Nothing
 * else is touched.
 */
@Injectable()
export class StorageBusyInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((err: unknown) => {
        if (err instanceof StorageBusyException) {
          context
            .switchToHttp()
            .getResponse<Response>()
            .set('Retry-After', String(err.retryAfterSeconds));
        }
        return throwError(() => err);
      }),
    );
  }
}
