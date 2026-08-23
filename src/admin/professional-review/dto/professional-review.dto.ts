import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PROFESSIONAL_CATEGORIES } from '../../../professional/professional-categories';

export const PROFESSIONAL_QUEUE_STATUSES = [
  'pending',
  'approved',
  'rejected',
] as const;

export class AdminProfessionalQueueQueryDto {
  /** Defaults to `pending` — the only slice that needs a human. */
  @IsOptional()
  @IsIn(PROFESSIONAL_QUEUE_STATUSES)
  status?: (typeof PROFESSIONAL_QUEUE_STATUSES)[number];

  @IsOptional()
  @IsIn(PROFESSIONAL_CATEGORIES)
  category?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  perPage?: number;
}

export class RejectProfessionalDto {
  /**
   * Required, and required to be substantial. The applicant sees this and has
   * to be able to act on it — "rejected" on its own turns a review into a
   * dead end and generates a support ticket instead of a resubmission.
   */
  @IsString()
  @MinLength(15)
  @MaxLength(600)
  reason!: string;
}
