import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
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

  /**
   * UPLOAD-REST (R-118): "make my preview from the file I already have". For a piece that this edit leaves PAID and that has no
   * preview of its own yet (a free piece going to paid: its preview is its own file) and that sends no `previewAsset`, the Hub
   * makes the preview from the piece's stored full file exactly as `POST /content` does with the same flag: the first 30 seconds
   * of audio or video (a third of a file under 45 seconds), the first 3 pages of a PDF (the first page of a file under 6 pages),
   * the same of a course's first lesson, or a copy of the cover for a template or a course whose first lesson is not a video. It is
   * stored as the piece's preview, counted once in the creator's storage, and given back if the edit does not go through. A picture
   * is refused in words (it sends its own smaller copy as `previewAsset`). Left out, the edit reads exactly as it always did; sent on
   * a piece that already has a preview of its own, or that stays free, it does nothing.
   */
  @IsOptional()
  @IsBoolean()
  previewFromFile?: boolean;

  @IsOptional()
  @IsUrl({ require_tld: false })
  fullAsset?: string;

  /**
   * CONTENT-COVER (R-114): the key (or `fileUrl`) of a cover uploaded to the folder `content/cover`, which replaces the
   * old one (the old file is deleted); `null` takes the cover off. Left out, the cover stays as it is.
   */
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  coverAsset?: string | null;
}
