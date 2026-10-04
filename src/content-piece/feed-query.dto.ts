import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import type { ContentSort } from './ranking';

/** Query for GET /feed. */
export class FeedQueryDto {
  /** `for_you` is the ranked browse; `following` is only people you follow. */
  @IsOptional()
  @IsIn(['for_you', 'following'])
  scope: 'for_you' | 'following' = 'for_you';

  @IsOptional()
  @IsString()
  category?: string;

  /** Ordering of `for_you`. `following` is always newest first. */
  @IsOptional()
  @IsIn(['trending', 'recent', 'top'])
  sort: ContentSort = 'trending';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  perPage: number = 20;
}
