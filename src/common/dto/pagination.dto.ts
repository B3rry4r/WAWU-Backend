import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import type { Paginated } from '../interceptors/response.interceptor';

/**
 * Upper bounds for offset pagination. `page` was previously unbounded, so
 * `?page=1e8` turned into a two-billion-row OFFSET — Postgres still walks
 * every skipped row, so one request could pin a core.
 */
export const MAX_PAGE = 1000;
export const MAX_PER_PAGE = 100;
export const DEFAULT_PER_PAGE = 20;

/** conventions.md § Pagination — offset-based, page/perPage query params. */
export class PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PER_PAGE)
  perPage: number = DEFAULT_PER_PAGE;
}

/**
 * Same bounds, but with NO defaults — so a handler can tell "caller asked
 * for page 1" apart from "caller passed no paging at all".
 *
 * Used by the list endpoints that shipped unpaginated and are already being
 * called by the frontend (`/services`, `/services/mentors`, `/learn/courses`,
 * `/learn/guides`, `/verification/submissions`). Those stay backwards
 * compatible: with neither param present they return the full array exactly
 * as before, and only when `page` or `perPage` is supplied do they switch to
 * the standard `Paginated<T>` shape (which the ResponseInterceptor renders
 * as the same `data: [...]` array plus a `pagination` block).
 */
export class OptionalPaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PER_PAGE)
  perPage?: number;
}

/** True when the caller explicitly asked for a page of results. */
export function wantsPagination(query: OptionalPaginationQueryDto): boolean {
  return query.page !== undefined || query.perPage !== undefined;
}

/**
 * Slices an already-materialised array into the canonical `Paginated<T>`
 * envelope. Used only by the reference/catalog endpoints above, whose rows
 * are small fixed tables (partner services, mentors, courses, guides) or a
 * single user's own submissions — pushing `skip`/`take` down into Prisma
 * for those means editing their services, which is tracked separately.
 */
export function paginateArray<T>(
  items: T[],
  query: OptionalPaginationQueryDto,
): Paginated<T> {
  const page = query.page ?? 1;
  const perPage = query.perPage ?? DEFAULT_PER_PAGE;
  const start = (page - 1) * perPage;
  return {
    items: items.slice(start, start + perPage),
    currentPage: page,
    perPage,
    total: items.length,
  };
}
