import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  Min,
} from 'class-validator';

/**
 * PROVISIONAL(PHOTO-SET-MAX-FRAMES, owner=YOU, why=no ruling or design names how many pictures a photo set may hold; H3 draws six)
 *
 * The most pictures one photo set may hold. A bound against abuse; the 400
 * message follows this number.
 */
export const MAX_FRAMES = 20;

/**
 * PROVISIONAL(PDF-MAX-PAGES, owner=YOU, why=no ruling or design names a longest PDF; H4 draws 84 pages)
 *
 * The most pages a PDF's page count may state. A sanity bound on input.
 */
export const MAX_PAGE_COUNT = 5000;

/** `4:12` or `1:20:05`: the length as a player writes it. */
export const DURATION_PATTERN = /^(\d{1,2}:)?[0-5]?\d:[0-5]\d$/;

/** Body for PUT /content/:id/media. Every field is optional; one is required. */
export class SetMediaDto {
  /**
   * The pictures of a photo set, in the order they are shown. Replaces the
   * whole list. Photo sets only (content type `image`).
   */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_FRAMES, {
    message: `a photo set holds at most ${MAX_FRAMES} pictures`,
  })
  @IsUrl({ require_tld: false }, { each: true })
  frames?: string[];

  /** How long a video, audio or course runs, as `4:12` or `1:20:05`. */
  @IsOptional()
  @IsString()
  @Matches(DURATION_PATTERN, {
    message: 'durationLabel must look like 4:12 or 1:20:05',
  })
  durationLabel?: string;

  /** How many pages a PDF has. PDFs only. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_COUNT)
  pageCount?: number;
}
