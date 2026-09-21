import { IsIn, IsISO8601, IsOptional, Validate } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';
import { WalletEntryStatus } from '../../../../generated/prisma/enums';
import { FinancePeriodIsOrderedConstraint } from './admin-finance-period-query.dto';

/**
 * GET /admin/finance/payouts query.
 *
 * The period bounds the WITHDRAWAL LIST only. The `owed` block on the same
 * response is a running figure over the whole life of the platform, because
 * "what is owed but unpaid" does not belong to a month - money earned in
 * March and still unpaid in September is owed in September.
 */
export class AdminFinancePayoutsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  @Validate(FinancePeriodIsOrderedConstraint)
  to?: string;

  /** `WalletLedgerEntry.status`. Omitted means every status. */
  @IsOptional()
  @IsIn(Object.values(WalletEntryStatus))
  status?: WalletEntryStatus;

  @IsOptional()
  @IsIn(['newest', 'oldest'])
  sort: 'newest' | 'oldest' = 'newest';
}
