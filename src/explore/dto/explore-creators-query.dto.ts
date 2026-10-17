import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import { EXPLORE_CATEGORY_IDS } from '../explore-categories';

/** GET /explore/creators. Every field is exact; anything else is a 400. */
export class ExploreCreatorsQueryDto {
  /** One of the ids from GET /explore/categories. */
  @IsOptional()
  @IsIn(EXPLORE_CATEGORY_IDS)
  category?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  perPage?: number;
}

/** GET /explore/featured-creators. */
export class FeaturedCreatorsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  limit?: number;
}

/** GET /explore/suggested-creators (AUTH-06). */
export class SuggestedCreatorsQueryDto {
  /**
   * The categories a person picked, as ids from GET /explore/categories, comma
   * separated (`music_audio,film_video`) or repeated. Left out, it is every
   * creator Explore may show.
   */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    (Array.isArray(value) ? value : [value])
      .flatMap((v: unknown) => String(v).split(','))
      .map((v: string) => v.trim())
      .filter((v: string) => v !== ''),
  )
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(EXPLORE_CATEGORY_IDS.length)
  @IsIn(EXPLORE_CATEGORY_IDS, { each: true })
  interests?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  limit?: number;
}
