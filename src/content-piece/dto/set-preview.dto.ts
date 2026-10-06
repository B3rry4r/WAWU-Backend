import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Technical sanity bounds, not business limits: they only keep a typo (a
 * million pages) from being stored. The real ceiling for each is the piece's
 * own size, checked in the service.
 */
export const MAX_FREE_PAGES = 10000;
export const MAX_FREE_SECONDS = 86400;
export const MAX_FREE_LESSONS = 1000;

/**
 * Body for PUT /content/:id/preview. The body IS the whole preview: a key
 * that is missing or null means "none of that", so `{}` clears it. Only the
 * key that matches the piece's type may carry a number (pages for a pdf,
 * seconds for a video or audio file, lessons for a course); the service
 * refuses the others.
 */
export class SetPreviewDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_FREE_PAGES)
  freePages?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_FREE_SECONDS)
  freeSeconds?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_FREE_LESSONS)
  freeLessons?: number | null;
}
