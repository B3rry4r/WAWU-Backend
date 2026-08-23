import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { PROFESSIONAL_CATEGORIES } from '../professional-categories';

export class ListProfessionalsQueryDto {
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
  @Max(50)
  perPage?: number;
}
