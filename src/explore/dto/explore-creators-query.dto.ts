import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
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
