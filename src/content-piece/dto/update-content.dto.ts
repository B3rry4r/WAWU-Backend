import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { CATEGORY_IDS, type CategoryId } from '../../common/categories';

const ACCESS_TYPES = ['free', 'paid'] as const;

/**
 * PATCH /content/:id body. Every field is optional, spelled out rather than
 * derived with `PartialType` (`@nestjs/mapped-types` is not a dependency).
 *
 * `contentType`, `status` and every counter are ABSENT on purpose and cannot
 * be added: a creator choosing their own status would be the review gate
 * handed to the submitter, and the type of a piece is fixed when it is
 * uploaded. `forbidNonWhitelisted` rejects them with a 400.
 *
 * Replacing the file is `fullAsset` (and `previewAsset`): the same two
 * upload URLs POST /content takes.
 */
export class UpdateContentDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  description?: string;

  @IsOptional()
  @IsIn(CATEGORY_IDS, {
    message: `category must be one of: ${CATEGORY_IDS.join(', ')}`,
  })
  category?: CategoryId;

  /** Replaces the whole list, as on create (at most three). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @IsString({ each: true })
  specializations?: string[];

  /** Replaces the whole list, as on create (at most twenty). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsIn(ACCESS_TYPES)
  accessType?: (typeof ACCESS_TYPES)[number];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  price?: number;

  @IsOptional()
  @IsUrl({ require_tld: false })
  previewAsset?: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  fullAsset?: string;
}
