import type { ContentSort } from '../ranking';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/** Query for GET /content per registry.json ContentPiece contract. */
export class ListContentQueryDto {
  @IsOptional()
  @IsIn(['feed', 'mine', 'following'])
  scope?: 'feed' | 'mine' | 'following';

  @IsOptional()
  @IsString()
  category?: string;

  /**
   * Browse ordering. Defaults to `trending` (engagement decayed by age) —
   * plain reverse-chronological is a publication log, not a feed. `recent`
   * keeps the old behaviour for anyone who wants it, `top` drops the decay.
   */
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
