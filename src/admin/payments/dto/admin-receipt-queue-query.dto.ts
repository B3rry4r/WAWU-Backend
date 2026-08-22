import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';
import { RECEIPT_STATUSES, type ReceiptStatus } from '../admin-payment-view.type';

/**
 * The `status` filter's accepted values: every real receipt status, plus one
 * alias.
 *
 * `unresolved` is the alias, and it is the reason this filter is not just an
 * enum: the README's reconciliation queue is three statuses at once
 * (`unmatched` | `rejected` | `failed`), and making the dashboard fetch three
 * pages and merge them client-side would produce a "queue" whose ordering and
 * total are both fiction.
 */
export const RECEIPT_STATUS_FILTERS = [...RECEIPT_STATUSES, 'unresolved'] as const;

export type ReceiptStatusFilter = ReceiptStatus | 'unresolved';

/**
 * GET /admin/payments/receipts query.
 *
 * Offset pagination, inherited from the app's own PaginationQueryDto rather
 * than a second admin convention (conventions.md § Pagination). The global
 * ValidationPipe runs with `forbidNonWhitelisted`, so every accepted field has
 * to be declared here or the request is a 400.
 */
export class AdminReceiptQueueQueryDto extends PaginationQueryDto {
  /**
   * Unfiltered by default: this endpoint is the payments SCREEN, not only the
   * error queue, and an operator reconciling a charge often needs to see that
   * it settled fine. `?status=unresolved` is the queue view.
   */
  @IsOptional()
  @IsIn(RECEIPT_STATUS_FILTERS)
  status?: ReceiptStatusFilter;

  /**
   * `tip`, `credit-purchase`, `subscription-subscribe`, `dm`, `cac`,
   * `bill-payment`, `health-subscription`, `legal-consultation`, … — written
   * by the settle path, so this is a free string rather than an enum. It is
   * null on every unmatched row by definition.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  flow?: string;

  /**
   * Partial, case-insensitive match on the tx_ref. What an operator has in
   * hand is usually a reference pasted out of the Flutterwave dashboard or a
   * support ticket, frequently truncated.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  txRef?: string;

  /**
   * Newest first is the default, and unlike a review queue that is the right
   * default here: a reconciliation screen is answering "what broke today",
   * not "who has waited longest". `oldest` exists for working a backlog down.
   */
  @IsOptional()
  @IsIn(['newest', 'oldest'])
  sort: 'newest' | 'oldest' = 'newest';
}
