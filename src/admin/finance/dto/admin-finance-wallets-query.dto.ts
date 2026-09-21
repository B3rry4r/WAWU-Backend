import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ReviewStatus } from '../../../../generated/prisma/enums';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

/**
 * Accepts `?withBalances=true` and `?withBalances=1`, and nothing else as
 * true. An unrecognised value stays false rather than becoming truthy, so a
 * typo cannot quietly start a page of outbound calls to Flutterwave.
 */
const toBoolean = Transform(({ value }: { value: unknown }) => {
  if (typeof value === 'boolean') return value;
  const raw = String(value).trim().toLowerCase();
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return value;
});

/**
 * GET /admin/finance/wallets query.
 *
 * ── WHY LIVE BALANCES ARE OPT-IN ─────────────────────────────────────────
 * The balance is Flutterwave's and only Flutterwave's: it is fetched per
 * payout subaccount, one call each. A page of twenty rows is twenty outbound
 * calls, so a screen that only needs the lifetime figures and the KYC state
 * should not pay for them. `?withBalances=true` asks for them and caps the
 * page at BALANCE_PAGE_CAP rows.
 *
 * The alternative - summing the ledger and printing the result as "balance" -
 * is the one thing this surface is forbidden to do. So the field is null and
 * carries a reason instead, which is the honest answer.
 */
export const BALANCE_PAGE_CAP = 25;

export class AdminFinanceWalletsQueryDto extends PaginationQueryDto {
  /**
   * Matched against `handle` (partial, case-insensitive) and `wawuUserId`
   * (prefix). This backend stores no email or phone for a WAWU account -
   * both live in WAWU ID and are never persisted here - so neither can be
   * searched, the same limitation `/admin/creators` documents at length.
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  q?: string;

  /**
   * `CreatorState.kycStatus`, the gate that decides whether money may leave a
   * wallet.
   *
   * `not_started` is accepted alongside the three stored values because it is
   * what this surface REPORTS: the column defaults to `pending`, so a creator
   * who has never submitted and one waiting on a reviewer read identically
   * without the synthesis `CreatorStateService` and `/admin/creators` both
   * apply (hazard H-5). A filter that could not express the word the row
   * shows would be a filter that disagrees with its own list.
   */
  @IsOptional()
  @IsIn([...Object.values(ReviewStatus), 'not_started'])
  kycStatus?: ReviewStatus | 'not_started';

  /** True lists only creators Flutterwave has opened a payout subaccount for; false only those it has not. */
  @IsOptional()
  @toBoolean
  @IsBoolean()
  hasSubaccount?: boolean;

  /** Ask Flutterwave for each row's balance. See BALANCE_PAGE_CAP above. */
  @IsOptional()
  @toBoolean
  @IsBoolean()
  withBalances: boolean = false;

  @IsOptional()
  @IsIn(['newest', 'oldest', 'handle'])
  sort: 'newest' | 'oldest' | 'handle' = 'newest';
}

/** GET /admin/finance/wallets/:wawuId query. */
export class AdminFinanceWalletDetailQueryDto {
  /** How many ledger movements to return, newest first. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  historyLimit: number = 50;
}
