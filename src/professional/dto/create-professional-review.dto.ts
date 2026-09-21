import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * POST /professionals/:id/reviews body.
 *
 * Bounded 1..5 here rather than by a CHECK constraint, so an out-of-range
 * value comes back as an explained 400 instead of a database error the API
 * cannot translate.
 *
 * There is no field for the average or the count, and there cannot be: both
 * are aggregated from these rows on read. A client able to post a rating
 * average could post any figure it wanted.
 */
export class CreateProfessionalReviewDto {
  @Type(() => Number)
  @IsInt()
  @Min(1, { message: 'a rating is between 1 and 5 stars.' })
  @Max(5, { message: 'a rating is between 1 and 5 stars.' })
  stars!: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  body?: string;
}
