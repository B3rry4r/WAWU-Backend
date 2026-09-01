import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { CreatorTier } from '../../../generated/prisma/enums';

export class ValidateReferralQueryDto {
  @IsString()
  @MinLength(3)
  @MaxLength(40)
  code!: string;
}

export class CreateReferralCodeDto {
  /**
   * Letters, digits, dash and underscore only.
   *
   * These are printed in blog posts and typed by hand, so anything that needs
   * escaping in a URL or reads ambiguously in print is not worth allowing.
   */
  @IsString()
  @MinLength(3)
  @MaxLength(40)
  @Matches(/^[A-Za-z0-9_-]+$/, {
    message: 'A code may only contain letters, numbers, dashes and underscores.',
  })
  code!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  label!: string;

  /**
   * 0 is deliberately allowed. A code that takes nothing off is how a creator
   * is let through while public signup is closed, at the normal price.
   */
  @IsInt()
  @Min(0)
  @Max(100)
  discountPercent!: number;

  @IsEnum(CreatorTier)
  tier!: CreatorTier;

  /** Null / omitted means unlimited. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxUses?: number;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}

export class UpdateReferralCodeDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  label?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  discountPercent?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxUses?: number;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}

export class UserSignupDto {
  @IsBoolean()
  userSignupEnabled!: boolean;
}
