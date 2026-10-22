import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, Length } from 'class-validator';
import { PaginationQueryDto } from '../common/dto/pagination.dto';

export const MOVIE_SORTS = ['newest', 'rating', 'views', 'title'] as const;
export type MovieSort = (typeof MOVIE_SORTS)[number];

const readFlag = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

/** `GET /movies/browse`: the copy of the catalog, a page at a time. */
export class BrowseMoviesQueryDto extends PaginationQueryDto {
  /** Default `newest`. */
  @ApiPropertyOptional({ enum: MOVIE_SORTS })
  @IsOptional()
  @IsIn(MOVIE_SORTS, {
    message: 'sort must be newest, rating, views or title.',
  })
  sort?: MovieSort;

  /** Exact genre, one of `GET /movies/filters`. */
  @ApiPropertyOptional({ minLength: 1, maxLength: 60 })
  @IsOptional()
  @IsString({ message: 'genre must be text.' })
  @Length(1, 60, { message: 'genre must be 1 to 60 characters.' })
  genre?: string;

  /** Exact language, one of `GET /movies/filters`. */
  @ApiPropertyOptional({ minLength: 1, maxLength: 60 })
  @IsOptional()
  @IsString({ message: 'language must be text.' })
  @Length(1, 60, { message: 'language must be 1 to 60 characters.' })
  language?: string;

  /** True: only titles with a premiere still ahead. */
  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @Transform(readFlag)
  @IsBoolean({ message: 'premiering must be true or false.' })
  premiering?: boolean;
}

/** `GET /movies/search`: titles whose name, original name or tagline holds the text. */
export class SearchMoviesQueryDto extends PaginationQueryDto {
  @ApiProperty({ minLength: 1, maxLength: 80 })
  @IsString({ message: 'q must be text.' })
  @Length(1, 80, { message: 'Type 1 to 80 characters to search.' })
  q!: string;
}

/** `POST /movies/{movieId}/watch`. */
export class WatchMovieDto {
  /**
   * True when the person ticked the agreement on MV4. Stored (once) with its
   * time before the link is made. Ignored for a person who already agreed.
   */
  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @IsBoolean({ message: 'agreeToTerms must be true or false.' })
  agreeToTerms?: boolean;
}
