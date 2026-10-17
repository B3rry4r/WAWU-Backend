import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { BILL_CATEGORIES, type BillCategory } from '../money/dto/money-enums';

const MAX_EXACT_KOBO = Number.MAX_SAFE_INTEGER;

const withoutSpaces = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.replace(/[\s-]/g, '') : value;

/**
 * POST /bills/wallet: start a bill. What each category needs:
 *
 * - `electricity`: `code` (a company from `GET /bills/electricity/billers`),
 *   `accountNumber` (the meter) and `amountKobo`;
 * - `airtime`: `code` (MTN, GLO, AIRTEL or 9MOBILE), `accountNumber` (the
 *   phone) and `amountKobo` (whole naira, at least 10000);
 * - `data`: `code` (the network), `accountNumber` (the phone) and
 *   `productCode` (a bundle of that network);
 * - `cable`: `code` (GOTV or DSTV), `accountNumber` (the smartcard) and
 *   `productCode` (a plan of that provider).
 *
 * A data or cable amount is never sent: the price is Fintava's own for the
 * bundle or plan. A field the category does not use is a 400.
 */
export class CreateWalletBillDto {
  @ApiProperty({ enum: BILL_CATEGORIES })
  @IsIn(BILL_CATEGORIES)
  category!: BillCategory;

  /** The company, network or cable provider. */
  @ApiProperty({ pattern: '^[A-Za-z0-9_]{1,80}$' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Za-z0-9_]{1,80}$/, {
    message: 'code is not a valid biller code',
  })
  code!: string;

  /** The meter, phone or smartcard number: digits, spaces and dashes taken out first. */
  @ApiProperty({ pattern: '^[0-9]{5,20}$' })
  @Transform(withoutSpaces)
  @IsString()
  @Matches(/^[0-9]{5,20}$/, {
    message: 'accountNumber must be digits only, 5 to 20 of them',
  })
  accountNumber!: string;

  /** Electricity and airtime only. */
  @ApiPropertyOptional({ type: 'integer' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_EXACT_KOBO)
  amountKobo?: number;

  /** Data and cable only: the bundle or plan code from the biller's list. */
  @ApiPropertyOptional({ pattern: '^[A-Za-z0-9_.-]{1,80}$' })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_.-]{1,80}$/, {
    message: 'productCode is not a valid code',
  })
  productCode?: string;
}

/** GET /bills/wallet/{id}/quote and every read of one bill take the id in the path. */

/**
 * POST /bills/wallet/pay. Headers: Idempotency-Key, X-Transaction-Pin. The bill
 * is in the body, not the path, so the key's fingerprint covers which bill it
 * pays.
 */
export class PayWalletBillDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  billId!: string;

  /** `payment.totalKobo` from the quote the person saw. A different server total is `quote_changed`. */
  @ApiProperty({ type: 'integer' })
  @IsInt()
  @Min(1)
  @Max(MAX_EXACT_KOBO)
  expectedTotalKobo!: number;

  /** `payment.quoteToken` from that quote. */
  @ApiProperty()
  @IsString()
  @Length(1, 1024)
  quoteToken!: string;
}
