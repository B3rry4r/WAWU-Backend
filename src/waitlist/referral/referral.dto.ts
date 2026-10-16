import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { INT4_MAX } from '../../plans/plans-config';
import { REFERRAL_COMMUNITY_MAX } from '../waitlist-config';

/** POST /admin/waitlist/referral-codes. */
export class CreateReferralCodeDto {
  /** 3 to 20 letters and digits. Stored in upper case; matched in any case. */
  @IsString()
  @MaxLength(60)
  code!: string;

  /** The community the code is for: the label the owner tracks by. */
  @IsString()
  @MinLength(1)
  @MaxLength(REFERRAL_COMMUNITY_MAX)
  community!: string;

  /** What a person using the code pays, in whole kobo: 0 (free) up to the offer's price. */
  @ApiProperty({ type: 'integer' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(INT4_MAX)
  priceKobo!: number;

  /** How many people may use the code. Leave out, or null, for no limit. */
  @ApiPropertyOptional({ type: 'integer', nullable: true })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(INT4_MAX)
  limit?: number | null;

  /** Whether the code works. Defaults to true. */
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

/**
 * PATCH /admin/waitlist/referral-codes/{id}. Any of the four; what is left out
 * stays. The code itself never changes. A change affects only registrations
 * started after it.
 */
export class UpdateReferralCodeDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(REFERRAL_COMMUNITY_MAX)
  community?: string;

  @ApiPropertyOptional({ type: 'integer' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(INT4_MAX)
  priceKobo?: number;

  /** A number, or null to remove the limit. */
  @ApiPropertyOptional({ type: 'integer', nullable: true })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(INT4_MAX)
  limit?: number | null;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
