import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/** Query for GET /content per registry.json ContentPiece contract. */
export class ListContentQueryDto {
  @IsOptional()
  @IsIn(['feed', 'mine'])
  scope?: 'feed' | 'mine';

  @IsOptional()
  @IsString()
  category?: string;

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
