import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { PROFESSIONAL_FIELD_IDS } from '../professional-fields';

/**
 * GET /professionals/directory: the mobile directory (P1, P4).
 *
 * `field` is one of GET /professionals/fields' ids. Without it the answer is
 * every approved, listed professional ("All").
 */
export class ListProfessionalDirectoryQueryDto {
  /** A field id from GET /professionals/fields, for example `accounting_tax`. */
  @IsOptional()
  @IsIn(PROFESSIONAL_FIELD_IDS)
  field?: string;

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
