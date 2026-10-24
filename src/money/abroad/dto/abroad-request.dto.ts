import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import type { AbroadMethod, AbroadSendStatus } from '../abroad-view.type';

export const ABROAD_STATUSES: AbroadSendStatus[] = [
  'sending',
  'pending',
  'completed',
  'failed',
  'reversed',
  'cancelled',
  'needs_review',
];

/** Saves a recipient abroad: the country, the way it arrives, and the fields that country and way ask. */
export class AbroadRecipientDto {
  /** ISO 3166-1 alpha-2, from `GET /money/abroad/corridors`. */
  @ApiProperty({ minLength: 2, maxLength: 2 })
  @IsString()
  @Matches(/^[A-Z]{2}$/)
  country!: string;

  @ApiProperty({ enum: ['bank', 'mobile_money'] })
  @IsIn(['bank', 'mobile_money'])
  method!: AbroadMethod;

  /** The scheme the person picked when the rail has several; omitted when it has one. */
  @ApiPropertyOptional({ maxLength: 30 })
  @IsOptional()
  @IsString()
  @Length(1, 30)
  scheme?: string;

  /** The name on the account, as it is written there. */
  @ApiProperty({ minLength: 2, maxLength: 100 })
  @IsString()
  @Length(2, 100)
  holderName!: string;

  /** The scheme's fields, by key (`GET /money/abroad/corridors`). Any other key is refused. */
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } })
  @IsObject()
  fields!: Record<string, string>;
}

export class AbroadQuoteDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  recipientId!: string;

  /** The account to send from: `NGN` or a currency from `GET /money/abroad/sources`. */
  @ApiProperty({ minLength: 3, maxLength: 4 })
  @IsString()
  @Matches(/^[A-Z]{3,4}$/)
  fromCurrency!: string;

  /** The amount, in the smallest unit of the currency `side` names. */
  @ApiProperty({ type: 'integer', minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  amountMinor!: number;

  /** `send`: the amount leaves the account; `receive`: the recipient gets exactly it. */
  @ApiPropertyOptional({ enum: ['send', 'receive'], default: 'send' })
  @IsOptional()
  @IsIn(['send', 'receive'])
  side?: 'send' | 'receive';
}

export class AbroadSendDto {
  /** A quote from `POST /money/abroad/quotes`, used once, before it expires. */
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  quoteId!: string;

  /** What the recipient's statement may show, up to 100 characters. */
  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  narration?: string;
}

export class AbroadPageQueryDto {
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

export class AdminAbroadSendsQueryDto extends AbroadPageQueryDto {
  @ApiPropertyOptional({ description: "One person's WAWU id." })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  wawuUserId?: string;

  @ApiPropertyOptional({ enum: ABROAD_STATUSES })
  @IsOptional()
  @IsIn(ABROAD_STATUSES)
  status?: AbroadSendStatus;

  @ApiPropertyOptional({
    description:
      '`true`: only sends whose fee question is open (a fee not taken yet, a give-back owed to the person, or one held for a person), so finance finds what to settle.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' || value === '1'
      ? true
      : value === 'false' || value === '0'
        ? false
        : value,
  )
  @IsBoolean()
  feeOpen?: boolean;
}

export class AdminAbroadReasonDto {
  /** Why, in a few plain words; kept on the audit row. */
  @ApiProperty({ minLength: 3, maxLength: 200 })
  @IsString()
  @Length(3, 200)
  reason!: string;
}

export const ABROAD_FEE_OUTCOMES = ['not_taken', 'paid_back'] as const;
export type AbroadFeeOutcome = (typeof ABROAD_FEE_OUTCOMES)[number];

/** What finance settles about WAWU's fee on one send, and why. */
export class AdminAbroadSettleFeeDto {
  /**
   * `not_taken`: WAWU writes off a fee it never took. `paid_back`: the fee was taken from a send that did not stand and the person
   * has been paid back (the provider's record, or outside the system with the reason said).
   */
  @ApiProperty({ enum: ABROAD_FEE_OUTCOMES })
  @IsIn(ABROAD_FEE_OUTCOMES)
  outcome!: AbroadFeeOutcome;

  /** Why, in a few plain words; kept on the audit row. */
  @ApiProperty({ minLength: 3, maxLength: 200 })
  @IsString()
  @Length(3, 200)
  reason!: string;
}
