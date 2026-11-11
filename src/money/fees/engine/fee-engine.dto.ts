import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { FEE_CURRENCIES, FEE_KINDS, PROVIDER_RATE_KINDS } from './fee-kinds';

const MAX_MINOR = Number.MAX_SAFE_INTEGER;
const PERCENT = /^\d{1,3}(\.\d{1,4})?$/;

/** One row of WAWU's fee history. */
export class FeeRowDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: FEE_KINDS }) kind!: string;
  @ApiProperty({ enum: FEE_CURRENCIES }) currency!: string;
  @ApiProperty({ description: 'A decimal string such as "0.4".' })
  percent!: string;
  @ApiProperty({ type: 'integer' }) minMinor!: number;
  @ApiProperty({ type: 'integer', nullable: true }) maxMinor!: number | null;
  @ApiProperty() passThrough!: boolean;
  @ApiProperty({ description: 'ISO 8601.' }) startsAt!: string;
  @ApiProperty() changedBy!: string;
  @ApiProperty({ nullable: true }) note!: string | null;
  @ApiProperty({ description: 'ISO 8601.' }) createdAt!: string;
}

export class FeeKindViewDto {
  @ApiProperty({ enum: FEE_KINDS }) kind!: string;
  @ApiProperty({ enum: FEE_CURRENCIES }) currency!: string;
  @ApiProperty({ description: 'False while the product this fee prices is switched off.' })
  on!: boolean;
  @ApiProperty({ type: FeeRowDto, nullable: true }) current!: FeeRowDto | null;
  @ApiProperty({ type: [FeeRowDto], description: 'Newest first.' })
  history!: FeeRowDto[];
}

export class FeeKindsDto {
  @ApiProperty({ type: [FeeKindViewDto] }) kinds!: FeeKindViewDto[];
}

/** POST /admin/money/fees */
export class AddFeeDto {
  @ApiProperty({ enum: FEE_KINDS })
  @IsIn(FEE_KINDS)
  kind!: string;

  @ApiProperty({ enum: FEE_CURRENCIES })
  @IsIn(FEE_CURRENCIES)
  currency!: string;

  @ApiPropertyOptional({
    description:
      'A decimal string such as "0.4", up to four decimals, at most 100. Left out for a pass-through kind.',
  })
  @ValidateIf((o: AddFeeDto) => o.passThrough !== true)
  @IsString()
  @Matches(PERCENT, { message: 'percent must be a decimal string such as "0.4".' })
  percent?: string;

  @ApiPropertyOptional({ type: 'integer', minimum: 0 })
  @ValidateIf((o: AddFeeDto) => o.passThrough !== true)
  @IsInt()
  @Min(0)
  @Max(MAX_MINOR)
  minMinor?: number;

  @ApiPropertyOptional({ type: 'integer', nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_MINOR)
  maxMinor?: number | null;

  @ApiPropertyOptional({
    description: 'true for ngn_add_money (the provider\'s charge is passed on).',
  })
  @IsOptional()
  @IsBoolean()
  passThrough?: boolean;

  @ApiProperty({ description: 'ISO 8601. The fee applies from this time.' })
  @IsISO8601()
  startsAt!: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @Length(1, 500)
  note?: string;
}

/** GET /admin/money/fees/preview */
export class FeePreviewQueryDto {
  @ApiProperty({ enum: FEE_KINDS })
  @IsIn(FEE_KINDS)
  kind!: string;

  @ApiProperty({ enum: FEE_CURRENCIES })
  @IsIn(FEE_CURRENCIES)
  currency!: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && /^[0-9]{1,16}$/.test(value)
      ? Number(value)
      : value,
  )
  @ApiProperty({ type: 'integer' })
  @IsInt()
  @Min(1)
  @Max(MAX_MINOR)
  amountMinor!: number;
}

export class FeePreviewDto {
  @ApiProperty({ type: 'integer' }) feeMinor!: number;
  @ApiProperty({ type: 'integer' }) vatMinor!: number;
  @ApiProperty({ type: 'integer', description: 'What the person pays: the amount, the fee and VAT.' })
  totalMinor!: number;
  @ApiProperty({ type: 'integer', description: 'Exactly what the receiver gets.' })
  receiveMinor!: number;
  @ApiProperty() currency!: string;
}

export class ProviderRateRowDto {
  @ApiProperty() id!: string;
  @ApiProperty() provider!: string;
  @ApiProperty({ enum: PROVIDER_RATE_KINDS }) kind!: string;
  @ApiProperty() currency!: string;
  @ApiProperty({ description: 'A decimal string such as "0.2".' })
  percent!: string;
  @ApiProperty({ type: 'integer' }) minMinor!: number;
  @ApiProperty({ type: 'integer', nullable: true }) maxMinor!: number | null;
  @ApiProperty({ type: 'integer' }) fixedMinor!: number;
  @ApiProperty() startsAt!: string;
  @ApiProperty() changedBy!: string;
  @ApiProperty({ nullable: true }) note!: string | null;
  @ApiProperty() createdAt!: string;
}

export class ProviderRatesDto {
  @ApiProperty({ type: [ProviderRateRowDto] }) rates!: ProviderRateRowDto[];
}

/** POST /admin/money/provider-rates */
export class AddProviderRateDto {
  @ApiProperty({ example: 'nuvion' })
  @IsString()
  @Matches(/^[a-z][a-z0-9_]{1,31}$/)
  provider!: string;

  @ApiProperty({ enum: PROVIDER_RATE_KINDS })
  @IsIn(PROVIDER_RATE_KINDS)
  kind!: string;

  @ApiProperty()
  @IsString()
  @Matches(/^[A-Z]{3,5}$/)
  currency!: string;

  @ApiProperty()
  @IsString()
  @Matches(PERCENT, { message: 'percent must be a decimal string such as "0.2".' })
  percent!: string;

  @ApiProperty({ type: 'integer' })
  @IsInt()
  @Min(0)
  @Max(MAX_MINOR)
  minMinor!: number;

  @ApiProperty({ type: 'integer', nullable: true })
  @ValidateIf((o: AddProviderRateDto) => o.maxMinor !== null)
  @IsInt()
  @Min(0)
  @Max(MAX_MINOR)
  maxMinor!: number | null;

  @ApiProperty({ type: 'integer' })
  @IsInt()
  @Min(0)
  @Max(MAX_MINOR)
  fixedMinor!: number;

  @ApiProperty({ description: 'ISO 8601.' })
  @IsISO8601()
  startsAt!: string;

  @ApiPropertyOptional({ maxLength: 500, nullable: true })
  @IsOptional()
  @IsString()
  @Length(1, 500)
  note?: string | null;
}
