import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { CATEGORY_IDS, type CategoryId } from '../../common/categories';

const CONTENT_TYPES = [
  'video',
  'course',
  'audio',
  'pdf',
  'image',
  'template',
] as const;
const ACCESS_TYPES = ['free', 'paid'] as const;

/**
 * Body for POST /product-drafts (TIER-02, VF2): a product being drafted. It
 * carries no file, because a draft with no file is free; only the title is
 * required so a draft always has a name to show. Every other field may be
 * filled in later with PATCH, and publishing asks for the rest. The limits
 * are the same as POST /content's.
 */
export class CreateProductDraftDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/, { message: 'title must not be blank' })
  @MaxLength(200)
  title: string;

  @IsOptional()
  @IsIn(CONTENT_TYPES)
  contentType?: (typeof CONTENT_TYPES)[number];

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

  /** At most three, as on POST /content. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @IsString({ each: true })
  specializations?: string[];

  /** At most twenty, as on POST /content. */
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
}

/**
 * Body for PATCH /product-drafts/:id. Every field is optional and an omitted
 * field is unchanged; a list sent replaces the whole list.
 */
export class UpdateProductDraftDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/, { message: 'title must not be blank' })
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsIn(CONTENT_TYPES)
  contentType?: (typeof CONTENT_TYPES)[number];

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

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @IsString({ each: true })
  specializations?: string[];

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
}

/**
 * Body for POST /product-drafts/:id/publish: the two uploaded files, as
 * POST /content takes them (links from POST /uploads/presign). Publishing
 * needs a running tier and a free place.
 */
export class PublishProductDraftDto {
  @IsUrl({ require_tld: false })
  previewAsset: string;

  @IsUrl({ require_tld: false })
  fullAsset: string;
}
