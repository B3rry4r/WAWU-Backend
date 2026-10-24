import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** A provider id as it is put in a path or a query: letters, digits, - and _. */
const PROVIDER_ID = /^[A-Za-z0-9_-]{1,64}$/;

export class CapitalProductsQueryDto {
  /** `fixed_return` or `share_offering`; omitted lists both. */
  @IsOptional()
  @IsIn(['fixed_return', 'share_offering'])
  kind?: 'fixed_return' | 'share_offering';

  /** The `nextCursor` of the last page. */
  @IsOptional()
  @IsString()
  @Matches(PROVIDER_ID)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

export class CapitalOrdersQueryDto {
  /** `open` lists reserved and confirming orders and holdings; `done` the ones that ended. Omitted lists all. */
  @IsOptional()
  @IsIn(['holding', 'ended'])
  show?: 'holding' | 'ended';

  @IsOptional()
  @IsString()
  @Matches(PROVIDER_ID)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

export class CapitalTransactionsQueryDto {
  @IsOptional()
  @IsString()
  @Matches(PROVIDER_ID)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

/** Reserves a product for a few minutes. Nothing is taken until the PIN confirms it. */
export class CapitalReserveDto {
  /** The product's id, from the product list. */
  @IsString()
  @Matches(PROVIDER_ID)
  productId!: string;

  /** Kobo to invest: the principal of a fixed return, or the spend on a share offering. */
  @IsInt()
  @Min(1)
  @Max(1_000_000_000_000)
  amountKobo!: number;

  /** Fixed return only: true locks the money for the whole term (no early exit). Omitted is false. */
  @IsOptional()
  @IsBoolean()
  lockInvestment?: boolean;

  /** The person has opened and agreed to every document of the product. Must be true. */
  @IsBoolean()
  agreedToDocuments!: boolean;
}

export class CapitalAdminListQueryDto {
  @IsOptional()
  @IsIn([
    'reserved',
    'confirming',
    'confirmed',
    'expired',
    'rejected',
    'cancelled',
    'failed',
  ])
  state?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  wawuUserId?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,80}$/)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class CapitalAdminActDto {
  /** Why, in the admin's words. Kept with the audit row. */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}
