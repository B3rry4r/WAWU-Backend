import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';
import {
  ADMIN_FINANCE_STREAMS,
  ADMIN_FINANCE_TX_STATUSES,
  type AdminFinanceStream,
  type AdminFinanceTxStatus,
} from '../admin-finance-view.type';
import { toStringArray } from './admin-finance-period-query.dto';
import { IsISO8601, Validate } from 'class-validator';
import { FinancePeriodIsOrderedConstraint } from './admin-finance-period-query.dto';

/** UUID in any version - ids in this data are not all v4 (fixtures and seeds use `...-0000-...` forms). */
const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /admin/finance/transactions query.
 *
 * Offset pagination inherited from the app's own PaginationQueryDto rather
 * than a second admin convention (conventions.md § Pagination). The global
 * ValidationPipe runs with `forbidNonWhitelisted`, so an undeclared filter is
 * a 400 rather than a filter that silently does nothing - which on a money
 * screen is the difference between "no transactions matched" and "your filter
 * was ignored and you are reading the wrong total".
 *
 * Both `stream` and `status` take a LIST, because the questions an operator
 * actually asks are "unlocks and tips together" and "everything that did not
 * settle", and a single-valued filter answers neither without three requests.
 */
export class AdminFinanceTransactionsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  @Validate(FinancePeriodIsOrderedConstraint)
  to?: string;

  /** Omitted means every stream. */
  @IsOptional()
  @toStringArray
  @IsIn(ADMIN_FINANCE_STREAMS, { each: true })
  stream?: AdminFinanceStream[];

  /**
   * Omitted means every status, INCLUDING the ones that are not revenue.
   * That is deliberate: a ledger that silently hid failed charges would make
   * "where did this charge go" unanswerable on the one screen built to
   * answer it. The summary endpoint is the one that counts only settled
   * money, and it says so on its own response.
   */
  @IsOptional()
  @toStringArray
  @IsIn(ADMIN_FINANCE_TX_STATUSES, { each: true })
  status?: AdminFinanceTxStatus[];

  /** Narrows to one creator's incoming money, across every stream. */
  @IsOptional()
  @IsString()
  @Matches(UUID_SHAPE, { message: 'creatorWawuId has to be a WAWU ID.' })
  @MaxLength(64)
  creatorWawuId?: string;

  @IsOptional()
  @IsIn(['newest', 'oldest'])
  sort: 'newest' | 'oldest' = 'newest';
}
