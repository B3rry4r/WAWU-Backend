/**
 * Shared wire shapes used across every resource's endpoints
 * (registry.json § sharedShapes). Every controller returns a plain value or
 * array — ResponseInterceptor (src/common/interceptors/response.interceptor.ts)
 * is the ONLY place that wraps it into these envelopes at runtime. These
 * types describe what actually reaches the client after that wrapping.
 */

/** conventions.md § Pagination. */
export interface PaginationMeta {
  currentPage: number;
  nextPage: number | null;
  perPage: number;
  total: number;
}

/** Wire shape of every paginated list endpoint. */
export interface PaginatedListResponse<T> {
  statusCode: 200;
  message: string;
  data: T[];
  pagination: PaginationMeta;
}

/** conventions.md § Error envelope. Produced by AllExceptionsFilter. */
export interface ErrorEnvelope {
  statusCode: number;
  message: string;
  data: null;
}

/** Wire shape of every non-paginated success response. */
export interface SuccessEnvelope<T> {
  statusCode: number;
  message: string;
  data: T;
}
