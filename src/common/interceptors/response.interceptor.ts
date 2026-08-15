import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, map } from 'rxjs';

export interface Paginated<T> {
  items: T[];
  currentPage: number;
  perPage: number;
  total: number;
}

function isPaginated<T>(value: unknown): value is Paginated<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as Paginated<T>).items) &&
    typeof (value as Paginated<T>).total === 'number'
  );
}

/**
 * Wraps every successful controller return value in the canonical envelope
 * (conventions.md § Error envelope / § Pagination). A controller method
 * returns either a plain value/array, or a Paginated<T> shape from a
 * paginated service call — this interceptor is the ONLY place that decides
 * which wire shape results.
 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, unknown> {
  intercept(_context: ExecutionContext, next: CallHandler<T>): Observable<unknown> {
    return next.handle().pipe(
      map((result) => {
        if (isPaginated(result)) {
          const { items, currentPage, perPage, total } = result as Paginated<unknown>;
          const nextPage = currentPage * perPage < total ? currentPage + 1 : null;
          return {
            statusCode: 200,
            message: 'OK',
            data: items,
            pagination: { currentPage, nextPage, perPage, total },
          };
        }
        return { statusCode: 200, message: 'OK', data: result ?? null };
      }),
    );
  }
}
