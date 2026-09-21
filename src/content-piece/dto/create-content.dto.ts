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

  /**
   * Specialization ids from the C1 taxonomy, e.g.
   * `photography.portrait-photographer`. What a buyer actually searches and
   * filters on; `category` above is the deprecated flat list it replaces.
   *
   * Optional and capped at three rather than required, deliberately:
   *  - optional, because every piece published before this column exists has
   *    none, and a required field would make those rows unrepublishable.
   *  - capped, because this drives search placement. A piece tagged with
   *    twenty specializations is tagged with none, and the cap belongs here
   *    as well as in the client: a client-side maximum is a suggestion.
   *
   * The ids are NOT validated against the taxonomy here. That list lives in
   * the web client and changes by deploy, so pinning a copy in this DTO would
   * create two lists that drift and reject valid input the day they diverge.
   * Shape is enforced; membership is the client's to get right.
   */
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
