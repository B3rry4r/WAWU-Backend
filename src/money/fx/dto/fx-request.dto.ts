import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import {
  FX_CHAINS,
  FX_COIN_CODES,
  FX_CURRENCY_CODES,
  FX_QUOTE_CODES,
  type FxChain,
  type FxCoinCode,
  type FxCurrencyCode,
  type FxQuoteCode,
} from '../fx-currencies';

/**
 * Request bodies and queries of the foreign-currency contract (WALLET-21).
 * Amounts are an integer in the smallest unit of the currency beside them
 * (CONVENTIONS.md, "Amounts that are not naira"); the largest the contract
 * takes is what a JSON number holds exactly.
 */
const MAX_MINOR = Number.MAX_SAFE_INTEGER;

export class OpenFxAccountDto {
  @ApiProperty({ enum: FX_CURRENCY_CODES })
  @IsIn(FX_CURRENCY_CODES)
  currency!: FxCurrencyCode;

  /**
   * A stablecoin account holds one chain's wallet address, so a stablecoin
   * needs its chain (USDT and USDC: eth, base, matic or sol; RLUSD: eth). A
   * fiat currency takes none.
   */
  @ApiPropertyOptional({ enum: FX_CHAINS })
  @IsOptional()
  @IsIn(FX_CHAINS)
  chain?: FxChain;
}

export class FxQuoteDto {
  @ApiProperty({
    enum: FX_QUOTE_CODES,
    description: 'NGN is the naira wallet.',
  })
  @IsIn(FX_QUOTE_CODES)
  fromCurrency!: FxQuoteCode;

  @ApiProperty({ enum: FX_QUOTE_CODES })
  @IsIn(FX_QUOTE_CODES)
  toCurrency!: FxQuoteCode;

  /** The account to debit; left out when `fromCurrency` is NGN. */
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  fromAccountId?: string;

  /** The account to credit; left out when `toCurrency` is NGN. */
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  toAccountId?: string;

  /** What to convert, in the smallest unit of `fromCurrency` (kobo for NGN). Send this or `amountToMinor`. */
  @ApiPropertyOptional({ type: 'integer', minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_MINOR)
  amountFromMinor?: number;

  /** What to receive, in the smallest unit of `toCurrency` (kobo for NGN). Send this or `amountFromMinor`. */
  @ApiPropertyOptional({ type: 'integer', minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_MINOR)
  amountToMinor?: number;
}

export class FxSwapDto {
  @ApiProperty({ format: 'uuid', description: 'The id of a quote still held.' })
  @IsUUID()
  quoteId!: string;
}

export class FxSendQuoteQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  accountId!: string;

  /** The account's currency; the amount below is in its smallest unit. Must be the account's. */
  @ApiProperty({ enum: FX_COIN_CODES })
  @IsIn(FX_COIN_CODES)
  currency!: FxCoinCode;

  @ApiProperty({ enum: FX_CHAINS })
  @IsIn(FX_CHAINS)
  chain!: FxChain;

  @ApiProperty({ type: 'integer', minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_MINOR)
  amountMinor!: number;
}

export class FxSendDto {
  @ApiProperty({
    format: 'uuid',
    description: 'The stablecoin account to send from.',
  })
  @IsUUID()
  accountId!: string;

  /** The account's currency; `amountMinor` is in its smallest unit. Must be the account's. */
  @ApiProperty({ enum: FX_COIN_CODES })
  @IsIn(FX_COIN_CODES)
  currency!: FxCoinCode;

  /** Must be the chain of the account and of the address. */
  @ApiProperty({ enum: FX_CHAINS })
  @IsIn(FX_CHAINS)
  chain!: FxChain;

  @ApiProperty({ minLength: 20, maxLength: 64 })
  @IsString()
  @Length(20, 64)
  @Matches(/^[A-Za-z0-9]+$/, {
    message: 'address must be letters and digits only',
  })
  address!: string;

  @ApiProperty({ type: 'integer', minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_MINOR)
  amountMinor!: number;
}

export class FxPageQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 200)
  cursor?: string;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: 50,
    default: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

export class AdminFxOperationsQueryDto extends FxPageQueryDto {
  @ApiPropertyOptional({ description: "One person's WAWU id." })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  wawuUserId?: string;

  @ApiPropertyOptional({ enum: ['swap', 'send'] })
  @IsOptional()
  @IsIn(['swap', 'send'])
  kind?: 'swap' | 'send';

  @ApiPropertyOptional({ enum: ['pending', 'completed', 'failed'] })
  @IsOptional()
  @IsIn(['pending', 'completed', 'failed'])
  status?: 'pending' | 'completed' | 'failed';
}

export class AdminFxFreezeDto {
  /** Why, in a few plain words; kept on the audit row. */
  @ApiProperty({ minLength: 3, maxLength: 200 })
  @IsString()
  @Length(3, 200)
  reason!: string;
}
