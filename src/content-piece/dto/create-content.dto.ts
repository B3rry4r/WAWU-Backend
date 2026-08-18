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

const CONTENT_TYPES = [
  'video',
  'course',
  'audio',
  'pdf',
  'image',
  'template',
] as const;
const ACCESS_TYPES = ['free', 'paid'] as const;

/** Body for POST /content per registry.json ContentPiece contract. */
export class CreateContentDto {
  @IsIn(CONTENT_TYPES)
  contentType: (typeof CONTENT_TYPES)[number];

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  description: string;

  /**
   * Must be one of the 25 taxonomy ids (src/common/categories.ts). A free
   * string here let content be filed under a category no browse surface
   * lists, which made it unreachable.
   */
  @IsIn(CATEGORY_IDS as unknown as string[], {
    message: `category must be one of: ${CATEGORY_IDS.join(', ')}`,
  })
  category: CategoryId;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  tags?: string[];

  @IsIn(ACCESS_TYPES)
  accessType: (typeof ACCESS_TYPES)[number];

  @IsInt()
  @Min(0)
  @Max(10_000_000)
  price: number;

  @IsUrl({ require_tld: false })
  previewAsset: string;

  @IsUrl({ require_tld: false })
  fullAsset: string;
}
