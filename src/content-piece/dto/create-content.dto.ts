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
  IsUUID,
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

  /**
   * The public preview file, as `POST /uploads/presign` answered. PREVIEW-AUTO: optional now. A FREE piece may leave it out (its whole
   * file is open to everyone, so the preview is the file itself); a PAID audio or video piece may leave it out and send
   * `previewFromFile: true` to have the Hub make it from `fullAsset` (R-118: a PDF too; a course from its first lesson, a template or
   * a course whose first lesson is not a video from `coverAsset`). A picture sends its own smaller copy. A request that carries one is
   * read exactly as it always was.
   */
  @IsOptional()
  @IsUrl({ require_tld: false })
  previewAsset?: string;

  /**
   * PREVIEW-AUTO: "make my preview from the full file". For a PAID audio, video, PDF, course, or template that sends no
   * `previewAsset`: the Hub cuts the first 30 seconds of a recording (a third of a file under 45 seconds), the first 3 pages of a PDF
   * (the first page of a file under 6 pages), the first lesson of a course the same way, or copies the cover (a template, or a course
   * whose first lesson is not a video), after the full file is stored, and stores the result as the piece's preview. Ignored when a
   * `previewAsset` is sent, and for a free piece.
   */
  @IsOptional()
  @IsBoolean()
  previewFromFile?: boolean;

  @IsUrl({ require_tld: false })
  fullAsset: string;

  /**
   * CONTENT-COVER (R-114): the piece's optional cover picture, as the `key` (or `fileUrl`) `POST /uploads/presign`
   * answered for the folder `content/cover` (png, jpeg or webp, at most 5 MB). Left out, the piece has no cover.
   * It must be the caller's own upload (400 otherwise).
   */
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  coverAsset?: string;

  /**
   * FIX-111 (H24): the creator's own course this piece comes from ("From the course VFX for Beginners"). Optional, and only for a
   * piece that is not itself a course; the course must be the creator's, live or in review. Stored on the piece's side row.
   */
  @IsOptional()
  @IsUUID()
  parentCourseId?: string;
}
