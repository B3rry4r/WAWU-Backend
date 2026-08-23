import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class ListCreatorsQueryDto {
  /**
   * Matched against `UserProfile.interests`, case-insensitively.
   *
   * `interests` is the only thing on a profile that describes what a creator
   * does, so it is what this filters on. Be aware the app currently puts three
   * different vocabularies in play — the 25 explore category ids
   * (`agriculture_food`), the profile editor's own eight tags ("Agriculture"),
   * and free-text from the seed ("beauty") — so a filtered list is only as
   * good as the agreement between them.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
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
  @Max(50)
  perPage?: number;
}
